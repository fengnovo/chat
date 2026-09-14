import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const contractKeys = [
  'OTEL_ENABLED', 'OTEL_SERVICE_NAME', 'OTEL_ENVIRONMENT', 'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_TRACES_SAMPLER', 'OTEL_TRACES_SAMPLER_ARG',
  'OTEL_METRIC_EXPORT_INTERVAL', 'OBSERVABILITY_CAPTURE_CONTENT', 'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL', 'LANGFUSE_ENABLED', 'LANGFUSE_SAMPLE_RATE',
  'OBSERVABILITY_LOG_LEVEL', 'OBSERVABILITY_SHUTDOWN_TIMEOUT_MS',
] as const;

function readEnvFile(path: URL): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    const [, key, value] = match ?? [];
    if (key) values[key] = value ?? '';
  }
  return values;
}

const local = readEnvFile(new URL('../../../.env.example', import.meta.url));
const production = readEnvFile(new URL('../../../deploy/env.production.example', import.meta.url));

test('local and production examples contain every shared observability key', () => {
  assert.deepEqual(contractKeys.filter((key) => local[key] === undefined), []);
  assert.deepEqual(contractKeys.filter((key) => production[key] === undefined), []);
});

test('observability credentials remain empty and capture is disabled by default', () => {
  for (const values of [local, production]) {
    assert.equal(values.OTEL_EXPORTER_OTLP_HEADERS, '');
    assert.equal(values.LANGFUSE_PUBLIC_KEY, '');
    assert.equal(values.LANGFUSE_SECRET_KEY, '');
    assert.equal(values.OBSERVABILITY_CAPTURE_CONTENT, 'false');
    for (const key of ['OTEL_TRACES_SAMPLER_ARG', 'LANGFUSE_SAMPLE_RATE']) {
      const rate = Number(values[key]);
      assert.ok(Number.isFinite(rate) && rate >= 0 && rate <= 1);
    }
  }
});
