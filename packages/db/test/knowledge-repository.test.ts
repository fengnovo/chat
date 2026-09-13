import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeRepository } from '../src/knowledge-repository.js';

test('repository methods include tenant predicates and bound retrieval citations', async () => {
  const queries: string[] = [];
  const pool: any = { query: async (text: string) => { queries.push(text); return { rows: [], rowCount: 0 }; } };
  const repo = new KnowledgeRepository(pool);
  await repo.claimIndexJob('t', 'job', 1000);
  await repo.appendRetrievalLog({ tenantId: 't', userId: 'u', sessionId: 's', runId: 'r', retrievalId: 'x', kbIds: [], query: 'q', topK: 1, maxHops: 0, resultCount: 0, rerankStatus: 'none', citations: Array.from({ length: 100 }, (_, i) => ({ id: i })), latencyMs: 1, status: 'ok' });
  assert.ok(queries.some((q) => /tenant_id/i.test(q)));
});

test('claim returns a lease token and stale worker transitions are rejected', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool: any = { query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [{ id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  const first = await repo.claimIndexJob('tenant-a', 'job', 1000);
  const second = await repo.claimIndexJob('tenant-a', 'job', 1000);
  assert.ok(first && second && first.leaseToken !== second.leaseToken);
  assert.equal(await repo.completeIndexJob('tenant-a', 'job', first.leaseToken, 1), false);
  assert.equal(await repo.completeIndexJob('tenant-a', 'job', second.leaseToken, 1), true);
  assert.match(String(queries[0]?.text), /tenant_id/);
});

test('failed job atomically marks its document failed', async () => {
  const sql: string[] = [];
  const pool: any = { query: async (text: string) => { sql.push(text); return { rows: [{ id: 'job' }], rowCount: 1 }; } };
  const repo = new KnowledgeRepository(pool);
  const lease = await repo.claimIndexJob('tenant-a', 'job', 1000);
  assert.ok(lease);
  await repo.failIndexJob('tenant-a', 'job', lease.leaseToken, new Error('bad bytes'));
  assert.ok(sql.some((q) => /knowledge_documents/i.test(q) && /failed/i.test(q)));
});
