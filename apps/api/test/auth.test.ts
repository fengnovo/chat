import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  AuthenticationError,
  ForbiddenError,
  SESSION_COOKIE_NAME,
  createAuthenticator,
  requireAdmin,
  signSessionToken,
} from '../src/auth.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-0000000000a2';

function passwordConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'password',
    AUTH_JWT_SECRET: 'unit-test-secret-unit-test-secret-0000',
  });
}

test('password authenticator accepts a signed session cookie and loads the live role', async () => {
  const config = passwordConfig();
  const token = await signSessionToken(config, {
    userId,
    tenantId,
    role: 'member',
  });
  const memberships = new Map([[`${tenantId}:${userId}`, 'admin']]);
  const authenticate = createAuthenticator(config, {
    loadMembership: async (t, u) => memberships.get(`${t}:${u}`) ?? null,
  });
  const auth = await authenticate({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
  assert.equal(auth.tenantId, tenantId);
  assert.equal(auth.userId, userId);
  // 角色来自数据库 membership 而不是 Token claims，改角色即时生效。
  assert.deepEqual(auth.roles, ['admin']);
});

test('password authenticator also accepts the Bearer header form', async () => {
  const config = passwordConfig();
  const token = await signSessionToken(config, {
    userId,
    tenantId,
    role: 'owner',
  });
  const authenticate = createAuthenticator(config, {
    loadMembership: async () => 'owner',
  });
  const auth = await authenticate({ authorization: `Bearer ${token}` });
  assert.deepEqual(auth.roles, ['owner']);
});

test('password authenticator rejects missing, tampered and membership-less tokens', async () => {
  const config = passwordConfig();
  const authenticate = createAuthenticator(config, {
    loadMembership: async () => null,
  });
  await assert.rejects(() => authenticate({}), AuthenticationError);
  await assert.rejects(
    () => authenticate({ cookie: `${SESSION_COOKIE_NAME}=not-a-jwt` }),
    AuthenticationError,
  );
  const token = await signSessionToken(config, { userId, tenantId, role: 'owner' });
  await assert.rejects(
    () => authenticate({ authorization: `Bearer ${token}` }),
    AuthenticationError,
  );

  const otherSecret = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'password',
    AUTH_JWT_SECRET: 'another-secret-another-secret-000000',
  });
  const foreign = await signSessionToken(otherSecret, {
    userId,
    tenantId,
    role: 'owner',
  });
  await assert.rejects(
    () => authenticate({ authorization: `Bearer ${foreign}` }),
    AuthenticationError,
  );
});

test('password mode requires AUTH_JWT_SECRET at startup and sign time', async () => {
  assert.throws(
    () =>
      createAuthenticator(
        { ...passwordConfig(), AUTH_JWT_SECRET: undefined } as ReturnType<typeof loadConfig>,
      ),
    /AUTH_JWT_SECRET/,
  );
  await assert.rejects(
    () =>
      signSessionToken(
        { ...passwordConfig(), AUTH_JWT_SECRET: undefined } as ReturnType<typeof loadConfig>,
        { userId, tenantId, role: 'owner' },
      ),
    /AUTH_JWT_SECRET/,
  );
});

test('requireAdmin allows only the admin role', () => {
  assert.doesNotThrow(() => requireAdmin({ tenantId, userId, roles: ['admin'] }));
  assert.throws(() => requireAdmin({ tenantId, userId, roles: ['owner'] }), ForbiddenError);
  assert.throws(() => requireAdmin({ tenantId, userId, roles: ['member'] }), ForbiddenError);
  assert.throws(() => requireAdmin({ tenantId, userId, roles: [] }), ForbiddenError);
});
