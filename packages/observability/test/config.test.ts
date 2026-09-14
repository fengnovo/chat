import assert from 'node:assert/strict';
import test from 'node:test';
import { loadObservabilityConfig } from '../src/config.js';

const defaults = { serviceName: 'test-service', serviceVersion: '1.2.3' };

test('defaults disable telemetry and content capture', () => {
  assert.deepEqual(loadObservabilityConfig({}, defaults), {
    enabled: false, serviceName: 'test-service', serviceVersion: '1.2.3',
    environment: 'development', tracesSampleRatio: 0.1, metricExportIntervalMs: 60000,
    captureContent: false, logLevel: 'info', shutdownTimeoutMs: 5000,
  });
});

test('explicit booleans and numeric settings are parsed without ambient environment', () => {
  const config = loadObservabilityConfig({
    OTEL_ENABLED: ' TRUE ', OBSERVABILITY_CAPTURE_CONTENT: '1',
    OTEL_SERVICE_NAME: 'worker', OTEL_SERVICE_VERSION: '2.0', OTEL_ENVIRONMENT: 'test',
    OTEL_TRACES_SAMPLER_ARG: '0.25', OTEL_METRIC_EXPORT_INTERVAL: '250',
    OBSERVABILITY_SHUTDOWN_TIMEOUT_MS: '20', OBSERVABILITY_LOG_LEVEL: 'debug',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp/',
  }, defaults);
  assert.equal(config.enabled, true);
  assert.equal(config.captureContent, true);
  assert.equal(config.serviceName, 'worker');
  assert.equal(config.serviceVersion, '2.0');
  assert.equal(config.environment, 'test');
  assert.equal(config.tracesSampleRatio, 0.25);
  assert.equal(config.metricExportIntervalMs, 250);
  assert.equal(config.shutdownTimeoutMs, 20);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.otlpEndpoint, 'https://collector.example/otlp');
  for (const value of ['false', '0', ' FALSE ']) {
    assert.equal(loadObservabilityConfig({ OTEL_ENABLED: value }, defaults).enabled, false);
  }
});

test('invalid settings fail with key-only messages, never credentials or headers', () => {
  for (const [key, values] of Object.entries({
    OTEL_TRACES_SAMPLER_ARG: ['-0.1', '1.1', 'NaN', 'Infinity', '0.5junk'],
    OTEL_METRIC_EXPORT_INTERVAL: ['0', '-1', '1.5', '2147483648'],
    OBSERVABILITY_SHUTDOWN_TIMEOUT_MS: ['0', 'NaN', '5001', '60000'],
    OTEL_ENABLED: ['yes'], OBSERVABILITY_CAPTURE_CONTENT: ['sometimes'],
    OTEL_EXPORTER_OTLP_ENDPOINT: ['not-a-url', 'ftp://collector', 'https://secret:token@collector'],
  })) {
    for (const value of values) {
      assert.throws(() => loadObservabilityConfig({ [key]: value, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=super-secret' }, defaults), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(key));
        assert.ok(!/secret|token|Authorization/.test(error.message));
        return true;
      });
    }
  }
  for (const value of ['0', '1']) assert.equal(loadObservabilityConfig({ OTEL_TRACES_SAMPLER_ARG: value }, defaults).tracesSampleRatio, Number(value));
});
