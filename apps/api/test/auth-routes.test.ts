import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';

import { registerAuthRoutes } from '../src/auth-routes.js';
import { SESSION_COOKIE_NAME } from '../src/auth.js';
import type { ApiConfig } from '../src/config.js';
import { RepositoryConflictError, type AgentRepository } from '@repo/db';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-0000000000a1';

function makeConfig(): ApiConfig {
  return {
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    AUTH_JWT_SECRET: 'unit-test-secret-unit-test-secret-0000',
  } as ApiConfig;
}

function signupConfig(overrides: Record<string, unknown> = {}): ApiConfig {
  return {
    NODE_ENV: 'test',
    AUTH_MODE: 'password',
    AUTH_JWT_SECRET: 'unit-test-secret-unit-test-secret-0000',
    SIGNUP_TENANT_ID: tenantId,
    SIGNUP_ENABLED: true,
    ...overrides,
  } as ApiConfig;
}

function makeApp(repository: Record<string, unknown>, config: ApiConfig = makeConfig()) {
  const app = Fastify();
  void app.register(cookie);
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => {
    request.auth = { tenantId, userId, roles: ['admin'] };
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (error instanceof RepositoryConflictError) {
      return reply.code(409).send({ error: error.code });
    }
    return reply.code(500).send({ error: 'internal_error' });
  });
  return registerAuthRoutes(app, {
    config,
    repository: repository as unknown as AgentRepository,
  }).then(() => app);
}

test('login rejects a wrong password without revealing the user', async () => {
  const { hashPassword } = await import('@repo/db');
  const stored = await hashPassword('admin123');
  const app = await makeApp({
    findUserForLogin: async (username: string) =>
      username === 'admin'
        ? {
            id: userId,
            displayName: '超级管理员',
            passwordHash: stored,
            tenantId,
            role: 'admin',
          }
        : null,
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'wrong-password' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'invalid_credentials');
  await app.close();
});

test('login with correct credentials returns the user and cookie', async () => {
  const { hashPassword } = await import('@repo/db');
  const stored = await hashPassword('admin123');
  const app = await makeApp({
    findUserForLogin: async () => ({
      id: userId,
      displayName: '超级管理员',
      passwordHash: stored,
      tenantId,
      role: 'admin',
    }),
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'admin123' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.role, 'admin');
  assert.equal(response.json().user.tenantId, tenantId);
  const setCookie = response.cookies.find(
    (entry) => entry.name === SESSION_COOKIE_NAME,
  );
  assert.ok(setCookie);
  assert.equal(setCookie.httpOnly, true);
  assert.ok(setCookie.value.split('.').length === 3, 'cookie carries a JWT');
  await app.close();
});

test('unknown user and empty payload both fail closed', async () => {
  const app = await makeApp({
    findUserForLogin: async () => null,
  });
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'ghost', password: 'whatever-123' },
  });
  assert.equal(unknown.statusCode, 401);
  const empty = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {},
  });
  assert.equal(empty.statusCode, 400);
  await app.close();
});

test('logout clears the session cookie', async () => {
  const app = await makeApp({});
  const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(response.statusCode, 200);
  const cleared = response.cookies.find(
    (entry) => entry.name === SESSION_COOKIE_NAME,
  );
  assert.ok(cleared);
  assert.equal(cleared.value, '');
  await app.close();
});

test('/api/auth/me resolves the display name from the repository', async () => {
  const app = await makeApp({
    getUserDisplayName: async (tenant: string, user: string) =>
      tenant === tenantId && user === userId ? '超级管理员' : null,
  });
  const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().user, {
    id: userId,
    displayName: '超级管理员',
    role: 'admin',
    tenantId,
    authMode: 'dev',
  });
  await app.close();
});

test('register creates a member in the signup tenant and starts a session', async () => {
  const creates: Array<Record<string, unknown>> = [];
  const app = await makeApp(
    {
      createTenantUser: async (tenant: string, input: Record<string, unknown>) => {
        creates.push({ tenant, ...input });
        return {
          id: '00000000-0000-4000-8000-0000000000c9',
          username: input.username,
          displayName: input.displayName,
          role: input.role,
        };
      },
    },
    signupConfig(),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username: 'newcomer',
      displayName: '新同学',
      password: 'a-good-password',
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().user, {
    id: '00000000-0000-4000-8000-0000000000c9',
    displayName: '新同学',
    role: 'member',
    tenantId,
  });
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.tenant, tenantId);
  assert.equal(creates[0]!.role, 'member');
  assert.match(String(creates[0]!.passwordHash), /^scrypt\$/);
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE_NAME);
  assert.ok(cookie);
  assert.equal(cookie.httpOnly, true);
  await app.close();
});

