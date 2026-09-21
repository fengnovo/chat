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

test('image caption chunks are appended, embedded, and point at the asset rel_path', async () => {
  const bytes = new TextEncoder().encode('# Steps\nmix.');
  const observations: { embeddingTexts: string[]; storedChunks: any[]; upsertedPayloads: any[] } = { embeddingTexts: [], storedChunks: [], upsertedPayloads: [] };
  const repo: any = {
    markIndexStage: async () => {},
    completeIndexJob: async () => {},
    failIndexJob: async () => {},
    replaceDocumentChunks: async (_t: string, _k: string, _d: string, rows: any[]) => { observations.storedChunks = rows; },
    replaceDocumentGraph: async () => {},
    listDocumentAssetsForIndexing: async (_t: string, _k: string, _d: string) => ([
      { id: 'a1', rel_path: 'dishes/img1.png', name: 'img1.png', mime: 'image/png', caption: '成品图：金黄酥蛋，外层裹着面包糠，流心蛋黄缓缓流出', caption_status: 'ready', document_id: 'd' },
    ]),
  };
  const deps: any = {
    repository: repo,
    download: async () => bytes,
    embedder: {
      profile: { key: 'p', model: 'm', dimension: 2, collectionName: '' },
      embedTexts: async (x: string[]) => { observations.embeddingTexts = x.slice(); return x.map(() => [1, 2]); },
    },
    vectorStore: {
      ensureCollection: async () => 'c',
      upsert: async (p: any[]) => { observations.upsertedPayloads = p.map((point) => point.payload); },
      deleteByDocument: async () => {},
    },
    extract: async () => ({ entities: [], relationships: [] }),
  };
  const pipeline = new IndexPipeline(deps);
  const job = { id: 'j', tenantId: 't', kbId: 'k', documentId: 'd', objectKey: 'o', contentHash: sha256Hex(bytes), sizeBytes: bytes.length, mime: 'text/markdown', chunkSize: 200, chunkOverlap: 0 };
  await pipeline.run(job as any);
  // 文本 chunk + caption 合成 chunk 一起被 embedding。
  assert.ok(observations.embeddingTexts.some((text) => text.includes('金黄酥蛋')), 'caption should be embedded');
  assert.ok(observations.embeddingTexts.some((text) => text.includes('Steps') || text.includes('mix')), 'text chunk should still be embedded');
  // caption chunk 用 9000+ ordinal，单独持久化，且 payload 上挂 rel_path 供检索反查。
  const captionChunk = observations.storedChunks.find((row) => row.ordinal >= 9000);
  assert.ok(captionChunk, 'caption chunk row must be stored');
  assert.equal(captionChunk.metadata.source, 'image_caption');
  assert.deepEqual(captionChunk.metadata.imageRefs[0], { path: 'dishes/img1.png', alt: '成品图：金黄酥蛋，外层裹着面包糠，流心蛋黄缓缓流出' });
  const captionPointPayload = observations.upsertedPayloads.find((p) => p.chunk_source === 'image_caption');
  assert.ok(captionPointPayload, 'caption chunk must be upserted to vector store');
  assert.deepEqual(captionPointPayload.image_refs[0], { path: 'dishes/img1.png', alt: '成品图：金黄酥蛋，外层裹着面包糠，流心蛋黄缓缓流出' });
});

test('caption augmentation tolerates repositories without listDocumentAssetsForIndexing (legacy)', async () => {
  const bytes = new TextEncoder().encode('plain text body');
  const repo: any = {
    markIndexStage: async () => {}, completeIndexJob: async () => {}, failIndexJob: async () => {},
    replaceDocumentChunks: async () => {}, replaceDocumentGraph: async () => {},
  };
  const deps: any = {
    repository: repo,
    download: async () => bytes,
    embedder: { profile: { key: 'p', model: 'm', dimension: 1, collectionName: '' }, embedTexts: async (x: string[]) => x.map(() => [1]) },
    vectorStore: { ensureCollection: async () => 'c', upsert: async () => {}, deleteByDocument: async () => {} },
    extract: async () => ({ entities: [], relationships: [] }),
  };
  // 关键：repo 没有 listDocumentAssetsForIndexing 也不能崩。
  await new IndexPipeline(deps).run({ id: 'j', tenantId: 't', kbId: 'k', documentId: 'd', objectKey: 'o', contentHash: sha256Hex(bytes), sizeBytes: bytes.length, mime: 'text/plain', chunkSize: 100, chunkOverlap: 0 } as any);
});
