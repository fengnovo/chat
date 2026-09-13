import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@repo/contracts';

const MAX_CITATIONS = 50;
const boundedCitations = (value: unknown) => Array.isArray(value) ? value.slice(0, MAX_CITATIONS).map((x) => {
  if (!x || typeof x !== 'object') return x;
  const copy = { ...(x as Record<string, unknown>) };
  delete copy.passage;
  return copy;
}) : [];

export interface KnowledgeEmbeddingProfile {
  key: string;
  model: string;
  dimension: number;
  collectionName: string;
}

export class ForbiddenKnowledgeError extends Error {
  statusCode = 403;
  constructor(message = 'Knowledge base access denied') {
    super(message);
    this.name = 'ForbiddenKnowledgeError';
  }
}

export interface KnowledgeRepositoryOptions {
  embeddingProfile?: KnowledgeEmbeddingProfile;
}

export class KnowledgeRepository {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly options: KnowledgeRepositoryOptions = {},
  ) {}
  private readonly leases = new Map<string, string>();

  // 可读/可用于 RAG：tenant 可见 OR 我是 owner OR 被授权 OR admin。
  private static readable(target: string, meParam: number, tenantParam: number, rolesParam: number): string {
    return `(visibility = 'tenant' OR owner_user_id = $${meParam} OR EXISTS (SELECT 1 FROM knowledge_base_grants g WHERE g.kb_id = ${target} AND g.user_id = $${meParam} AND g.tenant_id = $${tenantParam}) OR $${rolesParam}::text[] && ARRAY['admin']::text[])`;
  }

  // 可写：我是 owner OR admin（全局角色 owner 不再获得他人库写权限）。
  private static writable(meParam: number, rolesParam: number): string {
    return `(owner_user_id = $${meParam} OR $${rolesParam}::text[] && ARRAY['admin']::text[])`;
  }

  async listKnowledgeBases(auth: AuthContext): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT k.*,
        (SELECT count(*) FROM knowledge_documents d WHERE d.kb_id = k.id AND d.deleted_at IS NULL)::int AS document_count,
        (SELECT count(*) FROM knowledge_chunks c WHERE c.kb_id = k.id)::int AS chunk_count
       FROM knowledge_bases k
       WHERE k.tenant_id = $1 AND k.deleted_at IS NULL AND ${KnowledgeRepository.readable('k.id', 2, 1, 3)}
       ORDER BY k.updated_at DESC, k.created_at DESC`,
      [auth.tenantId, auth.userId, auth.roles],
    );
    return result.rows;
  }

  async getKnowledgeBase(auth: AuthContext, id: string): Promise<any | null> {
    const result = await this.pool.query(`SELECT * FROM knowledge_bases WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND ${KnowledgeRepository.readable('knowledge_bases.id', 3, 1, 4)}`, [auth.tenantId, id, auth.userId, auth.roles]);
    return result.rows[0] ?? null;
  }

  async canWriteKnowledgeBase(auth: AuthContext, id: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM knowledge_bases WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL AND ${KnowledgeRepository.writable(3, 4)}`, [auth.tenantId, id, auth.userId, auth.roles]);
    return (result.rowCount ?? 0) > 0;
  }

  async createKnowledgeBase(auth: AuthContext, input: any): Promise<any> {
    if (!auth.roles.includes('owner') && !auth.roles.includes('admin')) {
      throw new ForbiddenKnowledgeError();
    }
    const profile = input.embeddingProfile ?? this.options.embeddingProfile;
    if (!profile) throw new Error('Knowledge embedding profile is required');
    const result = await this.pool.query(`INSERT INTO knowledge_bases (id, tenant_id, owner_user_id, name, description, visibility, embedding_profile_key, embedding_model, embedding_dim, collection_name, chunk_size, chunk_overlap, top_k, max_hops, graph_enabled, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,800,100,10,2,true,'ready') RETURNING *`, [input.id ?? randomUUID(), auth.tenantId, auth.userId, input.name, input.description ?? null, input.visibility ?? 'private', profile.key, profile.model, profile.dimension, profile.collectionName]);
    return result.rows[0];
  }

  async updateKnowledgeBase(
    auth: AuthContext,
    id: string,
    input: { name?: string | undefined; description?: string | null | undefined; visibility?: 'private' | 'tenant' | undefined },
  ): Promise<any | null> {
    const existing = await this.pool.query(
      `SELECT * FROM knowledge_bases WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND ${KnowledgeRepository.writable(3, 4)}`,
      [auth.tenantId, id, auth.userId, auth.roles],
    );
    if (!existing.rows[0]) return null;
    // 可见性会影响租户内访问范围，仅允许 owner 本人或 admin 调整。
    const canChangeVisibility =
      existing.rows[0].owner_user_id === auth.userId || auth.roles.includes('admin');
    const visibility = canChangeVisibility ? input.visibility : undefined;
    const result = await this.pool.query(
      `UPDATE knowledge_bases SET
         name = COALESCE($3, name),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         visibility = COALESCE($6, visibility),
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        auth.tenantId,
        id,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        visibility ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  async deleteKnowledgeBase(auth: AuthContext, id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE knowledge_bases SET deleted_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND ${KnowledgeRepository.writable(3, 4)}`, [auth.tenantId, id, auth.userId, auth.roles]);
    return (result.rowCount ?? 0) > 0;
  }

  async listKnowledgeDocuments(auth: AuthContext, kbId: string): Promise<any[]> {
    const result = await this.pool.query(`SELECT d.* FROM knowledge_documents d JOIN knowledge_bases k ON k.id = d.kb_id WHERE d.tenant_id = $1 AND d.kb_id = $2 AND d.deleted_at IS NULL AND k.deleted_at IS NULL AND ${KnowledgeRepository.readable('k.id', 3, 1, 4)} ORDER BY d.created_at DESC`, [auth.tenantId, kbId, auth.userId, auth.roles]);
    return result.rows;
  }

  async getKnowledgeDocument(auth: AuthContext, kbId: string, id: string): Promise<any | null> {
    const result = await this.pool.query(`SELECT d.* FROM knowledge_documents d JOIN knowledge_bases k ON k.id = d.kb_id WHERE d.tenant_id = $1 AND d.kb_id = $2 AND d.id = $3 AND d.deleted_at IS NULL AND k.deleted_at IS NULL AND ${KnowledgeRepository.readable('k.id', 4, 1, 5)}`, [auth.tenantId, kbId, id, auth.userId, auth.roles]);
    return result.rows[0] ?? null;
  }

  async renameKnowledgeDocument(auth: AuthContext, kbId: string, id: string, name: string): Promise<any | null> {
    const result = await this.pool.query(
      `UPDATE knowledge_documents d SET name = $4, updated_at = now()
       FROM knowledge_bases k
       WHERE d.tenant_id = $1 AND d.kb_id = $2 AND d.id = $3 AND d.deleted_at IS NULL
         AND k.id = d.kb_id AND k.deleted_at IS NULL AND ${KnowledgeRepository.writable(5, 6)}
       RETURNING d.*`,
      [auth.tenantId, kbId, id, name, auth.userId, auth.roles],
    );
    return result.rows[0] ?? null;
  }

  async listDocumentChunks(
    auth: AuthContext,
    kbId: string,
    documentId: string,
    options: { search?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<{ rows: any[]; total: number }> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);
    const hasSearch = Boolean(options.search?.trim());
    const result = await this.pool.query(
      `SELECT c.id, c.kb_id, c.document_id, c.ordinal, c.text, c.token_count, c.heading, c.metadata, c.created_at, d.name AS document_name
       FROM knowledge_chunks c
       JOIN knowledge_bases k ON k.id = c.kb_id
       JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.tenant_id = $1 AND c.kb_id = $2 AND c.document_id = $3
         AND k.deleted_at IS NULL AND d.deleted_at IS NULL
         AND ${KnowledgeRepository.readable('k.id', 4, 1, 5)}
         AND ($6::text IS NULL OR c.text ILIKE ('%' || $6 || '%') OR c.id::text ILIKE ('%' || $6 || '%'))
       ORDER BY c.ordinal ASC
       LIMIT $7 OFFSET $8`,
      [auth.tenantId, kbId, documentId, auth.userId, auth.roles, hasSearch ? options.search!.trim() : null, limit, offset],
    );
    const countResult = await this.pool.query(
      `SELECT count(*)::int AS total
       FROM knowledge_chunks c
       JOIN knowledge_bases k ON k.id = c.kb_id
       JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.tenant_id = $1 AND c.kb_id = $2 AND c.document_id = $3
         AND k.deleted_at IS NULL AND d.deleted_at IS NULL
         AND ${KnowledgeRepository.readable('k.id', 4, 1, 5)}
         AND ($6::text IS NULL OR c.text ILIKE ('%' || $6 || '%') OR c.id::text ILIKE ('%' || $6 || '%'))`,
      [auth.tenantId, kbId, documentId, auth.userId, auth.roles, hasSearch ? options.search!.trim() : null],
    );
    return { rows: result.rows, total: countResult.rows[0]?.total ?? 0 };
  }

  async createDocumentUpload(auth: AuthContext, input: any): Promise<any | null> {
    const kb = await this.pool.query(`SELECT id FROM knowledge_bases WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL AND ${KnowledgeRepository.writable(3, 4)}`, [auth.tenantId, input.kbId, auth.userId, auth.roles]);
    if (!kb.rows[0]) return null;
    const result = await this.pool.query(`INSERT INTO knowledge_documents (id,kb_id,tenant_id,name,mime,size_bytes,content_hash,object_key,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`, [input.documentId ?? randomUUID(), input.kbId, auth.tenantId, input.name, input.mime, input.sizeBytes, input.sha256, input.objectKey]);
    return result.rows[0];
  }

  async confirmDocumentUpload(auth: AuthContext, kbId: string, id: string, input: any): Promise<{ document: any; job: any; created: boolean } | null> {
    const client: any = 'connect' in this.pool ? await (this.pool as any).connect() : this.pool;
    try {
      await client.query('BEGIN');
      const doc = await client.query(`SELECT d.* FROM knowledge_documents d JOIN knowledge_bases k ON k.id=d.kb_id WHERE d.tenant_id=$1 AND d.kb_id=$2 AND d.id=$3 AND d.deleted_at IS NULL AND k.deleted_at IS NULL AND (k.owner_user_id=$4 OR $5::text[] && ARRAY['admin']::text[]) FOR UPDATE`, [auth.tenantId, kbId, id, auth.userId, auth.roles]);
      if (!doc.rows[0]) { await client.query('ROLLBACK'); return null; }
      const existing = await client.query(`SELECT * FROM knowledge_index_jobs WHERE tenant_id=$1 AND document_id=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [auth.tenantId, id]);
      if (existing.rows[0]) { await client.query('COMMIT'); return { document: doc.rows[0], job: existing.rows[0], created: false }; }
      const updated = await client.query(`UPDATE knowledge_documents SET status='queued', size_bytes=$4, content_hash=$5, updated_at=now() WHERE tenant_id=$1 AND kb_id=$2 AND id=$3 RETURNING *`, [auth.tenantId, kbId, id, input.sizeBytes, input.sha256]);
      const job = await client.query(`INSERT INTO knowledge_index_jobs (id,kb_id,tenant_id,document_id,kind,status) VALUES ($1,$2,$3,$4,'index','queued') RETURNING *`, [randomUUID(), kbId, auth.tenantId, id]);
      await client.query('COMMIT');
      return { document: updated.rows[0], job: job.rows[0], created: true };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { if (client.release) client.release(); }
  }

  async deleteKnowledgeDocument(auth: AuthContext, kbId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE knowledge_documents d SET deleted_at=now(), updated_at=now() FROM knowledge_bases k WHERE d.tenant_id=$1 AND d.kb_id=$2 AND d.id=$3 AND k.id=d.kb_id AND (k.owner_user_id=$4 OR $5::text[] && ARRAY['admin']::text[]) AND d.deleted_at IS NULL`, [auth.tenantId, kbId, id, auth.userId, auth.roles]);
    return (result.rowCount ?? 0) > 0;
  }

  async listQueuedOrStaleIndexJobs(now: Date, limit: number): Promise<any[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit');
    const result = await this.pool.query(
      `SELECT * FROM knowledge_index_jobs WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < $1) ORDER BY created_at ASC LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  }

  async claimIndexJob(tenantId: string, jobId: string, leaseMs: number): Promise<{ jobId: string; leaseToken: string } | null> {
    const leaseToken = randomUUID();
    const result = await this.pool.query(`UPDATE knowledge_index_jobs SET status = 'running', error_code = $4, attempts = attempts + 1, lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), started_at = COALESCE(started_at, now()), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now())) RETURNING id`, [tenantId, jobId, leaseMs, leaseToken]);
    if (!(result.rowCount ?? 0)) return null;
    this.leases.set(`${tenantId}:${jobId}`, leaseToken);
    return { jobId, leaseToken };
  }

  private ownsLease(tenantId: string, jobId: string, token: string): boolean { return this.leases.get(`${tenantId}:${jobId}`) === token; }
  async markIndexStage(tenantId: string, jobId: string, token: string, stage: string): Promise<boolean> {
    if (!this.ownsLease(tenantId, jobId, token)) return false;
    const result = await this.pool.query(`UPDATE knowledge_index_jobs SET status = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND error_code = $3 AND lease_expires_at > now()`, [jobId, tenantId, token, stage]);
    return (result.rowCount ?? 0) > 0;
  }
  async completeIndexJob(tenantId: string, jobId: string, token: string, chunkCount = 0): Promise<boolean> {
    if (!this.ownsLease(tenantId, jobId, token)) return false;
    const result = await this.pool.query(`WITH updated AS (UPDATE knowledge_index_jobs SET status = 'completed', progress = 100, finished_at = now(), lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND error_code = $3 AND lease_expires_at > now() RETURNING document_id) UPDATE knowledge_documents d SET status = 'ready', chunk_count = $4, indexed_at = now(), updated_at = now() FROM updated WHERE d.id = updated.document_id AND d.tenant_id = $2 RETURNING d.id`, [jobId, tenantId, token, chunkCount]);
    return (result.rowCount ?? 0) > 0;
  }
  async failIndexJob(tenantId: string, jobId: string, token: string, error: unknown): Promise<boolean> {
    if (!this.ownsLease(tenantId, jobId, token)) return false;
    const message = error instanceof Error ? error.message : String(error);
    const result = await this.pool.query(`WITH updated AS (UPDATE knowledge_index_jobs SET status = 'failed', error_code = 'index_failed', error_message = $4, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND error_code = $3 AND lease_expires_at > now() RETURNING document_id) UPDATE knowledge_documents d SET status = 'failed', error_code = 'index_failed', error_message = $4, updated_at = now() FROM updated WHERE d.id = updated.document_id AND d.tenant_id = $2 RETURNING d.id`, [jobId, tenantId, token, message]);
    return (result.rowCount ?? 0) > 0;
  }
  async getDocumentForIndex(tenantId: string, kbId: string, documentId: string): Promise<any> {
    const result = await this.pool.query(`SELECT * FROM knowledge_documents WHERE tenant_id = $1 AND kb_id = $2 AND id = $3 AND deleted_at IS NULL`, [tenantId, kbId, documentId]);
    return result.rows[0] ?? null;
  }
  async getKnowledgeBaseForIndex(tenantId: string, kbId: string): Promise<any> {
    const result = await this.pool.query(`SELECT * FROM knowledge_bases WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tenantId, kbId]);
    return result.rows[0] ?? null;
  }
  async replaceDocumentGraph(tenantId: string, kbId: string, documentId: string, graph: any): Promise<void> {
    const client: any = 'connect' in this.pool ? await (this.pool as any).connect() : this.pool;
    try {
      if (client.query) {
        await client.query('BEGIN');
        await client.query(`DELETE FROM graph_relationships WHERE tenant_id = $1 AND kb_id = $2 AND document_id = $3`, [tenantId, kbId, documentId]);
        await client.query(`DELETE FROM graph_entities WHERE tenant_id = $1 AND kb_id = $2 AND document_id = $3`, [tenantId, kbId, documentId]);
        for (const entity of graph.entities ?? []) await client.query(`INSERT INTO graph_entities (id, tenant_id, kb_id, document_id, entity_key, name, type, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (kb_id, document_id, entity_key) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type`, [tenantId, kbId, documentId, entity.key ?? entity.name.toLowerCase(), entity.name, entity.type ?? 'entity', entity.chunkIds ?? []]);
        for (const relationship of graph.relationships ?? []) await client.query(`INSERT INTO graph_relationships (id, tenant_id, kb_id, document_id, source_key, target_key, relation, description, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`, [tenantId, kbId, documentId, relationship.sourceKey ?? relationship.source, relationship.targetKey ?? relationship.target, relationship.relation ?? relationship.type, relationship.description ?? null, relationship.chunkIds ?? []]);
        await client.query('COMMIT');
      }
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { if (client.release) client.release(); }
  }
  async replaceDocumentChunks(tenantId: string, kbId: string, documentId: string, chunks: any[]): Promise<void> {
    await this.pool.query(`DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND kb_id = $2 AND document_id = $3`, [tenantId, kbId, documentId]);
    for (const chunk of chunks) await this.pool.query(`INSERT INTO knowledge_chunks (id, tenant_id, kb_id, document_id, ordinal, text, token_count, heading, metadata, vector_point_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (document_id, ordinal) DO UPDATE SET text = EXCLUDED.text, token_count = EXCLUDED.token_count, metadata = EXCLUDED.metadata, vector_point_id = EXCLUDED.vector_point_id`, [chunk.id, tenantId, kbId, documentId, chunk.ordinal, chunk.text, chunk.tokenCount ?? chunk.text.length, chunk.heading ?? null, JSON.stringify(chunk.metadata ?? {}), chunk.vectorPointId ?? chunk.id]);
  }
  async appendRetrievalLog(input: any): Promise<void> {
    const citations = boundedCitations(input.citations);
    await this.pool.query(`INSERT INTO knowledge_retrieval_logs (id, retrieval_id, tenant_id, user_id, session_id, run_id, kb_ids, query, top_k, max_hops, result_count, rerank_status, citations, latency_ms, status) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [input.retrievalId, input.tenantId, input.userId, input.sessionId, input.runId, input.kbIds, input.query, input.topK, input.maxHops, input.resultCount, input.rerankStatus, JSON.stringify(citations), input.latencyMs, input.status]);
  }
}
