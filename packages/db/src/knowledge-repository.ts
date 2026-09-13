import type { Pool } from 'pg';

const MAX_CITATIONS = 50;
const boundedCitations = (value: unknown) => Array.isArray(value) ? value.slice(0, MAX_CITATIONS).map((x) => {
  if (!x || typeof x !== 'object') return x;
  const copy = { ...(x as Record<string, unknown>) };
  delete copy.passage;
  return copy;
}) : [];

export class KnowledgeRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async claimIndexJob(jobId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE knowledge_index_jobs SET status = 'running', attempts = attempts + 1, lease_expires_at = now() + ($2::bigint * interval '1 millisecond'), started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now())) RETURNING id`, [jobId, leaseMs]);
    return (result.rowCount ?? 0) > 0;
  }

  async markIndexStage(tenantId: string, jobId: string, stage: string): Promise<void> {
    await this.pool.query(`UPDATE knowledge_index_jobs SET status = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [jobId, tenantId, stage]);
  }
  async completeIndexJob(tenantId: string, jobId: string, chunkCount = 0): Promise<void> {
    await this.pool.query(`UPDATE knowledge_index_jobs SET status = 'completed', progress = 100, finished_at = now(), lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [jobId, tenantId]);
    if (chunkCount >= 0) await this.pool.query(`UPDATE knowledge_documents d SET status = 'ready', chunk_count = $3, indexed_at = now(), updated_at = now() FROM knowledge_index_jobs j WHERE j.id = $1 AND j.tenant_id = $2 AND d.id = j.document_id AND d.tenant_id = j.tenant_id`, [jobId, tenantId, chunkCount]);
  }
  async failIndexJob(tenantId: string, jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query(`UPDATE knowledge_index_jobs SET status = 'failed', error_message = $3, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [jobId, tenantId, message]);
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
  async appendRetrievalLog(input: any): Promise<void> {
    const citations = boundedCitations(input.citations);
    await this.pool.query(`INSERT INTO knowledge_retrieval_logs (id, retrieval_id, tenant_id, user_id, session_id, run_id, kb_ids, query, top_k, max_hops, result_count, rerank_status, citations, latency_ms, status) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [input.retrievalId, input.tenantId, input.userId, input.sessionId, input.runId, input.kbIds, input.query, input.topK, input.maxHops, input.resultCount, input.rerankStatus, JSON.stringify(citations), input.latencyMs, input.status]);
  }
}
