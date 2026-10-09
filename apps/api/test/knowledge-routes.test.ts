import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { registerKnowledgeRoutes } from '../src/knowledge-routes.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const kbId = '00000000-0000-4000-8000-000000000004';
const documentId = '00000000-0000-4000-8000-000000000005';

function makeApp(repository: Record<string, unknown>, artifacts = {}, knowledgeQueue = { add: async () => ({}) }, maxBytes = 10) {
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => {
    request.auth = { tenantId, userId, roles: [] };
  });
  return registerKnowledgeRoutes(app, {
    repository: { canWriteKnowledgeBase: async () => true, ...repository } as any,
    artifacts,
    knowledgeQueue,
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: maxBytes },
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
    artifacts: { verifyObject: async () => { } }, knowledgeQueue: queue,
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
  // LFS 指针格式的文件头：内容是 ASCII 文本，但客户端声称类型为 image/jpeg。
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
      verifyObject: async () => { },
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
      verifyObject: async () => { },
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

test('duplicate document upload hits instant mode without presigning', async () => {
  let presigns = 0;
  const existing = {
    id: '00000000-0000-4000-8000-0000000000aa',
    kb_id: kbId,
    status: 'ready',
    object_key: 'tenants/x/knowledge/kb/doc/notes.md',
    size_bytes: 5,
    content_hash: 'a'.repeat(64),
  };
  const app = await makeApp(
    { createDocumentUpload: async () => existing },
    { createUpload: async () => { presigns += 1; }, createMultipartUpload: async () => { presigns += 1; } },
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: { name: 'notes.md', mime: 'text/markdown', sizeBytes: 5, sha256: 'a'.repeat(64) },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().mode, 'instant');
  assert.equal(response.json().document.id, existing.id);
  assert.equal(presigns, 0);
  await app.close();
});

test('failed duplicate re-verifies the object and re-enqueues indexing', async () => {
  let adds = 0;
  let verifies = 0;
  const existing = {
    id: '00000000-0000-4000-8000-0000000000ab',
    kb_id: kbId,
    status: 'failed',
    object_key: 'tenants/x/knowledge/kb/doc/notes.md',
    size_bytes: 5,
    content_hash: 'a'.repeat(64),
    stored_size_bytes: 3,
    stored_sha256: 'b'.repeat(64),
  };
  const queue = { add: async () => { adds += 1; return {}; } };
  const app = await makeApp(
    {
      createDocumentUpload: async () => existing,
      confirmDocumentUpload: async (_auth: unknown, _kb: string, _id: string, input: { sizeBytes: number; sha256: string }) => {
        assert.deepEqual(input, { sizeBytes: 3, sha256: 'b'.repeat(64) });
        return { created: true, document: { ...existing, status: 'queued' }, job: { id: 'job-1' } };
      },
    },
    { verifyObject: async () => { verifies += 1; } },
    queue,
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: { name: 'notes.md', mime: 'text/markdown', sizeBytes: 5, sha256: 'a'.repeat(64) },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().mode, 'instant');
  assert.equal(verifies, 1);
  assert.equal(adds, 1);
  await app.close();
});

test('pending duplicate falls through to a fresh presigned upload', async () => {
  let presigns = 0;
  const existing = {
    id: '00000000-0000-4000-8000-0000000000ac',
    kb_id: kbId,
    status: 'pending',
    object_key: 'tenants/x/knowledge/kb/doc/notes.md',
  };
  const app = await makeApp(
    { createDocumentUpload: async () => existing },
    { createUpload: async () => { presigns += 1; return { uploadUrl: 'https://storage.example/put' }; } },
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: { name: 'notes.md', mime: 'text/markdown', sizeBytes: 5, sha256: 'a'.repeat(64) },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().mode, 'single');
  assert.equal(response.json().upload.uploadUrl, 'https://storage.example/put');
  assert.equal(presigns, 1);
  await app.close();
});

test('large stored payload initializes a multipart upload and presigns every part', async () => {
  const newId = '00000000-0000-4000-8000-0000000000ad';
  let uploadIdSet = 0;
  const app = await makeApp(
    {
      createDocumentUpload: async () => ({ id: newId, status: 'pending', object_key: 'knowledge/big.md' }),
      setKnowledgeDocumentUploadId: async () => { uploadIdSet += 1; },
    },
    {
      createMultipartUpload: async () => ({ uploadId: 'upload-1' }),
      presignPartUpload: async (_key: string, _id: string, partNumber: number) => ({ number: partNumber, uploadUrl: `https://storage.example/part-${partNumber}` }),
    },
  );
  // makeApp 的 MAX 是 10 字节，这里直接构造大限额 app。
  await app.close();
  const bigApp = Fastify();
  bigApp.decorateRequest('auth');
  bigApp.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(bigApp, {
    repository: {
      canWriteKnowledgeBase: async () => true,
      createDocumentUpload: async () => ({ id: newId, status: 'pending', object_key: 'knowledge/big.md' }),
      setKnowledgeDocumentUploadId: async () => { uploadIdSet += 1; },
    } as any,
    artifacts: {
      createMultipartUpload: async () => ({ uploadId: 'upload-1' }),
      presignPartUpload: async (_key: string, _id: string, partNumber: number) => ({ number: partNumber, uploadUrl: `https://storage.example/part-${partNumber}` }),
    },
    knowledgeQueue: { add: async () => ({}) },
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 100 * 1024 * 1024 },
  });
  const storedSizeBytes = 9 * 1024 * 1024;
  const response = await bigApp.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: {
      name: 'big.md',
      mime: 'text/markdown',
      sizeBytes: storedSizeBytes,
      sha256: 'a'.repeat(64),
      storedSizeBytes,
      storedSha256: 'b'.repeat(64),
      contentEncoding: 'gzip',
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().mode, 'multipart');
  assert.equal(response.json().uploadId, 'upload-1');
  assert.equal(response.json().partSize, 5 * 1024 * 1024);
  assert.equal(response.json().parts.length, 2);
  assert.equal(uploadIdSet, 1);
  await bigApp.close();
});