test('register is forbidden in dev mode or when signup is disabled', async () => {
  for (const config of [
    makeConfig(),
    signupConfig({ SIGNUP_ENABLED: false }),
    signupConfig({ AUTH_MODE: 'oidc' }),
  ]) {
    const app = await makeApp({}, config);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'newcomer',
        displayName: '新同学',
        password: 'a-good-password',
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'signup_disabled');
    await app.close();
  }
});

test('register maps a duplicate username to 409 and rejects malformed input', async () => {
  const duplicate = await makeApp(
    {
      createTenantUser: async () => {
        throw new RepositoryConflictError('username_taken');
      },
    },
    signupConfig(),
  );
  const conflict = await duplicate.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username: 'admin',
      displayName: '撞名',
      password: 'a-good-password',
    },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'username_taken');
  await duplicate.close();

  const invalid = await makeApp(
    {
      createTenantUser: async () => {
        throw new Error('must not create');
      },
    },
    signupConfig(),
  );
  for (const payload of [
    { username: 'ab', displayName: 'x', password: 'a-good-password' },
    { username: 'has space', displayName: 'x', password: 'a-good-password' },
    { username: 'newcomer', displayName: 'x', password: 'short' },
    { username: 'newcomer', displayName: 'x' },
  ]) {
    const response = await invalid.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  await invalid.close();
});

test('change password is unavailable outside password auth mode', async () => {
  const app = await makeApp({}, makeConfig());
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    payload: { currentPassword: 'whatever-1', newPassword: 'a-new-password' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'password_change_unavailable');
  await app.close();
});

test('change password rejects a wrong current password', async () => {
  const { hashPassword } = await import('@repo/db');
  const stored = await hashPassword('old-password-1');
  let updated = false;
  const app = await makeApp(
    {
      getUserPasswordHash: async (tenant: string, user: string) =>
        tenant === tenantId && user === userId ? stored : null,
      updateTenantUser: async () => {
        updated = true;
        return null;
      },
    },
    signupConfig(),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    payload: { currentPassword: 'wrong-password', newPassword: 'a-new-password' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'invalid_current_password');
  assert.equal(updated, false);
  await app.close();
});

test('change password persists the new hash after verifying the current one', async () => {
  const { hashPassword, verifyPassword } = await import('@repo/db');
  const stored = await hashPassword('old-password-1');
  const patches: Array<Record<string, unknown>> = [];
  const app = await makeApp(
    {
      getUserPasswordHash: async () => stored,
      updateTenantUser: async (tenant: string, user: string, patch: Record<string, unknown>) => {
        patches.push({ tenant, user, ...patch });
        return { id: user, username: 'self', displayName: '本人', role: 'member' };
      },
    },
    signupConfig(),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    payload: { currentPassword: 'old-password-1', newPassword: 'brand-new-password-2' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.tenant, tenantId);
  assert.equal(patches[0]!.user, userId);
  assert.match(String(patches[0]!.passwordHash), /^scrypt\$/);
  assert.equal(
    await verifyPassword('brand-new-password-2', String(patches[0]!.passwordHash)),
    true,
  );
  await app.close();
});

test('change password rejects same, short, or missing new passwords', async () => {
  const { hashPassword } = await import('@repo/db');
  const stored = await hashPassword('old-password-1');
  const app = await makeApp(
    {
      getUserPasswordHash: async () => stored,
      updateTenantUser: async () => {
        throw new Error('must not update');
      },
    },
    signupConfig(),
  );
  for (const payload of [
    { currentPassword: 'old-password-1', newPassword: 'old-password-1' },
    { currentPassword: 'old-password-1', newPassword: 'short' },
    { currentPassword: 'old-password-1' },
    {},
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  await app.close();
});

test('change password fails closed when the account has no password credential', async () => {
  const app = await makeApp(
    {
      getUserPasswordHash: async () => null,
      updateTenantUser: async () => {
        throw new Error('must not update');
      },
    },
    signupConfig(),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    payload: { currentPassword: 'old-password-1', newPassword: 'a-new-password' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'password_change_unavailable');
  await app.close();
});
