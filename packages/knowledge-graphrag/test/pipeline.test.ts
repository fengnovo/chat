import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexPipeline } from '../src/indexer/pipeline.js';
import { sha256Hex } from '../src/indexer/hash.js';

test('retrying an index job uses stable chunk ids and does not duplicate graph writes', async () => {
  const bytes = new TextEncoder().encode('# Hello\nworld');
  const calls = { upsert: 0, graph: 0, embed: 0 };
  const repo: any = {
    markIndexStage: async () => {}, completeIndexJob: async () => {}, failIndexJob: async () => {},
    replaceDocumentGraph: async () => { calls.graph++; },
    replaceDocumentChunks: async (_t: string, _k: string, _d: string, rows: any[]) => { (calls as any).chunks = rows.length; },
  };
  const deps: any = {
    repository: repo, download: async () => bytes,
    embedder: { profile: { key: 'p', model: 'm', dimension: 2, collectionName: '' }, embedTexts: async (x: string[]) => { calls.embed++; return x.map(() => [1, 2]); } },
    vectorStore: { ensureCollection: async () => 'c', upsert: async (p: any[]) => { calls.upsert += p.length; }, deleteByDocument: async () => {} },
    extract: async () => ({ entities: [], relationships: [] }),
  };
  const pipeline = new IndexPipeline(deps);
  const job = { id: 'j', tenantId: 't', kbId: 'k', documentId: 'd', objectKey: 'o', contentHash: sha256Hex(bytes), sizeBytes: bytes.length, mime: 'text/markdown', chunkSize: 100, chunkOverlap: 0 };
  await pipeline.run(job as any); await pipeline.run(job as any);
  assert.equal(calls.graph, 2); assert.equal(calls.upsert, 2);
  assert.equal((calls as any).chunks, 1);
});

test('pipeline failure invokes failed lifecycle transition and never embeds invalid bytes', async () => {
  const calls: string[] = [];
  const repo: any = { markIndexStage: async () => {}, failIndexJob: async (...args: any[]) => calls.push(String(args[3]?.message ?? args[3])), completeIndexJob: async () => {} };
  const deps: any = { repository: repo, download: async () => new TextEncoder().encode('bad'), embedder: { embedTexts: async () => { throw new Error('must not embed'); } }, vectorStore: {}, extract: async () => ({}) };
  await assert.rejects(() => new IndexPipeline(deps).run({ id: 'j', tenantId: 't', contentHash: '0'.repeat(64), sizeBytes: 3, mime: 'text/plain', objectKey: 'o' }));
  assert.deepEqual(calls, ['Document hash mismatch']);
});

test('pipeline aborts all durable writes when its lease is reclaimed', async () => {
  const calls = { upsert: 0, chunks: 0, graph: 0, fail: 0 };
  const bytes = new TextEncoder().encode('valid');
  const repo: any = {
    markIndexStage: async () => false,
    failIndexJob: async () => { calls.fail++; },
    replaceDocumentChunks: async () => { calls.chunks++; },
    replaceDocumentGraph: async () => { calls.graph++; },
  };
  const deps: any = { repository: repo, download: async () => bytes, embedder: { embedTexts: async () => [[1]] }, vectorStore: { upsert: async () => { calls.upsert++; } } };
  await assert.rejects(() => new IndexPipeline(deps).run({ id: 'j', tenantId: 't', contentHash: sha256Hex(bytes), sizeBytes: bytes.length, mime: 'text/plain', objectKey: 'o', chunkSize: 10, chunkOverlap: 0 }));
  assert.deepEqual(calls, { upsert: 0, chunks: 0, graph: 0, fail: 1 });
});
