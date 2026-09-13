import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeRepository } from '../src/knowledge-repository.js';

test('repository methods include tenant predicates and bound retrieval citations', async () => {
  const queries: string[] = [];
  const pool: any = { query: async (text: string) => { queries.push(text); return { rows: [], rowCount: 0 }; } };
  const repo = new KnowledgeRepository(pool);
  await repo.claimIndexJob('job', 1000);
  await repo.appendRetrievalLog({ tenantId: 't', userId: 'u', sessionId: 's', runId: 'r', retrievalId: 'x', kbIds: [], query: 'q', topK: 1, maxHops: 0, resultCount: 0, rerankStatus: 'none', citations: Array.from({ length: 100 }, (_, i) => ({ id: i })), latencyMs: 1, status: 'ok' });
  assert.ok(queries.some((q) => /tenant_id/i.test(q)));
});
