import assert from 'node:assert/strict';
import test from 'node:test';

import { isKnowledgeUploadPath, resolveRateLimit } from '../src/rate-limit.js';

const identity = { tenantId: 'tenant-1', userId: 'user-1' };
const limits = { RATE_LIMIT_REQUESTS: 300, KNOWLEDGE_UPLOAD_RATE_LIMIT_REQUESTS: 3_000 };
const kbId = '00000000-0000-4000-8000-000000000004';
const documentId = '00000000-0000-4000-8000-000000000005';
const assetId = '00000000-0000-4000-8000-000000000006';

test('knowledge ingest traffic uses a dedicated, more generous bucket', () => {
  for (const pathname of [
    `/api/knowledge-bases/${kbId}/documents/uploads`,
    `/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`,
    `/api/knowledge-bases/${kbId}/assets/${assetId}/confirm`,
    // 整目录导入期间被高频调用的列表接口，与预签名 / 确认走同一桶，避免吃交互式配额。
    `/api/knowledge-bases/${kbId}/documents`,
    `/api/knowledge-bases/${kbId}/assets`,
  ]) {
    assert.equal(isKnowledgeUploadPath(pathname), true, pathname);
    assert.deepEqual(resolveRateLimit(pathname, identity, limits), {
      key: 'rate:knowledge-upload:tenant-1:user-1',
      limit: 3_000,
    });
  }
});

test('interactive knowledge traffic keeps the default bucket', () => {
  for (const pathname of [
    '/api/knowledge-bases',
    `/api/knowledge-bases/${kbId}/documents/${documentId}`,
    `/api/knowledge-bases/${kbId}/documents/${documentId}/chunks`,
    `/api/knowledge-bases/${kbId}/assets/${assetId}/content`,
    `/api/knowledge-bases/${kbId}/assets/${assetId}`,
    `/api/knowledge-bases/${kbId}/retrieval`,
    '/api/agent/sessions',
    '/health/ready',
  ]) {
    assert.equal(isKnowledgeUploadPath(pathname), false, pathname);
    assert.deepEqual(resolveRateLimit(pathname, identity, limits), {
      key: 'rate:api:tenant-1:user-1',
      limit: 300,
    });
  }
});

test('upload buckets stay isolated per tenant and per user', () => {
  const pathname = `/api/knowledge-bases/${kbId}/documents/uploads`;
  const keys = [
    resolveRateLimit(pathname, identity, limits).key,
    resolveRateLimit(pathname, { tenantId: 'tenant-2', userId: 'user-1' }, limits).key,
    resolveRateLimit(pathname, { tenantId: 'tenant-1', userId: 'user-2' }, limits).key,
  ];
  assert.equal(new Set(keys).size, 3);
});