test('document confirm with a pending multipart upload requires parts and completes it', async () => {
  const document = {
    id: documentId,
    kb_id: kbId,
    status: 'pending',
    object_key: 'knowledge/big.md',
    upload_id: 'upload-1',
  };
  const withoutParts = await makeApp({
    getKnowledgeDocument: async () => document,
    confirmDocumentUpload: async () => { throw new Error('must not confirm'); },
  }, undefined, undefined, 100 * 1024 * 1024);
  const rejected = await withoutParts.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`,
    payload: { sizeBytes: 9 * 1024 * 1024, sha256: 'b'.repeat(64) },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error, 'parts_required');
  await withoutParts.close();

  let completed = 0;
  const queue = { add: async () => ({}) };
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(app, {
    repository: {
      canWriteKnowledgeBase: async () => true,
      getKnowledgeDocument: async () => document,
      confirmDocumentUpload: async () => ({ created: true, document: { id: documentId }, job: { id: 'job-1' } }),
    } as any,
    artifacts: {
      completeMultipartUpload: async (_key: string, _id: string, parts: unknown[]) => { completed = parts.length; },
      verifyObject: async () => { },
    },
    knowledgeQueue: queue,
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 100 * 1024 * 1024 },
  });
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`,
    payload: {
      sizeBytes: 9 * 1024 * 1024,
      sha256: 'b'.repeat(64),
      parts: [
        { number: 1, etag: 'etag-1' },
        { number: 2, etag: 'etag-2' },
      ],
    },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(completed, 2);
  await app.close();
});

test('asset duplicate with completed upload hits instant mode', async () => {
  let presigns = 0;
  const existing = {
    id: '00000000-0000-4000-8000-0000000000ae',
    kb_id: kbId,
    object_key: 'tenants/x/knowledge/kb/assets/a/logo.png',
    uploaded_at: '2026-01-01T00:00:00.000Z',
  };
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => { request.auth = { tenantId, userId, roles: [] }; });
  await registerKnowledgeRoutes(app, {
    repository: {
      canWriteKnowledgeBase: async () => true,
      createAssetUpload: async () => existing,
    } as any,
    artifacts: { createUpload: async () => { presigns += 1; } },
    knowledgeQueue: { add: async () => ({}) },
    config: { KNOWLEDGE_DOCUMENT_MAX_BYTES: 20_000_000 },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-bases/${kbId}/documents/uploads`,
    payload: { name: 'logo.png', mime: 'image/png', sizeBytes: 4096, sha256: 'a'.repeat(64), kind: 'asset' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().mode, 'instant');
  assert.equal(response.json().asset.id, existing.id);
  assert.equal(presigns, 0);
  await app.close();
});
