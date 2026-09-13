import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { z } from 'zod';

import { registerAdminRoutes } from '../src/admin-routes.js';
import { ForbiddenError } from '../src/auth.js';
import type { AgentRepository } from '@repo/db';

const tenantId = '00000000-0000-4000-8000-000000000001';
const adminId = '00000000-0000-4000-8000-0000000000a1';
const memberId = '00000000-0000-4000-8000-0000000000a3';
const kbId = '00000000-0000-4000-8000-0000000000b1';

function makeApp(
  repository: Record<string, unknown>,
  roles: string[] = ['admin'],
) {
  const app = Fastify();
  app.decorateRequest('auth');
  app.addHook('preHandler', async (request) => {
    request.auth = { tenantId, userId: adminId, roles };
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.code(500).send({ error: 'internal_error' });
  });
  return registerAdminRoutes(app, {
    repository: repository as unknown as AgentRepository,
  }).then(() => app);
}

test('non-admin roles are forbidden from every admin route', async () => {
  const app = await makeApp({}, ['member']);
  const routes = [
    { method: 'GET', url: '/api/admin/users' },
    {
      method: 'POST',
      url: '/api/admin/users',
      payload: {
        username: 'eve',
        displayName: 'Eve',
        password: 'eve-password-1',
        role: 'member',
      },
    },
    { method: 'PATCH', url: `/api/admin/users/${memberId}`, payload: { role: 'admin' } },
    { method: 'GET', url: `/api/admin/users/${memberId}/knowledge-bases` },
    {
      method: 'PUT',
      url: `/api/admin/users/${memberId}/knowledge-bases`,
      payload: { knowledgeBaseIds: [kbId] },
    },
  ] as const;
  for (const route of routes) {
    const response = await app.inject({ ...route });
    assert.equal(response.statusCode, 403, `${route.method} ${route.url}`);
  }
  await app.close();
});

test('admin lists, creates and updates tenant users', async () => {
  const calls: string[] = [];
  const app = await makeApp({
    listTenantUsers: async (tenant: string) => {
      calls.push('list');
      assert.equal(tenant, tenantId);
      return [
        {
          id: memberId,
          username: 'user',
          displayName: '普通用户',
          role: 'member',
          grantedKbCount: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    },
    createTenantUser: async (tenant: string, input: Record<string, unknown>) => {
      calls.push('create');
      assert.equal(tenant, tenantId);
      assert.equal(input.username, 'newcomer');
      assert.match(String(input.passwordHash), /^scrypt\$/);
      return {
        id: '00000000-0000-4000-8000-0000000000c1',
        username: input.username,
        displayName: input.displayName,
        role: input.role,
      };
    },
    updateTenantUser: async (tenant: string, userId: string, patch: Record<string, unknown>) => {
      calls.push('update');
      assert.equal(tenant, tenantId);
      assert.equal(userId, memberId);
      return {
        id: memberId,
        username: 'user',
        displayName: '新名字',
        role: patch.role,
      };
    },
  });
  const list = await app.inject({ method: 'GET', url: '/api/admin/users' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data[0].grantedKbCount, 2);

  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    payload: {
      username: 'newcomer',
      displayName: '新用户',
      password: 'a-good-password',
      role: 'member',
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().username, 'newcomer');

  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${memberId}`,
    payload: { role: 'owner', displayName: '新名字' },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().role, 'owner');
  assert.deepEqual(calls, ['list', 'create', 'update']);
  await app.close();
});

test('create rejects invalid usernames and short passwords with 400', async () => {
  const app = await makeApp({
    createTenantUser: async () => {
      throw new Error('must not create');
    },
  });
  const badUsername = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    payload: {
      username: 'bad name!',
      displayName: 'x',
      password: 'a-good-password',
      role: 'member',
    },
  });
  assert.equal(badUsername.statusCode, 400);
  const shortPassword = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    payload: {
      username: 'newcomer',
      displayName: 'x',
      password: 'short',
      role: 'member',
    },
  });
  assert.equal(shortPassword.statusCode, 400);
  await app.close();
});

test('grant replacement validates the user and knowledge bases', async () => {
  const app = await makeApp({
    listKnowledgeBaseGrants: async (tenant: string, userId: string) => {
      assert.equal(tenant, tenantId);
      assert.equal(userId, memberId);
      return [kbId];
    },
    replaceKnowledgeBaseGrants: async (
      tenant: string,
      userId: string,
      kbIds: string[],
      grantedBy: string,
    ) => {
      assert.equal(tenant, tenantId);
      assert.equal(userId, memberId);
      assert.deepEqual(kbIds, [kbId]);
      assert.equal(grantedBy, adminId);
      return [kbId];
    },
  });
  const list = await app.inject({
    method: 'GET',
    url: `/api/admin/users/${memberId}/knowledge-bases`,
  });
  assert.deepEqual(list.json().data, [kbId]);

  const replaced = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${memberId}/knowledge-bases`,
    payload: { knowledgeBaseIds: [kbId] },
  });
  assert.equal(replaced.statusCode, 200);
  assert.deepEqual(replaced.json().data, [kbId]);
  await app.close();
});

test('grant replacement maps unknown users or KBs to 404', async () => {
  const { RepositoryNotFoundError } = await import('@repo/db');
  const app = await makeApp({
    replaceKnowledgeBaseGrants: async () => {
      throw new RepositoryNotFoundError('knowledge_base');
    },
  });
  const response = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${memberId}/knowledge-bases`,
    payload: { knowledgeBaseIds: [kbId] },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'knowledge_base_not_found');
  await app.close();
});
