import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';

import { registerRoutes } from '../src/routes.js';

const contractKeys = [
  'OTEL_ENABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_ENVIRONMENT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OBSERVABILITY_CAPTURE_CONTENT',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_ENABLED',
  'LANGFUSE_SAMPLE_RATE',
  'OBSERVABILITY_LOG_LEVEL',
  'OBSERVABILITY_SHUTDOWN_TIMEOUT_MS',
] as const;

function readEnvFile(path: URL): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    const [, key, value] = match ?? [];
    if (key) {
      assert.equal(values[key], undefined, `${key} must not be declared more than once`);
      values[key] = value ?? '';
    }
  }
  return values;
}

const local = readEnvFile(new URL('../../../.env.example', import.meta.url));
const production = readEnvFile(new URL('../../../deploy/env.production.example', import.meta.url));
const securityPolicy = readFileSync(
  new URL('../../../docs/observability/security-and-operations.md', import.meta.url),
  'utf8',
);

test('local and production examples expose the same observability contract', () => {
  assert.deepEqual(
    Object.keys(local).filter((key) => contractKeys.includes(key as (typeof contractKeys)[number])).sort(),
    [...contractKeys].sort(),
  );
  assert.deepEqual(
    Object.keys(production).filter((key) => contractKeys.includes(key as (typeof contractKeys)[number])).sort(),
    [...contractKeys].sort(),
  );
});

test('observability examples never contain non-empty credentials or headers', () => {
  for (const values of [local, production]) {
    for (const key of ['OTEL_EXPORTER_OTLP_HEADERS', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
      assert.equal(values[key], '', `${key} must remain empty in an example file`);
    }
  }
});

test('examples use safe capture defaults and valid sampling rates', () => {
  assert.equal(local.OBSERVABILITY_CAPTURE_CONTENT, 'false');
  assert.equal(production.OBSERVABILITY_CAPTURE_CONTENT, 'false');
  for (const values of [local, production]) {
    for (const key of ['OTEL_TRACES_SAMPLER_ARG', 'LANGFUSE_SAMPLE_RATE']) {
      const rate = Number(values[key]);
      assert.ok(Number.isFinite(rate) && rate >= 0 && rate <= 1, `${key} must be in [0,1]`);
    }
  }
});

test('public health contract requires sanitized summaries without internal details', () => {
  for (const phrase of [
    'sanitized status, version, and component summaries',
    'never expose secrets, DSNs, raw errors, stack traces, hostnames',
  ]) {
    assert.ok(securityPolicy.includes(phrase), `health policy must include: ${phrase}`);
  }
});

test('ready health responses redact dependency failure details', async () => {
  const secret = 'postgres://user:super-secret@db.internal:5432/app';
  const app = Fastify();
  await registerRoutes(app, {
    repository: { ping: async () => { throw new Error(`connection failed: ${secret}`); } },
    publisher: { ping: async () => undefined },
    artifacts: { ping: async () => undefined },
  } as never);

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: 'not_ready',
    version: '0.1.0',
    checks: { repository: { status: 'not_ready' }, publisher: { status: 'ok' }, artifacts: { status: 'ok' } },
    observability: { enabled: false, exporter: 'disabled' },
    component: 'repository',
    error: 'dependency_unavailable',
  });
  assert.equal(response.body.includes(secret), false);
  await app.close();
});
