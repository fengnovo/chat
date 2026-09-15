import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  loadObservabilityConfig,
  startObservability,
  type LangfuseRuntime,
} from '@repo/observability';

import { createWorkerLangfuse, type LangfuseRunMeta } from '../src/langfuse.js';

const baseMeta: LangfuseRunMeta = {
  runId: '01234567-89ab-cdef-0000-000000000000',
  sessionId: 'session-abc',
  userId: 'user-secret-42',
  runKind: 'start',
  provider: 'openai',
  model: 'gpt-test',
  modelFamily: 'gpt',
};

const enabledEnv = (): NodeJS.ProcessEnv => ({
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test-secret',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3999',
  LANGFUSE_SAMPLE_RATE: '1',
  OTEL_ENVIRONMENT: 'test',
});

function fakeRuntime(overrides: Partial<LangfuseRuntime> = {}): LangfuseRuntime & {
  flushCalls: number;
  shutdownCalls: number;
} {
  return {
    enabled: true,
    flushCalls: 0,
    shutdownCalls: 0,
    sampleRun: () => true,
    async flush() {
      this.flushCalls += 1;
    },
    async shutdown() {
      this.shutdownCalls += 1;
    },
    ...overrides,
  } as LangfuseRuntime & { flushCalls: number; shutdownCalls: number };
}

test('disabled when LANGFUSE_ENABLED is not set: no callbacks, lifecycle is no-op', async () => {
  const lf = createWorkerLangfuse({ shutdownTimeoutMs: 5_000, env: {} });
  assert.equal(lf.enabled, false);
  assert.deepEqual(lf.runCallbacks(baseMeta), []);
  await lf.flush(50);
  await lf.shutdown(50);
});

test('sampled run attaches exactly one callback with allow-list metadata and pseudonymized user', async () => {
  const spanExporter = new InMemorySpanExporter();
  const otel = await startObservability(
    loadObservabilityConfig(
      { OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' },
      { serviceName: 'worker-langfuse-test', serviceVersion: 'test' },
    ),
    { spanExporter },
  );
  const runtime = fakeRuntime();
  const factoryCalls: Array<{
    userId: string;
    sessionId: string;
    tags: string[];
    traceMetadata: Record<string, string>;
  }> = [];
  const lf = createWorkerLangfuse({
    shutdownTimeoutMs: 5_000,
    env: enabledEnv(),
    runtime,
    callbackFactory: (params) => {
      factoryCalls.push(params);
      return { name: 'fake-langfuse-handler' };
    },
  });

  const tracer = otel.tracer;
  const callbacks = tracer.startActiveSpan('worker.job.execute', (span) => {
    try {
      return lf.runCallbacks(baseMeta);
    } finally {
      span.end();
    }
  });

  assert.equal(callbacks.length, 1);
  assert.equal(factoryCalls.length, 1);
  const params = factoryCalls[0]!;
  // userId 必须是伪名：带 u_ 前缀、不可逆、不含原值。
  assert.match(params.userId, /^u_[0-9a-f]{16}$/);
  assert.ok(!params.userId.includes('user-secret'));
  assert.equal(params.sessionId, 'session-abc');

  const allowedMetadataKeys = new Set([
    'run_id',
    'run_kind',
    'environment',
    'tempo_trace_id',
    'provider',
    'model',
    'model_family',
  ]);
  for (const key of Object.keys(params.traceMetadata)) {
    assert.ok(allowedMetadataKeys.has(key), `unexpected metadata key: ${key}`);
  }
  assert.equal(params.traceMetadata.run_id, '01234567');
  assert.equal(params.traceMetadata.run_kind, 'start');
  assert.equal(params.traceMetadata.environment, 'test');
  assert.equal(params.traceMetadata.provider, 'openai');
  assert.equal(params.traceMetadata.model, 'gpt-test');
  assert.equal(params.traceMetadata.model_family, 'gpt');
  assert.match(params.traceMetadata.tempo_trace_id!, /^[0-9a-f]{32}$/);

  // 原始用户/提示内容不得出现在任何 callback 参数中。
  const serialized = JSON.stringify(params);
  assert.ok(!serialized.includes('user-secret-42'));

  await otel.shutdown();
});

test('unsampled run attaches no callbacks and never invokes the factory', () => {
  let factoryCalled = false;
  const lf = createWorkerLangfuse({
    shutdownTimeoutMs: 5_000,
    env: enabledEnv(),
    runtime: fakeRuntime({ sampleRun: () => false }),
    callbackFactory: () => {
      factoryCalled = true;
      return {};
    },
  });
  assert.deepEqual(lf.runCallbacks(baseMeta), []);
  assert.equal(factoryCalled, false);
});

test('callback factory failure fails open: empty callbacks, no throw', () => {
  const lf = createWorkerLangfuse({
    shutdownTimeoutMs: 5_000,
    env: enabledEnv(),
    runtime: fakeRuntime(),
    callbackFactory: () => {
      throw new Error('langfuse down');
    },
  });
  assert.deepEqual(lf.runCallbacks(baseMeta), []);
});

test('unbounded model/provider labels are dropped from metadata', () => {
  const captured: Array<{ traceMetadata: Record<string, string> }> = [];
  const lf = createWorkerLangfuse({
    shutdownTimeoutMs: 5_000,
    env: enabledEnv(),
    runtime: fakeRuntime(),
    callbackFactory: (params) => {
      captured.push(params);
      return {};
    },
  });
  lf.runCallbacks({
    ...baseMeta,
    provider: 'open ai; DROP TABLE',
    model: 'x'.repeat(80),
    modelFamily: 'bad/value?',
  });
  assert.ok(!('provider' in captured[0]!.traceMetadata));
  assert.ok(!('model' in captured[0]!.traceMetadata));
  assert.ok(!('model_family' in captured[0]!.traceMetadata));
});

test('flush/shutdown delegate to the underlying runtime', async () => {
  const runtime = fakeRuntime();
  const lf = createWorkerLangfuse({
    shutdownTimeoutMs: 5_000,
    env: enabledEnv(),
    runtime,
  });
  await lf.flush(123);
  await lf.shutdown(456);
  assert.equal(runtime.flushCalls, 1);
  assert.equal(runtime.shutdownCalls, 1);
});
