import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AuthContext } from '@repo/contracts';

import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME, signSessionToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const attachmentId = '00000000-0000-4000-8000-000000000004';
const url = `/api/agent/chat-attachments/${attachmentId}/content`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t: test.TestContext, options: {
  status?: string;
  contentType?: string;
  bytes?: Buffer;
  contentEncoding?: string;
} = {}) {
  const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'password', CAPTION_ENABLED: 'false',
    AUTH_JWT_SECRET: 'attachment-auth-test-secret-00000000000000' });
  const bytes = options.bytes ?? png;
  const objectKey = 'tenants/owner/private-image.png';
  let reads = 0;
  const queue = { close: async () => {} };
  const app = await buildApp({
    config,
    repository: {
      getMembershipRole: async () => 'member', ensureIdentity: async () => {},
      requeueStaleDispatches: async () => 0, claimDispatches: async () => [],
      getChatAttachment: async (auth: AuthContext, id: string) =>
        auth.tenantId === tenantId && auth.userId === userId && id === attachmentId
          ? { id, objectKey, status: options.status ?? 'ready', filename: '图片.png',
              contentType: options.contentType ?? 'image/png', contentEncoding: options.contentEncoding ?? null }
          : null,
    } as never,
    queue: queue as never, knowledgeQueue: queue as never, memoryIndexQueue: queue as never,
    publisher: { quit: async () => {}, eval: async () => [1, 1000] } as never,
    knowledgeRepository: {} as never,
    artifacts: {
      ensureBucket: async () => {}, destroy() {},
      createDownloadUrl: async () => 'https://storage.example/private-image?X-Amz-Signature=secret',
      getObjectStream: async (key: string) => {
        assert.equal(key, objectKey);
        reads++;
        return { body: Readable.from([bytes]), contentLength: bytes.length,
          ...(options.contentEncoding ? { contentEncoding: options.contentEncoding } : {}) };
      },
    } as never,
  });
  t.after(() => app.close());
  const tokenFor = (tenant = tenantId, user = userId) => signSessionToken(config, { tenantId: tenant, userId: user, role: 'member' });
  return { app, tokenFor, reads: () => reads };
}

test('owner Bearer and H5 cookie receive image bytes without an object-storage redirect', async (t) => {
  const { app, tokenFor } = await fixture(t);
  const token = await tokenFor();
  for (const headers of [{ authorization: `Bearer ${token}` }, { cookie: `${SESSION_COOKIE_NAME}=${token}` }]) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, png);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

test('a copied content URL requires authentication and rejects other owners and tenants', async (t) => {
  const { app, tokenFor, reads } = await fixture(t);
  assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
  for (const token of [await tokenFor(tenantId, otherId), await tokenFor(otherId, userId)]) {
    const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers.location, undefined);
  }
  assert.equal(reads(), 0);
});

test('pending uploads cannot be read', async (t) => {
  const { app, tokenFor, reads } = await fixture(t, { status: 'uploading' });
  const response = await app.inject({ url, headers: { authorization: `Bearer ${await tokenFor()}` } });
  assert.equal(response.statusCode, 409);
  assert.equal(reads(), 0);
});

test('compressed text retains storage encoding and downloads instead of executing on the API origin', async (t) => {
  const bytes = gzipSync('<script>private file</script>');
  const { app, tokenFor } = await fixture(t, { contentType: 'text/html', bytes, contentEncoding: 'gzip' });
  const response = await app.inject({ url, headers: { authorization: `Bearer ${await tokenFor()}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.headers['content-length'], String(bytes.length));
  assert.match(String(response.headers['content-disposition']), /^attachment;/);
  assert.deepEqual(gunzipSync(response.rawPayload), Buffer.from('<script>private file</script>'));
});
