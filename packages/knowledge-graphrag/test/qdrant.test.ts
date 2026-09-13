import test from 'node:test';
import assert from 'node:assert/strict';
import { QdrantChunkStore } from '../src/store/qdrant.js';

function fakeClient() {
  const points = new Map<string, any>();
  return {
    points,
    async getCollections() { return { collections: [] }; },
    async createCollection() {},
    async createPayloadIndex() {},
    async upsert(_collection: string, body: any) { for (const p of body.points) points.set(String(p.id), p); },
    async search(_collection: string, body: any) { return [...points.values()].map((p) => ({ id: p.id, score: 1, payload: p.payload, vector: body.vector })); },
    async delete(_collection: string, body: any) { for (const [id, p] of points) if (body.filter.must.every((x: any) => p.payload[x.key] === x.match.value)) points.delete(id); },
  };
}

test('derives distinct collections, merges tenant/kb filters, and upserts idempotently', async () => {
  const client = fakeClient();
  const a = new QdrantChunkStore(client as any, { prefix: 'test' });
  const p1 = { key: 'a', model: 'm1', dimension: 3, collectionName: '' };
  const p2 = { key: 'b', model: 'm2', dimension: 3, collectionName: '' };
  const c1 = await a.ensureCollection(p1); const c2 = await a.ensureCollection(p2);
  assert.notEqual(c1, c2);
  await a.upsert([{ id: 'x', vector: [1, 2, 3], payload: { tenant_id: 't1', kb_id: 'k1', document_id: 'd1' } }]);
  await a.upsert([{ id: 'x', vector: [1, 2, 3], payload: { tenant_id: 't1', kb_id: 'k1', document_id: 'd1' } }]);
  const hits = await a.search([1, 2, 3], 't1', ['k1'], 5);
  assert.equal(hits.length, 1);
});

test('deleteByDocument only removes matching tenant, kb, and document', async () => {
  const client = fakeClient(); const store = new QdrantChunkStore(client as any, { prefix: 'test' });
  await store.ensureCollection({ key: 'a', model: 'm', dimension: 3, collectionName: '' });
  await store.upsert([
    { id: '1', vector: [1, 2, 3], payload: { tenant_id: 't', kb_id: 'k', document_id: 'd' } },
    { id: '2', vector: [1, 2, 3], payload: { tenant_id: 't', kb_id: 'k', document_id: 'other' } },
  ]);
  await store.deleteByDocument('t', 'k', 'd');
  assert.equal(client.points.has('1'), false); assert.equal(client.points.has('2'), true);
});

