import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { loadConfig } from '../src/config.js';
import { apiFastifyOptions } from '../src/observability.js';

test('trusted proxy CIDRs resolve the forwarded client IP', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    TRUST_PROXY_CIDRS: '127.0.0.1/32,10.20.0.0/16',
  });
  const app = Fastify({ ...apiFastifyOptions(config), logger: false });
  app.get('/ip', async (request) => ({ ip: request.ip, ips: request.ips }));

  const response = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '198.51.100.12, 10.20.30.40' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ip: '198.51.100.12',
    ips: ['127.0.0.1', '10.20.30.40', '198.51.100.12'],
  });
  await app.close();
});

test('forwarded IPs are ignored when the direct peer is outside configured CIDRs', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    TRUST_PROXY_CIDRS: '127.0.0.1/32,10.20.0.0/16',
  });
  const app = Fastify({ ...apiFastifyOptions(config), logger: false });
  app.get('/ip', async (request) => ({ ip: request.ip, ips: request.ips }));

  const response = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: '203.0.113.50',
    headers: { 'x-forwarded-for': '198.51.100.12' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ip: '203.0.113.50',
    ips: ['203.0.113.50'],
  });
  await app.close();
});

test('invalid trusted proxy CIDRs are rejected at configuration load', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', TRUST_PROXY_CIDRS: '127.0.0.1/99' }),
    /TRUST_PROXY_CIDRS/,
  );
});
