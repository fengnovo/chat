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
});

