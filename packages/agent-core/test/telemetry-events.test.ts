import assert from 'node:assert/strict';
import test from 'node:test';

import { createResilientModelRouter, isRecoverableModelError } from '../src/index.js';
import type { AgentTelemetry } from '../src/index.js';

function rateLimitError() {
  return Object.assign(new Error('rate limited'), { status: 429 });
}

function buildTelemetry() {
  const modelCalls: Parameters<AgentTelemetry['modelCall']>[0][] = [];
  const events: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean> | undefined;
  }> = [];
  const telemetry: Pick<AgentTelemetry, 'modelCall' | 'event'> = {
    modelCall(meta) {
      modelCalls.push(meta);
    },
    event(name, attributes) {
      events.push({ name, ...(attributes ? { attributes } : {}) });
    },
  };
  return { telemetry, modelCalls, events };
}

test('router retries the primary and reports a successful call with retry count', async () => {
  const { telemetry, modelCalls, events } = buildTelemetry();
  const router = await createResilientModelRouter({
    models: [{ id: 'openai:gpt-4o', model: 'gpt-4o', provider: 'openai', apiKey: 'test' }],
    maxRetries: 1,
    initialDelayMs: 1,
    maxDelayMs: 1,
    telemetry,
  });

  let attempts = 0;
  const middleware = router.middleware as unknown as {
    wrapModelCall: (
      request: { runtime: { signal: AbortSignal } },
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  await middleware.wrapModelCall(
    { runtime: { signal: new AbortController().signal } },
    async () => {
      attempts += 1;
      if (attempts < 2) throw rateLimitError();
      return { ok: true };
    },
  );

  assert.equal(attempts, 2);
  const success = modelCalls.find((call) => call.outcome === 'success');
  assert.ok(success);
  assert.equal(success!.provider, 'openai');
  assert.equal(success!.model, 'gpt-4o');
  assert.equal(success!.retries, 1);
  assert.equal(success!.fallbacks, undefined);
  assert.ok(success!.latencyMs >= 0);
  const retryEvent = events.find((event) => event.name === 'model.retry');
  assert.ok(retryEvent);
  assert.equal(retryEvent!.attributes!.model, 'openai:gpt-4o');
  assert.equal(retryEvent!.attributes!.attempt, 1);
  // 错误原文不得进入遥测事件属性。
  assert.equal(JSON.stringify(retryEvent!.attributes).includes('rate limited'), false);
});

test('router falls back to the secondary and counts fallback, then settles one failure', async () => {
  const { telemetry, modelCalls, events } = buildTelemetry();
  const router = await createResilientModelRouter({
    models: [
      { id: 'openai:gpt-4o', model: 'gpt-4o', provider: 'openai', apiKey: 'test' },
      { id: 'anthropic:claude-test', model: 'claude-test', provider: 'anthropic', apiKey: 'test' },
    ],
    maxRetries: 0,
    initialDelayMs: 1,
    maxDelayMs: 1,
    telemetry,
  });

  let handlerCalls = 0;
  const middleware = router.middleware as unknown as {
    wrapModelCall: (
      request: { runtime: { signal: AbortSignal } },
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };

  // 场景一：主模型（第 1 次调用）429 后降级到备模型（第 2 次调用）成功。
  await middleware.wrapModelCall(
    { runtime: { signal: new AbortController().signal } },
    async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) throw rateLimitError();
      return { ok: true };
    },
  );
  assert.equal(handlerCalls, 2);
  const fallbackSuccess = modelCalls.find(
    (call) => call.outcome === 'success' && call.provider === 'anthropic',
  );
  assert.ok(fallbackSuccess);
  assert.equal(fallbackSuccess!.fallbacks, 1);
  assert.ok(events.some((event) => event.name === 'model.fallback'));

  // 场景二：所有候选都失败时只结算一次 failure（不重复计数）。
  modelCalls.length = 0;
  await assert.rejects(
    middleware.wrapModelCall(
      { runtime: { signal: new AbortController().signal } },
      async () => {
        throw Object.assign(new Error('boom'), { status: 503 });
      },
    ),
    /boom/,
  );
  const failures = modelCalls.filter((call) => call.outcome === 'failure');
  assert.equal(failures.length, 1);
});

test('non-recoverable errors are not retried', () => {
  assert.equal(isRecoverableModelError(Object.assign(new Error('bad key'), { status: 401 })), false);
});
