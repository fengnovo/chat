import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { registerKnowledgeRoutes } from '../src/knowledge-routes.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const kbId = '00000000-0000-4000-8000-000000000004';
const documentId = '00000000-0000-4000-8000-000000000005';

function makeApp(repository: Record<string, unknown>, artifacts = {}) {
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => {
    request.auth = { tenantId, userId, roles: [] };
  });
  return registerKnowledgeRoutes(app, {
    repository,
    artifacts,
    knowledgeQueue: { add: async () => ({}) },
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 10 },
  }).then(() => app);
}

test('knowledge base list hides unauthorized bases', async () => {
  const app = await makeApp({
    listKnowledgeBases: async () => [{ id: kbId, name: 'Visible' }],
  });
  const response = await app.inject({ method: 'GET', url: '/api/knowledge-bases' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, [{ id: kbId, name: 'Visible' }]);
  await app.close();
});

test('cross-tenant document access is uniformly not found', async () => {
  const calls: unknown[][] = [];
  const app = await makeApp({
    getKnowledgeDocument: async (...args: unknown[]) => {
      calls.push(args);
      return null;
    },
    deleteKnowledgeDocument: async (...args: unknown[]) => {
      calls.push(args);
      return false;
    },
  });
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await app.inject({ method, url: `/api/knowledge-bases/${kbId}/documents/${documentId}` });
    assert.equal(response.statusCode, 404);
  }
  assert.equal(calls.every((args) => (args[0] as { tenantId: string }).tenantId === tenantId && (args[0] as { userId: string }).userId === userId), true);
  await app.close();
  assert.notEqual(otherTenantId, tenantId);
});

test('upload rejects documents over the configured limit', async () => {
  const app = await makeApp({
    createDocumentUpload: async () => { throw new Error('must not create'); },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: { name: 'large.md', mime: 'text/markdown', sizeBytes: 11, sha256: 'a'.repeat(64) },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('confirm verifies object size and enqueues one active index job', async () => {
  let adds = 0;
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  const queue = { add: async () => { adds += 1; return {}; } };
  let confirms = 0;
  await registerKnowledgeRoutes(app, {
    repository: {
      getKnowledgeDocument: async () => ({ id: documentId, kbId, objectKey: 'knowledge/x.md', sizeBytes: 3, sha256: 'b'.repeat(64), status: 'pending' }),
      confirmDocumentUpload: async () => ({ created: confirms++ === 0, document: { id: documentId }, job: { id: 'job-1' } }),
    },
    artifacts: { verifyObject: async () => {} }, knowledgeQueue: queue,
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 10 },
  });
  const payload = { sizeBytes: 3, sha256: 'b'.repeat(64) };
  assert.equal((await app.inject({ method: 'POST', url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, payload })).statusCode, 200);
  assert.equal(adds, 1);
  await app.close();
});
