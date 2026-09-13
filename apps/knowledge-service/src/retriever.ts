import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  mergeCandidates,
  normalizeEntityKey,
  type Embedder,
  type GraphLimits,
  type GraphRelation,
  type QdrantChunkStore,
} from '@repo/knowledge-graphrag';

export interface RetrieveParams {
  tenantId: string;
  knowledgeBaseIds: string[];
  query: string;
  userId?: string;
  sessionId?: string;
  runId?: string;
}

export interface ProductionRetrieverDeps {
  pool: Pick<Pool, 'query'>;
  embedder: Embedder;
  vectorStore: Pick<QdrantChunkStore, 'search' | 'ensureCollection'>;
  repository?: { appendRetrievalLog?(input: unknown): Promise<void> };
  logger?: { error?(error: unknown): void };
  limits?: Partial<GraphLimits> & { maxCandidates?: number; fanoutPerHop?: number; passageChars?: number };
}

const MAX_CITATIONS = 20;
const MAX_RELATIONS_OUTPUT = 20;
const MAX_RELATION_CHUNKS = 10;

function relationId(source: string, type: string, target: string): string {
  return createHash('sha256').update(`${source}\0${type}\0${target}`).digest('hex').slice(0, 32);
}

/**
 * 生产 GraphRAG 检索：向量召回 → 命中 chunk 上的实体作为种子 → PG 关系表 BFS → 合并候选 → 拼装引用。
 */
