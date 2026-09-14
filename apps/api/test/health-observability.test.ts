import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { registerRoutes } from '../src/routes.js';

test('liveness reports only safe version and observability summaries', async () => {
  const app = Fastify();
  await registerRoutes(app, {
    config: { API_VERSION: '1.2.3' },
    observability: {
      health: { enabled: true, exporter: 'configured' },
    },
  } as never);

  const response = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok',
    version: '1.2.3',
    checks: { server: { status: 'ok' } },
    observability: { enabled: true, exporter: 'configured' },
  });
  await app.close();
});

test('readiness logs dependency details but never exposes them publicly', async () => {
  const secret = 'postgres://admin:db-password@db.internal:5432/chat?sslkey=private-key';
  const logs: string[] = [];
  const app = Fastify({
    logger: { level: 'error', stream: { write: (line: string) => logs.push(line) } },
  });
  await registerRoutes(app, {
    config: { API_VERSION: '1.2.3' },
    repository: { ping: async () => { throw new Error(`connection failed: ${secret}`); } },
    publisher: { ping: async () => undefined },
    artifacts: { ping: async () => undefined },
    observability: {
      health: { enabled: true, exporter: 'configured' },
    },
  } as never);

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: 'not_ready',
    version: '1.2.3',
    component: 'repository',
    error: 'dependency_unavailable',
    checks: {
      repository: { status: 'not_ready' },
      publisher: { status: 'ok' },
      artifacts: { status: 'ok' },
    },
    observability: { enabled: true, exporter: 'configured' },
  });
  assert.equal(response.body.includes(secret), false);
  assert.equal(response.body.includes('stack'), false);
  assert.equal(response.body.includes('private-key'), false);
  assert.ok(logs.some((line) => line.includes('readiness dependency failed')));
  assert.equal(logs.join('').includes(secret), false);
  assert.equal(logs.join('').includes('db-password'), false);
  await app.close();
});
