import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { registerKnowledgeRoutes } from '../src/knowledge-routes.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const kbId = '00000000-0000-4000-8000-000000000004';
const documentId = '00000000-0000-4000-8000-000000000005';

function makeApp(repository: Record<string, unknown>, artifacts = {}, knowledgeQueue = { add: async () => ({}) }) {
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => {
    request.auth = { tenantId, userId, roles: [] };
  });
  return registerKnowledgeRoutes(app, {
    repository: { canWriteKnowledgeBase: async () => true, ...repository } as any,
    artifacts,
    knowledgeQueue,
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
      canWriteKnowledgeBase: async () => true,
      getKnowledgeDocument: async () => ({ id: documentId, kbId, objectKey: 'knowledge/x.md', sizeBytes: 3, sha256: 'b'.repeat(64), status: 'pending' }),
      confirmDocumentUpload: async () => ({ created: confirms++ === 0, document: { id: documentId }, job: { id: 'job-1' } }),
    } as any,
    artifacts: { verifyObject: async () => {} }, knowledgeQueue: queue,
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 10 },
  });
  const payload = { sizeBytes: 3, sha256: 'b'.repeat(64) };
  assert.equal((await app.inject({ method: 'POST', url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, payload })).statusCode, 200);
  assert.equal(adds, 1);
  await app.close();
});

test('regular member cannot upload or confirm an existing tenant-visible KB', async () => {
  let presigns = 0;
  let verifies = 0;
  let adds = 0;
  const queue = { adds: [] as unknown[], add: async (...args: unknown[]) => { queue.adds.push(args); return {}; } };
  const kb = { id: kbId, tenantId, visibility: 'tenant', ownerUserId: 'different-owner' };
  let createdDocuments = 0;
  let confirmedDocuments = 0;
  const app = await makeApp({
    listKnowledgeBases: async () => [kb],
    getKnowledgeBase: async () => kb,
    canWriteKnowledgeBase: async (auth: { userId: string; roles: string[] }) => kb.ownerUserId === auth.userId || auth.roles.some((role) => role === 'owner' || role === 'admin'),
    createDocumentUpload: async () => { createdDocuments += 1; throw new Error('must not create'); },
    getKnowledgeDocument: async () => ({ id: documentId, kbId, objectKey: 'knowledge/x.md' }),
    confirmDocumentUpload: async () => { confirmedDocuments += 1; throw new Error('must not confirm'); },
  }, { createUpload: async () => { presigns += 1; }, verifyObject: async () => { verifies += 1; } }, queue);
  const upload = await app.inject({ method: 'POST', url: `/api/knowledge-bases/${kbId}/documents/uploads`, payload: { name: 'x.md', mime: 'text/markdown', sizeBytes: 1, sha256: 'a'.repeat(64) } });
  const confirm = await app.inject({ method: 'POST', url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, payload: { sizeBytes: 1, sha256: 'a'.repeat(64) } });
  assert.equal(upload.statusCode, 404);
  assert.equal(confirm.statusCode, 404);
  assert.equal(presigns + verifies + adds, 0);
  assert.equal(createdDocuments + confirmedDocuments + queue.adds.length, 0);
  await app.close();
});

test('updating a knowledge base forwards editable fields and 404s without write access', async () => {
  const calls: unknown[][] = [];
  const app = await makeApp({
    updateKnowledgeBase: async (...args: unknown[]) => {
      calls.push(args);
      return { id: kbId, name: '改名后的知识库' };
    },
  });
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/knowledge-bases/${kbId}`,
    payload: { name: '改名后的知识库', description: '新描述' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().name, '改名后的知识库');
  assert.equal((calls[0]?.[2] as { name: string }).name, '改名后的知识库');

  const missingApp = await makeApp({
    updateKnowledgeBase: async () => null,
  });
  const missing = await missingApp.inject({
    method: 'PATCH',
    url: `/api/knowledge-bases/${kbId}`,
    payload: { name: 'x' },
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
  await missingApp.close();
});

test('chunk listing requires read access on the parent document', async () => {
  const app = await makeApp({
    getKnowledgeDocument: async () => ({ id: documentId, kbId }),
    listDocumentChunks: async () => ({ rows: [{ id: 'chunk-1', ordinal: 0 }], total: 1 }),
  });
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-bases/${kbId}/documents/${documentId}/chunks?q=小米`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().total, 1);
  assert.deepEqual(response.json().data, [{ id: 'chunk-1', ordinal: 0 }]);
  await app.close();
});

