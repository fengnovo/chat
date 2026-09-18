import { createHash } from 'node:crypto';

export interface MemoryIndexConfig {
  qdrantUrl?: string;
  qdrantApiKey?: string;
  embeddingUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}

/** 轻量 REST 适配器：复用现有 Qdrant/Embedding 服务，不把索引故障带入主链路。 */
export function createMemoryIndexer(config: MemoryIndexConfig) {
  if (!config.qdrantUrl || !config.embeddingUrl || !config.embeddingApiKey || !config.embeddingModel || !config.embeddingDimension) return undefined;
  const qdrant = config.qdrantUrl.replace(/\/+$/, '');
  const collection = `agent_memory_${config.embeddingDimension}`;
  let ready: Promise<void> | undefined;
  const headers = {
    'content-type': 'application/json',
    ...(config.qdrantApiKey ? { 'api-key': config.qdrantApiKey } : {}),
  };
  const ensure = async () => {
    const response = await fetch(`${qdrant}/collections/${collection}`, { headers });
    if (response.ok) return;
    const created = await fetch(`${qdrant}/collections/${collection}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ vectors: { size: config.embeddingDimension, distance: 'Cosine' } }),
    });
    if (!created.ok && created.status !== 409) throw new Error(`Qdrant collection creation failed: ${created.status}`);
  };
  return {
    async upsert(memory: { id: string; tenantId: string; userId: string; content: string; normalizedKey: string; kind?: string; importance?: number; confidence?: number; projectId?: string | null; scope?: string }) {
      ready ??= ensure();
      await ready;
      const embeddingResponse = await fetch(config.embeddingUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embeddingApiKey}` },
        body: JSON.stringify({ model: config.embeddingModel, input: [memory.content], dimensions: config.embeddingDimension }),
      });
      if (!embeddingResponse.ok) throw new Error(`Memory embedding failed: ${embeddingResponse.status}`);
      const embeddingBody = await embeddingResponse.json() as { data?: Array<{ embedding?: number[] }> };
      const vector = embeddingBody.data?.[0]?.embedding;
      if (!vector || vector.length !== config.embeddingDimension) throw new Error('Memory embedding dimension mismatch');
      const pointId = /^[0-9a-f-]{36}$/i.test(memory.id)
        ? memory.id
        : createHash('sha256').update(memory.id).digest('hex').slice(0, 32);
      const response = await fetch(`${qdrant}/collections/${collection}/points`, {
        method: 'PUT', headers,
        body: JSON.stringify({ points: [{ id: pointId, vector, payload: { memory_id: memory.id, tenant_id: memory.tenantId, user_id: memory.userId, project_id: memory.projectId ?? null, scope: memory.scope ?? 'global', normalized_key: memory.normalizedKey, content: memory.content, kind: memory.kind, importance: memory.importance, confidence: memory.confidence } }] }),
      });
      if (!response.ok) throw new Error(`Memory Qdrant upsert failed: ${response.status}`);
    },
    async search(query: string, tenantId: string, userId: string, limit = 8, projectId?: string | null) {
      ready ??= ensure();
      await ready;
      const embeddingResponse = await fetch(config.embeddingUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embeddingApiKey}` },
        body: JSON.stringify({ model: config.embeddingModel, input: [query], dimensions: config.embeddingDimension }),
      });
      if (!embeddingResponse.ok) throw new Error(`Memory query embedding failed: ${embeddingResponse.status}`);
      const body = await embeddingResponse.json() as { data?: Array<{ embedding?: number[] }> };
      const vector = body.data?.[0]?.embedding;
      if (!vector) throw new Error('Memory query embedding missing');
      const response = await fetch(`${qdrant}/collections/${collection}/points/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ query: vector, limit, with_payload: true, filter: { must: [
          { key: 'tenant_id', match: { value: tenantId } },
          { key: 'user_id', match: { value: userId } },
          ...(projectId ? [{ key: 'project_id', match: { any: [null, projectId] } }] : []),
        ] } }),
      });
      if (!response.ok) throw new Error(`Memory Qdrant query failed: ${response.status}`);
      const result = await response.json() as { result?: { points?: Array<{ id: string; score?: number; payload?: Record<string, unknown> }> } };
      return (result.result?.points ?? []).map((point) => ({
        id: String(point.payload?.memory_id ?? point.id),
        tenantId,
        userId,
        projectId: null,
        assistantKey: 'chat',
        scope: String(point.payload?.scope ?? 'global') as `project:${string}` | 'global',
        kind: String(point.payload?.kind ?? 'episode') as 'episode',
        content: String(point.payload?.content ?? ''),
        normalizedKey: String(point.payload?.normalized_key ?? point.id),
        importance: Number(point.payload?.importance ?? 0.5),
        confidence: Number(point.payload?.confidence ?? point.score ?? 0.5),
        status: 'active' as const,
        sourceSessionId: null,
        sourceRunId: null,
        supersedesId: null,
        metadata: { semanticScore: point.score ?? 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: null,
      }));
    },
    async remove(memoryId: string) {
      ready ??= ensure();
      await ready;
      const pointId = /^[0-9a-f-]{36}$/i.test(memoryId) ? memoryId : createHash('sha256').update(memoryId).digest('hex').slice(0, 32);
      const response = await fetch(`${qdrant}/collections/${collection}/points/delete`, {
        method: 'POST', headers,
        body: JSON.stringify({ points: [pointId], wait: true }),
      });
      if (!response.ok) throw new Error(`Memory Qdrant delete failed: ${response.status}`);
    },
  };
}
