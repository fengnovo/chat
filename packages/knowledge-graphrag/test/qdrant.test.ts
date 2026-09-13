import test from 'node:test';
import assert from 'node:assert/strict';
import { QdrantChunkStore } from '../src/store/qdrant.js';

function fakeClient() {
  const points = new Map<string, Map<string, any>>();
  const requests: any[] = [];
  return {
    points, requests,
    async getCollections() { return { collections: [] }; },
    async createCollection() {},
    async createPayloadIndex() {},
    async upsert(collection: string, body: any) { const bucket = points.get(collection) ?? new Map(); points.set(collection, bucket); for (const p of body.points) bucket.set(String(p.id), p); },
    async search(collection: string, body: any) { requests.push({ type: 'search', collection, body }); const bucket = points.get(collection) ?? new Map(); return [...bucket.values()].filter((p) => body.filter.must.every((x: any) => x.key === 'tenant_id' ? p.payload[x.key] === x.match.value : x.match.any.includes(p.payload[x.key]))).map((p) => ({ id: p.id, score: 1, payload: p.payload, vector: body.vector })); },
    async delete(collection: string, body: any) { requests.push({ type: 'delete', collection, body }); const bucket = points.get(collection) ?? new Map(); for (const [id, p] of bucket) if (body.filter.must.every((x: any) => p.payload[x.key] === x.match.value)) bucket.delete(id); },
  };
}

test('derives distinct collections, merges tenant/kb filters, and upserts idempotently', async () => {
  const client = fakeClient();
  const a = new QdrantChunkStore(client as any, { prefix: 'test' });
  const b = new QdrantChunkStore(client as any, { prefix: 'test' });
  const p1 = { key: 'a', model: 'm1', dimension: 3, collectionName: '' };
  const p2 = { key: 'b', model: 'm2', dimension: 3, collectionName: '' };
  const c1 = await a.ensureCollection(p1); const c2 = await b.ensureCollection(p2);
  assert.notEqual(c1, c2);
  await a.upsert([{ id: 'x', vector: [1, 2, 3], payload: { tenant_id: 't1', kb_id: 'k1', document_id: 'd1' } }]);
  await b.upsert([{ id: 'y', vector: [1, 2, 3], payload: { tenant_id: 't1', kb_id: 'k1', document_id: 'd2' } }]);
  const hits = await a.search([1, 2, 3], 't1', ['k1'], 5);
  assert.equal(hits.length, 1);
  assert.equal((await b.search([1, 2, 3], 't1', ['k1'], 5))[0]!.chunkId, 'y');
  assert.deepEqual(client.requests[0].body.filter.must, [{ key: 'tenant_id', match: { value: 't1' } }, { key: 'kb_id', match: { any: ['k1'] } }]);
});

test('deleteByDocument only removes matching tenant, kb, and document', async () => {
  const client = fakeClient(); const store = new QdrantChunkStore(client as any, { prefix: 'test' });
  await store.ensureCollection({ key: 'a', model: 'm', dimension: 3, collectionName: '' });
  await store.upsert([
    { id: '1', vector: [1, 2, 3], payload: { tenant_id: 't', kb_id: 'k', document_id: 'd' } },
    { id: '2', vector: [1, 2, 3], payload: { tenant_id: 't', kb_id: 'k', document_id: 'other' } },
  ]);
  await store.deleteByDocument('t', 'k', 'd');
  const collection = [...client.points.values()][0]!;
  assert.equal(collection.has('1'), false); assert.equal(collection.has('2'), true);
  assert.deepEqual(client.requests[0].body.filter.must, [{ key: 'tenant_id', match: { value: 't' } }, { key: 'kb_id', match: { value: 'k' } }, { key: 'document_id', match: { value: 'd' } }]);
});