export function createRetriever(deps: ProductionRetrieverDeps) {
  const limits = {
    maxHops: deps.limits?.maxHops ?? 2,
    maxFanout: deps.limits?.maxFanout ?? 20,
    maxRelations: deps.limits?.maxRelations ?? 100,
    maxCandidates: deps.limits?.maxCandidates ?? MAX_CITATIONS,
    fanoutPerHop: deps.limits?.fanoutPerHop ?? 100,
    passageChars: deps.limits?.passageChars ?? 2_000,
  };
  let collectionReady: Promise<unknown> | null = null;

  async function traverseGraph(
    tenantId: string,
    kbIds: string[],
    seedChunkIds: string[],
    maxHops: number,
  ): Promise<{ relations: GraphRelation[]; hops: number }> {
    if (!seedChunkIds.length || maxHops <= 0) return { relations: [], hops: 0 };
    const seedRows = await deps.pool.query<{ entity_key: string }>(
      `SELECT DISTINCT entity_key FROM graph_entities
       WHERE tenant_id = $1 AND kb_id = ANY($2::uuid[]) AND chunk_ids && $3::uuid[]`,
      [tenantId, kbIds, seedChunkIds],
    );
    const seenKeys = new Set(seedRows.rows.map((row) => normalizeEntityKey(row.entity_key)));
    if (!seenKeys.size) return { relations: [], hops: 0 };

    const relationsById = new Map<string, GraphRelation>();
    let frontier = [...seenKeys];
    let hops = 0;
    while (frontier.length && hops < maxHops && relationsById.size < limits.maxRelations) {
      const rows = await deps.pool.query<{ source_key: string; target_key: string; relation: string; chunk_ids: string[] }>(
        `SELECT source_key, target_key, relation, chunk_ids FROM graph_relationships
         WHERE tenant_id = $1 AND kb_id = ANY($2::uuid[])
           AND (source_key = ANY($3::text[]) OR target_key = ANY($3::text[]))
         ORDER BY source_key, relation, target_key
         LIMIT $4`,
        [tenantId, kbIds, frontier, limits.fanoutPerHop],
      );
      const nextFrontier: string[] = [];
      for (const row of rows.rows) {
        const source = normalizeEntityKey(row.source_key);
        const target = normalizeEntityKey(row.target_key);
        const type = row.relation.trim();
        const id = relationId(source, type, target);
        if (!relationsById.has(id)) {
          relationsById.set(id, { id, source, target, type, sourceChunkIds: [...(row.chunk_ids ?? [])] });
          if (relationsById.size >= limits.maxRelations) break;
        }
        for (const key of [source, target]) {
          if (!seenKeys.has(key)) { seenKeys.add(key); nextFrontier.push(key); }
        }
      }
      hops += 1;
      frontier = [...new Set(nextFrontier)];
      if (!rows.rowCount) break;
    }
    return { relations: [...relationsById.values()], hops };
  }

  return {
    async retrieve(params: RetrieveParams) {
      const startedAt = Date.now();
      const retrievalId = randomUUID();
      const kbIds = [...new Set(params.knowledgeBaseIds)];

      const kbRows = await deps.pool.query<{ id: string; top_k: number; max_hops: number; graph_enabled: boolean }>(
        `SELECT id, top_k, max_hops, graph_enabled FROM knowledge_bases
         WHERE tenant_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
        [params.tenantId, kbIds],
      );
      const kbs = kbRows.rows;
      if (!kbs.length) {
        return { retrievalId, citations: [], relations: [], stats: { vectorHits: 0, graphHops: 0, searchedKbs: 0, durationMs: Date.now() - startedAt, truncated: false } };
      }
      const topK = Math.min(50, Math.max(...kbs.map((kb) => kb.top_k)));
      const maxHops = Math.min(limits.maxHops, Math.max(...kbs.map((kb) => kb.max_hops)));

      collectionReady ??= deps.vectorStore.ensureCollection(deps.embedder.profile);
      await collectionReady;
      const queryVector = await deps.embedder.embedQuery(params.query);
      const vectorHits = await deps.vectorStore.search(queryVector, params.tenantId, kbs.map((kb) => kb.id), topK);

      const graph = kbs.some((kb) => kb.graph_enabled)
        ? await traverseGraph(params.tenantId, kbs.map((kb) => kb.id), vectorHits.map((hit) => hit.chunkId), maxHops)
        : { relations: [], hops: 0 };

      const candidates = mergeCandidates(vectorHits, { entityKeys: [], relations: graph.relations, chunkIds: [] }, { maxCandidates: limits.maxCandidates });

      const chunkRows = await deps.pool.query<{
        id: string; document_id: string; ordinal: number; heading: string | null; text: string; document_name: string;
      }>(
        `SELECT c.id, c.document_id, c.ordinal, c.heading, c.text, d.name AS document_name
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE c.tenant_id = $1 AND c.id = ANY($2::uuid[]) AND d.deleted_at IS NULL`,
        [params.tenantId, candidates.map((candidate) => candidate.chunkId)],
      );
      const chunksById = new Map(chunkRows.rows.map((row) => [row.id, row]));
      const validCandidates = candidates.filter((candidate) => chunksById.has(candidate.chunkId));

      const citations = validCandidates.map((candidate) => {
        const row = chunksById.get(candidate.chunkId)!;
        return {
          chunkId: row.id,
          documentId: row.document_id,
          documentName: row.document_name,
          ordinal: row.ordinal,
          ...(row.heading ? { heading: row.heading.slice(0, 500) } : {}),
          score: Math.max(-1, Math.min(1, candidate.score)),
          via: candidate.via === 'vector+graph' ? 'both' : candidate.via,
          passage: row.text.slice(0, limits.passageChars),
        };
      });

      const citationIds = new Set(citations.map((citation) => citation.chunkId));
      const relations = graph.relations
        .filter((relation) => relation.sourceChunkIds.some((id) => citationIds.has(id)))
        .slice(0, MAX_RELATIONS_OUTPUT)
        .map((relation) => ({
          source: relation.source,
          relation: relation.type,
          target: relation.target,
          chunkIds: relation.sourceChunkIds.filter((id) => chunksById.has(id)).slice(0, MAX_RELATION_CHUNKS),
        }))
        .filter((relation) => relation.chunkIds.length > 0);

      const durationMs = Date.now() - startedAt;
      const result = {
        retrievalId,
        citations,
        relations,
        stats: {
          vectorHits: vectorHits.length,
          graphHops: graph.hops,
          searchedKbs: kbs.length,
          durationMs,
          truncated: citations.length >= limits.maxCandidates || relations.length >= MAX_RELATIONS_OUTPUT,
        },
      };

      // 检索日志是可观测性旁路：run/session 外的临时 token（如冒烟测试）可能不满足外键，失败不影响检索。
      if (deps.repository?.appendRetrievalLog && params.userId && params.sessionId && params.runId) {
        try {
          await deps.repository.appendRetrievalLog({
            retrievalId,
            tenantId: params.tenantId,
            userId: params.userId,
            sessionId: params.sessionId,
            runId: params.runId,
            kbIds,
            query: params.query,
            topK,
            maxHops,
            resultCount: citations.length,
            rerankStatus: 'disabled',
            citations,
            latencyMs: durationMs,
            status: 'succeeded',
          });
        } catch (error) {
          deps.logger?.error?.(error);
        }
      }
      return result;
    },
  };
}