test('retrieval and ask report 503 when the knowledge service is not configured', async () => {
  const app = await makeApp({
    getKnowledgeBase: async () => ({ id: kbId }),
  });
  const retrieval = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/retrieval`,
    payload: { query: '小王卖什么手机' },
  });
  assert.equal(retrieval.statusCode, 503);
  assert.equal(retrieval.json().error, 'knowledge_service_unavailable');

  const ask = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/ask`,
    payload: { question: '小王卖什么手机' },
  });
  assert.equal(ask.statusCode, 503);
  assert.equal(ask.json().error, 'knowledge_qa_unavailable');
  await app.close();
});

test('retrieval returns 502 with structured error when knowledge-service call fails', async () => {
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(app, {
    repository: {
      getKnowledgeBase: async () => ({ id: kbId, tenantId, visibility: 'tenant', ownerUserId: userId }),
    } as any,
    artifacts: {},
    knowledgeQueue: { add: async () => ({}) },
    config: {
      KNOWLEDGE_DOCUMENT_MAX_BYTES: 10,
      KNOWLEDGE_MCP: { url: 'http://127.0.0.1:1/mcp', secret: 'test-secret', timeoutMs: 500 },
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/retrieval`,
    payload: { query: 'test query' },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, 'knowledge_retrieval_failed');
  assert.ok(typeof response.json().message === 'string');
  await app.close();
});

test('document rename returns the updated row or 404', async () => {
  const app = await makeApp({
    renameKnowledgeDocument: async () => ({ id: documentId, name: 'renamed.md' }),
  });
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/knowledge-bases/${kbId}/documents/${documentId}`,
    payload: { name: 'renamed.md' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().name, 'renamed.md');

  const missingApp = await makeApp({ renameKnowledgeDocument: async () => null });
  const missing = await missingApp.inject({
    method: 'PATCH',
    url: `/api/knowledge-bases/${kbId}/documents/${documentId}`,
    payload: { name: 'renamed.md' },
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
  await missingApp.close();
});

test('asset upload rejects payloads below the LFS-pointer floor (1024 bytes)', async () => {
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(app, {
    repository: {
      canWriteKnowledgeBase: async () => true,
      createAssetUpload: async () => { throw new Error('must not create'); },
    } as any,
    artifacts: {},
    knowledgeQueue: { add: async () => ({}) },
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 20_000_000 },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: { name: 'fake.jpeg', mime: 'image/jpeg', sizeBytes: 131, sha256: 'a'.repeat(64), kind: 'asset' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'asset_too_small');
  await app.close();
});

test('asset confirm rejects when uploaded bytes do not match declared MIME', async () => {
  const assetRow = {
    id: '00000000-0000-4000-8000-000000000099',
    kbId,
    objectKey: 'tenants/x/knowledge/kb/assets/a/fake.jpeg',
    mime: 'image/jpeg',
    sizeBytes: 4096,
    sha256: 'c'.repeat(64),
    captionStatus: 'pending',
  };
  // LFS-pointer style head bytes: ASCII text but client claims image/jpeg.
  const lfsPointerHead = new Uint8Array([
    0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x20,
    0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f,
  ]);
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(app, {
    repository: {
      canWriteKnowledgeBase: async () => true,
      getKnowledgeAsset: async () => assetRow,
      confirmAssetUpload: async () => { throw new Error('must not confirm'); },
    } as any,
    artifacts: {
      verifyObject: async () => {},
      getObjectHead: async () => lfsPointerHead,
    },
    knowledgeQueue: { add: async () => ({}) },
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 20_000_000, CAPTION_ENABLED: false },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/assets/${assetRow.id}/confirm`,
    payload: { sizeBytes: 4096, sha256: assetRow.sha256 },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'asset_magic_check_failed');
  await app.close();
});

test('asset confirm accepts when uploaded bytes match declared MIME', async () => {
  const assetRow = {
    id: '00000000-0000-4000-8000-00000000009a',
    kbId,
    objectKey: 'tenants/x/knowledge/kb/assets/a/real.png',
    mime: 'image/png',
    sizeBytes: 4096,
    sha256: 'd'.repeat(64),
    captionStatus: 'pending',
  };
  const realPngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(app, {
    repository: {
      canWriteKnowledgeBase: async () => true,
      getKnowledgeAsset: async () => assetRow,
      confirmAssetUpload: async () => ({ asset: { ...assetRow, captionStatus: 'pending' } }),
      enqueueCaptionJob: async () => null,
    } as any,
    artifacts: {
      verifyObject: async () => {},
      getObjectHead: async () => realPngHead,
    },
    knowledgeQueue: { add: async () => ({}) },
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 20_000_000, CAPTION_ENABLED: false },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/assets/${assetRow.id}/confirm`,
    payload: { sizeBytes: 4096, sha256: assetRow.sha256 },
  });
  assert.equal(response.statusCode, 200);
  await app.close();
});
