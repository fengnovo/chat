import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const MAX_CITATIONS = 50;
const boundedCitations = (value: unknown) => Array.isArray(value) ? value.slice(0, MAX_CITATIONS).map((x) => {
  if (!x || typeof x !== 'object') return x;
  const copy = { ...(x as Record<string, unknown>) };
  delete copy.passage;
  return copy;
}) : [];

export class KnowledgeRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  private readonly leases = new Map<string, string>();

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
