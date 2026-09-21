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
  private readonly captionLeases = new Map<string, string>();

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
    const directory = typeof input.directory === 'string' ? input.directory : '';
    // (kb_id, content_hash) 上有 partial unique 索引（009）：同一 kb 内重复导入同一文件时复用已有文档，
    // 并按已有 object_key 重新预签名，避免唯一约束冲突冒泡成 500（与 createAssetUpload 保持一致）。
    const result = await this.pool.query(`INSERT INTO knowledge_documents (id,kb_id,tenant_id,name,mime,size_bytes,content_hash,object_key,status,directory) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) ON CONFLICT (kb_id, content_hash) WHERE deleted_at IS NULL DO NOTHING RETURNING *`, [input.documentId ?? randomUUID(), input.kbId, auth.tenantId, input.name, input.mime, input.sizeBytes, input.sha256, input.objectKey, directory]);
    if (result.rows[0]) return result.rows[0];
    const existing = await this.pool.query(`SELECT * FROM knowledge_documents WHERE kb_id=$1 AND content_hash=$2 AND deleted_at IS NULL LIMIT 1`, [input.kbId, input.sha256]);
    return existing.rows[0] ?? null;
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

  // ─────────────────────────────────────────────────────────────────────────
  // 知识库资源（图片等非可索引资产）
  // ─────────────────────────────────────────────────────────────────────────

  async createAssetUpload(auth: AuthContext, input: {
    kbId: string;
    assetId?: string | undefined;
    documentId?: string | null | undefined;
    relPath: string;
    name: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    objectKey: string;
  }): Promise<any | null> {
    const kb = await this.pool.query(`SELECT id FROM knowledge_bases WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL AND ${KnowledgeRepository.writable(3, 4)}`, [auth.tenantId, input.kbId, auth.userId, auth.roles]);
    if (!kb.rows[0]) return null;
    // (kb_id, content_hash) 上有 partial unique 索引（016），同一 kb 内相同图片只保留一条记录：
    // 重复导入同一目录时复用已有资源并按其 object_key 重新预签名，避免唯一约束冲突冒泡成 500。
    const result = await this.pool.query(
      `INSERT INTO knowledge_assets (id, tenant_id, kb_id, document_id, rel_path, name, mime, size_bytes, content_hash, object_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (kb_id, content_hash) WHERE deleted_at IS NULL DO NOTHING
       RETURNING *`,
      [input.assetId ?? randomUUID(), auth.tenantId, input.kbId, input.documentId ?? null, input.relPath, input.name, input.mime, input.sizeBytes, input.sha256, input.objectKey],
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.pool.query(
      `SELECT * FROM knowledge_assets WHERE kb_id=$1 AND content_hash=$2 AND deleted_at IS NULL LIMIT 1`,
      [input.kbId, input.sha256],
    );
    return existing.rows[0] ?? null;
  }

  /**
   * 资源不像文档需要入索引队列，confirm 直接在同事务里把对象存在性校验完，再写 caption/metadata 字段。
   * 若文档已存在且 document_id 提供，则把资源挂到该文档；否则保持 document_id 为 NULL，等文档索引完成后回填。
   */
  async confirmAssetUpload(auth: AuthContext, kbId: string, id: string, input: { sizeBytes: number; sha256: string; metadata?: Record<string, unknown> | undefined }): Promise<{ asset: any } | null> {
    const client: any = 'connect' in this.pool ? await (this.pool as any).connect() : this.pool;
    try {
      await client.query('BEGIN');
      const row = await client.query(
        `SELECT a.* FROM knowledge_assets a
         JOIN knowledge_bases k ON k.id = a.kb_id
         WHERE a.tenant_id=$1 AND a.kb_id=$2 AND a.id=$3 AND a.deleted_at IS NULL
           AND k.deleted_at IS NULL AND ${KnowledgeRepository.writable(4, 5)}
         FOR UPDATE`,
        [auth.tenantId, kbId, id, auth.userId, auth.roles],
      );
      if (!row.rows[0]) { await client.query('ROLLBACK'); return null; }
      const updated = await client.query(
        `UPDATE knowledge_assets SET size_bytes=$4, content_hash=$5, metadata = COALESCE($6::jsonb, metadata), updated_at = now()
         WHERE tenant_id=$1 AND kb_id=$2 AND id=$3 RETURNING *`,
        [auth.tenantId, kbId, id, input.sizeBytes, input.sha256, input.metadata ? JSON.stringify(input.metadata) : null],
      );
      await client.query('COMMIT');
      return { asset: updated.rows[0] };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { if (client.release) client.release(); }
  }

  async getKnowledgeAsset(auth: AuthContext, kbId: string, id: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT a.* FROM knowledge_assets a
       JOIN knowledge_bases k ON k.id = a.kb_id
       WHERE a.tenant_id=$1 AND a.kb_id=$2 AND a.id=$3 AND a.deleted_at IS NULL
         AND k.deleted_at IS NULL AND ${KnowledgeRepository.readable('k.id', 4, 1, 5)}`,
      [auth.tenantId, kbId, id, auth.userId, auth.roles],
    );
    return result.rows[0] ?? null;
  }

  /** 按 document_id 列出资源；documentId 传 undefined 列出整个 kb 的资源。 */
  async listKnowledgeAssets(auth: AuthContext, kbId: string, options: { documentId?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}): Promise<any[]> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);
    if (options.documentId) {
      const result = await this.pool.query(
        `SELECT a.* FROM knowledge_assets a
         JOIN knowledge_bases k ON k.id = a.kb_id
         WHERE a.tenant_id=$1 AND a.kb_id=$2 AND a.document_id=$3 AND a.deleted_at IS NULL
           AND k.deleted_at IS NULL AND ${KnowledgeRepository.readable('k.id', 4, 1, 5)}
         ORDER BY a.rel_path ASC LIMIT $6 OFFSET $7`,
        [auth.tenantId, kbId, options.documentId, auth.userId, auth.roles, limit, offset],
      );
      return result.rows;
    }
    const result = await this.pool.query(
      `SELECT a.* FROM knowledge_assets a
       JOIN knowledge_bases k ON k.id = a.kb_id
       WHERE a.tenant_id=$1 AND a.kb_id=$2 AND a.deleted_at IS NULL
         AND k.deleted_at IS NULL AND ${KnowledgeRepository.readable('k.id', 3, 1, 4)}
       ORDER BY a.created_at DESC LIMIT $5 OFFSET $6`,
      [auth.tenantId, kbId, auth.userId, auth.roles, limit, offset],
    );
    return result.rows;
  }

  async deleteKnowledgeAsset(auth: AuthContext, kbId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE knowledge_assets a SET deleted_at=now(), updated_at=now()
       FROM knowledge_bases k
       WHERE a.tenant_id=$1 AND a.kb_id=$2 AND a.id=$3 AND a.deleted_at IS NULL
         AND k.id = a.kb_id AND k.deleted_at IS NULL AND ${KnowledgeRepository.writable(4, 5)}`,
      [auth.tenantId, kbId, id, auth.userId, auth.roles],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 按一组 (document_id, rel_path) 批量取 asset 字段，供检索结果拼装 citation.images 用。
   * rel_path 已拼接好 kb 级完整路径。
   */
  async listAssetsByRefs(auth: AuthContext, kbId: string, refs: Array<{ documentId: string; relPath: string }>): Promise<Map<string, any>> {
    if (!refs.length) return new Map();
    const pairs = refs.map((ref) => ({ document_id: ref.documentId, rel_path: ref.relPath }));
    // 用 OR (kb_id, document_id, rel_path) IN (...)：PG 支持元组 IN。
    const result = await this.pool.query<any>(
      `SELECT a.id, a.document_id, a.rel_path, a.name, a.mime, a.caption
       FROM knowledge_assets a
       WHERE a.tenant_id=$1 AND a.kb_id=$2 AND a.deleted_at IS NULL
         AND (a.document_id, a.rel_path) IN (SELECT * FROM UNNEST($3::uuid[], $4::text[]))`,
      [auth.tenantId, kbId, pairs.map((p) => p.document_id), pairs.map((p) => p.rel_path)],
    );
    const map = new Map<string, any>();
    for (const row of result.rows) {
      map.set(`${row.document_id}::${row.rel_path}`, row);
    }
    return map;
  }

  /**
   * 文档索引完成后，根据 directory + rel_path 自动把同目录下的资源挂到该文档。
   * 内部通过 document.directory 一次 SQL 完成定位，避免调用方再传目录。
   *
   * 若本次 attach 后任何新挂上的资源已具备 ready caption（说明 VLM 跑得比 md 索引还快），
   * 自动入队一条 reindex 任务，让 pipeline 把 caption chunk 加入向量空间。
   */
  async attachAssetsToDocument(tenantId: string, kbId: string, documentId: string): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE knowledge_assets a
       SET document_id = $3, updated_at = now()
       FROM knowledge_documents d
       WHERE a.tenant_id = $1 AND a.kb_id = $2 AND a.document_id IS NULL AND a.deleted_at IS NULL
         AND d.id = $3 AND d.tenant_id = a.tenant_id AND d.kb_id = a.kb_id AND d.deleted_at IS NULL
         AND d.directory <> ''
         -- 精确匹配「文档目录 + 资源文件名」。前缀 LIKE 会让放在父目录的文档
         -- （如 dishes/condiment/xxx.md）把子文件夹（草莓酱/油泼辣子…）的资源全部抢走。
         AND a.rel_path = d.directory || '/' || a.name
       RETURNING a.id`,
      [tenantId, kbId, documentId],
    );
    if (!updated.rows?.length) return;
    // 任何被 attach 的资源若已经 ready caption，立即触发一次 reindex。
    // 用 reindex 而不是新增一种 kind，复用现有 consumer + pipeline。
    const ready = await this.pool.query(
      `SELECT 1 FROM knowledge_assets
       WHERE tenant_id = $1 AND kb_id = $2 AND document_id = $3 AND caption_status = 'ready' LIMIT 1`,
      [tenantId, kbId, documentId],
    );
    if (!ready.rows[0]) return;
    await this.enqueueReindexIfAttached(tenantId, kbId, documentId, 'attach_with_ready_caption');
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

  // ───────────────────────────────────────────────────────────────────────
  // VLM 图片 caption 任务（与 knowledge_index_jobs 类似的租约 + 退避模型）
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 入队一张图片的 caption 任务。
   * - 同一资产若已有 queued / running 任务，复用并返回。
   * - 已 disabled / 已 ready 的资产直接跳过（返回 null）。
   * - 任务 ID 必须是 UUID：knowledge_caption_jobs.id 是 uuid 主键，不能拼 asset_id 前缀。
   */
  async enqueueCaptionJob(input: {
    tenantId: string;
    kbId: string;
    assetId: string;
    maxAttempts?: number;
  }): Promise<{ id: string; job: any } | null> {
    const client: any = 'connect' in this.pool ? await (this.pool as any).connect() : this.pool;
    try {
      await client.query('BEGIN');
      const asset = await client.query(
        `SELECT id, caption_status FROM knowledge_assets
         WHERE tenant_id=$1 AND kb_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE`,
        [input.tenantId, input.kbId, input.assetId],
      );
      if (!asset.rows[0]) { await client.query('ROLLBACK'); return null; }
      const status = asset.rows[0].caption_status;
      if (status === 'disabled') { await client.query('COMMIT'); return null; }
      const existing = await client.query(
        `SELECT * FROM knowledge_caption_jobs WHERE asset_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.assetId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { id: existing.rows[0].id, job: existing.rows[0] };
      }
      const id = randomUUID();
      const job = await client.query(
        `INSERT INTO knowledge_caption_jobs (id, tenant_id, kb_id, asset_id, status, max_attempts)
         VALUES ($1, $2, $3, $4, 'queued', $5)
         ON CONFLICT (asset_id) WHERE status IN ('queued','running') DO NOTHING
         RETURNING *`,
        [id, input.tenantId, input.kbId, input.assetId, input.maxAttempts ?? 3],
      );
      if (!job.rows[0]) {
        const fallback = await client.query(
          `SELECT * FROM knowledge_caption_jobs WHERE asset_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
          [input.assetId],
        );
        await client.query('COMMIT');
        return fallback.rows[0] ? { id: fallback.rows[0].id, job: fallback.rows[0] } : null;
      }
      await client.query(
        `UPDATE knowledge_assets SET caption_status='queued', caption_updated_at=now(), updated_at=now()
         WHERE id=$1 AND caption_status IN ('pending','failed')`,
        [input.assetId],
      );
      await client.query('COMMIT');
      return { id: job.rows[0].id, job: job.rows[0] };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { if (client.release) client.release(); }
  }

  async listQueuedOrStaleCaptionJobs(now: Date, limit: number): Promise<any[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit');
    const result = await this.pool.query(
      `SELECT * FROM knowledge_caption_jobs
       WHERE status='queued' OR (status='running' AND lease_expires_at < $1)
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  }

  /**
   * 找出「caption_status=pending 且没有对应 caption job」的孤儿资产。
   *
   * 出现场景：019 迁移之前上传的 LFS 指针 / 占位文件，enqueueCaptionJob 在
   * caption_status='queued' 上被 CHECK 约束回滚，行落到 knowledge_assets 但
   * knowledge_caption_jobs 里没有对应任务。对账循环只扫 jobs 表捞不到这些行，
   * 必须从 assets 反向找。
   *
   * minSizeBytes 默认 1024 与 API 上传端下限保持一致：< 1024 字节不可能是真图，
   * 即使现在没有 job 行也不补，让它们由上层的「标 skipped」清理脚本处理。
   */
  async listPendingOrphanCaptionAssets(limit: number, minSizeBytes = 1024): Promise<Array<{ id: string; kbId: string; tenantId: string }>> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit');
    const result = await this.pool.query(
      `SELECT a.id, a.kb_id, a.tenant_id
       FROM knowledge_assets a
       WHERE a.deleted_at IS NULL
         AND a.caption_status = 'pending'
         AND a.size_bytes >= $2
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_caption_jobs j WHERE j.asset_id = a.id
         )
       ORDER BY a.created_at ASC
       LIMIT $1`,
      [limit, minSizeBytes],
    );
    return result.rows.map((r) => ({
      id: String(r.id),
      kbId: String(r.kb_id),
      tenantId: String(r.tenant_id),
    }));
  }

  async claimCaptionJob(tenantId: string, jobId: string, leaseMs: number): Promise<{ jobId: string; leaseToken: string } | null> {
    const leaseToken = randomUUID();
    const result = await this.pool.query(
      `UPDATE knowledge_caption_jobs
       SET status='running', attempts=attempts+1, lease_token=$4::uuid,
           lease_expires_at=now() + ($3::bigint * interval '1 millisecond'),
           started_at=COALESCE(started_at, now()), updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND (status='queued' OR (status='running' AND lease_expires_at < now()))
       RETURNING asset_id`,
      [tenantId, jobId, leaseMs, leaseToken],
    );
    if (!(result.rowCount ?? 0)) return null;
    this.captionLeases.set(`${tenantId}:${jobId}`, leaseToken);
    return { jobId, leaseToken };
  }

  /** 写回 caption + 标记完成（成功 / 跳过 / 失败共用）。 */
  async completeCaptionJob(
    tenantId: string,
    jobId: string,
    token: string,
    result: { caption: string | null; model: string; status: 'completed' | 'skipped'; error?: { code: string; message: string } },
  ): Promise<boolean> {
    if (!this.captionLeases.get(`${tenantId}:${jobId}`)) return false;
    const client: any = 'connect' in this.pool ? await (this.pool as any).connect() : this.pool;
    try {
      await client.query('BEGIN');
      const job = await client.query(
        `UPDATE knowledge_caption_jobs
         SET status=$4, model=$5, error_code=$6, error_message=$7, finished_at=now(),
             lease_token=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND lease_token=$3::uuid AND lease_expires_at > now() AND status='running'
         RETURNING asset_id, kb_id`,
        [jobId, tenantId, token, result.status, result.model, result.error?.code ?? null, result.error?.message ?? null],
      );
      if (!job.rows[0]) { await client.query('ROLLBACK'); return false; }
      await client.query(
        `UPDATE knowledge_assets
         SET caption=$3, caption_status=$4, caption_model=$5, caption_error=$6, caption_updated_at=now(), updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND kb_id=$7`,
        [tenantId, job.rows[0].asset_id, result.caption, result.status === 'completed' ? 'ready' : (result.error?.code ? 'failed' : 'skipped'), result.model, result.error?.message ?? null, job.rows[0].kb_id],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { if (client.release) client.release(); }
  }

  async failCaptionJobWithRetry(
    tenantId: string,
    jobId: string,
    token: string,
    error: { code: string; message: string },
    backoffMs: number,
    nextAttempt: { attempts: number; maxAttempts: number },
  ): Promise<{ requeued: boolean }> {
    if (!this.captionLeases.get(`${tenantId}:${jobId}`)) return { requeued: false };
    const reachedMax = nextAttempt.attempts >= nextAttempt.maxAttempts;
    if (reachedMax) {
      await this.completeCaptionJob(tenantId, jobId, token, {
        caption: null,
        model: '',
        status: 'skipped',
        error,
      });
      return { requeued: false };
    }
    const result = await this.pool.query(
      `UPDATE knowledge_caption_jobs
       SET status='queued', lease_token=NULL, lease_expires_at=NULL,
           next_attempt_at=now() + ($5::bigint * interval '1 millisecond'),
           error_code=$3, error_message=$4, updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND lease_token=$6::uuid AND lease_expires_at > now() AND status='running'
       RETURNING asset_id, kb_id`,
      [jobId, tenantId, error.code, error.message, backoffMs, token],
    );
    if (!result.rows[0]) return { requeued: false };
    await this.pool.query(
      `UPDATE knowledge_assets SET caption_status='failed', caption_error=$3, caption_updated_at=now(), updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, result.rows[0].asset_id, error.message],
    );
    return { requeued: true };
  }

  async getCaptionJob(tenantId: string, jobId: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT * FROM knowledge_caption_jobs WHERE tenant_id=$1 AND id=$2`,
      [tenantId, jobId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * 列出挂在本 document 上的图片资产，按 rel_path 排序。
   * 用于 indexer pipeline 给文本 chunk 之后追加 caption chunk（图片语义检索）。
   */
  async listDocumentAssetsForIndexing(
    tenantId: string,
    kbId: string,
    documentId: string,
    options: { onlyWithCaption?: boolean; captionStatus?: 'ready' } = {},
  ): Promise<any[]> {
    const filters = [
      'a.tenant_id=$1',
      'a.kb_id=$2',
      'a.document_id=$3',
      'a.deleted_at IS NULL',
    ];
    const values: unknown[] = [tenantId, kbId, documentId];
    if (options.onlyWithCaption) {
      filters.push('a.caption IS NOT NULL');
    }
    if (options.captionStatus) {
      filters.push(`a.caption_status = $${values.length + 1}`);
      values.push(options.captionStatus);
    }
    const result = await this.pool.query(
      `SELECT a.id, a.rel_path, a.name, a.mime, a.caption, a.caption_status, a.document_id
       FROM knowledge_assets a
       WHERE ${filters.join(' AND ')}
       ORDER BY a.rel_path ASC`,
      values,
    );
    return result.rows;
  }

  /**
   * 给定 asset_id 拿 (tenant_id, kb_id, document_id, caption_status, mime, name) — worker 一次拉全，
   * 避免在 caption worker 中并发地分别打三张表。
   */
  async getAssetForCaption(tenantId: string, assetId: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, kb_id, document_id, rel_path, name, mime, caption_status, caption, object_key, size_bytes
       FROM knowledge_assets
       WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [tenantId, assetId],
    );
    return result.rows[0] ?? null;
  }

  /** 在 caption 写完后，若 asset 已挂到 document，则入队一条 reindex 任务，让新 caption 参与 embedding。 */
  async enqueueReindexIfAttached(tenantId: string, kbId: string, documentId: string, reason: string): Promise<{ id: string } | null> {
    const client: any = 'connect' in this.pool ? await (this.pool as any).connect() : this.pool;
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM knowledge_index_jobs
         WHERE tenant_id=$1 AND document_id=$2 AND status IN ('queued','running')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [tenantId, documentId],
      );
      if (existing.rows[0]) { await client.query('COMMIT'); return { id: existing.rows[0].id }; }
      const id = randomUUID();
      const job = await client.query(
        `INSERT INTO knowledge_index_jobs (id, kb_id, tenant_id, document_id, kind, status)
         VALUES ($1, $2, $3, $4, 'reindex', 'queued') RETURNING id`,
        [id, kbId, tenantId, documentId],
      );
      await client.query(
        `UPDATE knowledge_documents SET status='queued', updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('queued','running','pending')`,
        [tenantId, documentId],
      );
      await client.query('COMMIT');
      return { id: job.rows[0].id };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { if (client.release) client.release(); }
  }
}
