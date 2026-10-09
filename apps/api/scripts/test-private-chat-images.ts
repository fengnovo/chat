/** Local HTTP + JWT + PostgreSQL + MinIO integration; not a native UI E2E. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { S3ArtifactStore } from '@repo/artifacts';
import { createDatabase } from '@repo/db';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME, signSessionToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ ...process.env, NODE_ENV: 'test', AUTH_MODE: 'password',
  CAPTION_ENABLED: 'false', AUTH_JWT_SECRET: randomBytes(32).toString('hex') });
// This script creates and deletes its own identities and objects. Never target production.
for (const endpoint of [config.DATABASE_URL, config.S3_ENDPOINT]) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname), 'Only loopback test services are allowed');
}
const source = process.argv[2];
const bytes = source ? await readFile(source) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const filename = source ? path.basename(source) : 'private-image.png';
const contentType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
const sha256 = createHash('sha256').update(bytes).digest('hex');
const database = createDatabase(config.DATABASE_URL);
const repository = database.repository;
const artifacts = new S3ArtifactStore({ endpoint: config.S3_ENDPOINT, publicEndpoint: config.S3_ENDPOINT,
  region: config.S3_REGION, bucket: config.S3_BUCKET, accessKey: config.S3_ACCESS_KEY, secretKey: config.S3_SECRET_KEY });
const owner = { tenantId: randomUUID(), userId: randomUUID(), roles: ['member'] };
const otherUser = { ...owner, userId: randomUUID() };
const otherTenant = { tenantId: randomUUID(), userId: randomUUID(), roles: ['member'] };
const identities = [owner, otherUser, otherTenant];
const objectKeys: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  for (const identity of identities) await repository.ensureIdentity(identity);
  const queue = { close: async () => {} };
  // Leave pre-existing local runs alone; only the upload/read path uses the real repository.
  const apiRepository = new Proxy(repository, {
    get(target, key) {
      if (key === 'claimDispatches') return async () => [];
      if (key === 'requeueStaleDispatches') return async () => 0;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  app = await buildApp({ config, repository: apiRepository, artifacts,
    queue: queue as never, knowledgeQueue: queue as never, memoryIndexQueue: queue as never,
    publisher: { quit: async () => {}, eval: async () => [1, 1000] } as never,
    knowledgeRepository: {} as never });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const tokens = await Promise.all(identities.map((identity) => signSessionToken(config, { ...identity, role: 'member' })));
  const headers = { authorization: `Bearer ${tokens[0]}` };
  const initResponse = await fetch(`${address}/api/agent/chat-attachments`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ filename, contentType, sizeBytes: bytes.length,
      storedSizeBytes: bytes.length, contentSha256: sha256, storedSha256: sha256 }) });
  assert.equal(initResponse.status, 201);
  const init = await initResponse.json() as { attachment: { id: string }; uploadUrl: string; headers: Record<string, string> };
  const attachment = await repository.getChatAttachment(owner, init.attachment.id);
  assert.ok(attachment);
  objectKeys.push(attachment.objectKey);
  const contentUrl = `${address}/api/agent/chat-attachments/${attachment.id}/content`;
  assert.equal((await fetch(contentUrl, { headers })).status, 409);
  const uploaded = await fetch(init.uploadUrl, { method: 'PUT', headers: init.headers, body: bytes });
  assert.equal(uploaded.status, 200);
  const complete = await fetch(`${address}/api/agent/chat-attachments/${attachment.id}/complete`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(complete.status, 200);
  for (const credentials of [headers, { cookie: `${SESSION_COOKIE_NAME}=${tokens[0]}` }]) {
    const image = await fetch(contentUrl, { headers: credentials, redirect: 'manual' });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('location'), null);
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
    assert.equal(image.headers.get('content-type'), contentType);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  }
  assert.equal((await fetch(contentUrl)).status, 401);
  assert.equal((await fetch(contentUrl, { headers: { authorization: 'Bearer invalid' } })).status, 401);
  for (const token of tokens.slice(1)) {
    assert.equal((await fetch(contentUrl, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  }
  const unsignedObjectUrl = `${config.S3_ENDPOINT}/${config.S3_BUCKET}/${attachment.objectKey}`;
  assert.equal((await fetch(unsignedObjectUrl)).status, 403);
  const copiedWithBearer = await fetch(unsignedObjectUrl, { headers });
  assert.ok(copiedWithBearer.status >= 400, 'App Bearer cannot authorize direct object storage access');
  console.log(JSON.stringify({ result: 'passed', filename, bytes: bytes.length, contentType,
    checks: ['real upload + complete', 'owner Bearer 200', 'H5 cookie 200', 'exact image bytes',
      'no redirect', 'private no-store', 'no auth 401', 'invalid token 401',
      'other owner 404', 'other tenant 404', 'unsigned object 403', 'pending 409'] }));
} finally {
  for (const objectKey of objectKeys) await artifacts.deleteObject(objectKey);
  if (app) await app.close(); else artifacts.destroy();
  for (const identity of identities) {
    await database.pool.query('DELETE FROM chat_attachments WHERE tenant_id = $1 AND user_id = $2', [identity.tenantId, identity.userId]);
    await database.pool.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [identity.tenantId, identity.userId]);
  }
  await database.pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[owner.tenantId, otherTenant.tenantId]]);
  await database.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [identities.map((identity) => identity.userId)]);
  await repository.close();
}
