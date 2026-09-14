import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservabilityLogger } from '../src/logger.js';
import { loadObservabilityConfig } from '../src/config.js';
import { startObservability } from '../src/sdk.js';

test('emits Pino-compatible structured logs with fixed correlation and error fields', async () => {
  const runtime = await startObservability(
    loadObservabilityConfig({}, { serviceName: 'test-service', serviceVersion: '1' }),
  );
  const lines: string[] = [];
  const logger = createObservabilityLogger(runtime, {
    service: 'api',
    environment: 'test',
    destination: { write(chunk) { lines.push(chunk); } },
    now: () => new Date('2026-09-14T12:00:00.000Z'),
  }).child({
    request_id: 'req-1',
    trace_id: '0123456789abcdef0123456789abcdef',
    span_id: '0123456789abcdef',
    operation: 'http.request',
  });
  const error = Object.assign(new Error('Authorization=log-secret'), { name: 'UpstreamError', code: 'TIMEOUT' });

  logger.info({
    outcome: 'success',
    req: { headers: { authorization: 'Bearer auth-secret', cookie: 'sid=cookie-secret' }, body: { prompt: 'body prompt' } },
    prompt: 'user prompt',
    completion: 'model output',
    toolArgs: { command: 'private command' },
    arbitrary: 'not-allow-listed',
    error,
  }, 'request completed');

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.deepEqual(record, {
    timestamp: '2026-09-14T12:00:00.000Z',
    level: 'info',
    service: 'api',
    environment: 'test',
    request_id: 'req-1',
    trace_id: '0123456789abcdef0123456789abcdef',
    span_id: '0123456789abcdef',
    operation: 'http.request',
    outcome: 'success',
    error: { type: 'UpstreamError', code: 'TIMEOUT' },
    msg: 'request completed',
  });
  const serialized = lines.join('');
  for (const secret of ['log-secret', 'auth-secret', 'cookie-secret', 'body prompt', 'user prompt', 'model output', 'private command']) {
    assert.equal(serialized.includes(secret), false, `log output leaked ${secret}`);
  }
});

test('supports standard Pino levels, child bindings, and level filtering', async () => {
  const runtime = await startObservability(
    loadObservabilityConfig({}, { serviceName: 'test-service', serviceVersion: '1' }),
  );
  const lines: string[] = [];
  const logger = createObservabilityLogger(runtime, {
    service: 'worker', environment: 'test', level: 'warn', destination: { write(chunk) { lines.push(chunk); } },
  });

  assert.equal(typeof logger.trace, 'function');
  assert.equal(typeof logger.debug, 'function');
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.warn, 'function');
  assert.equal(typeof logger.error, 'function');
  assert.equal(typeof logger.fatal, 'function');
  assert.equal(typeof logger.child, 'function');
  assert.equal(logger.isLevelEnabled('info'), false);
  assert.equal(logger.isLevelEnabled('warn'), true);

  logger.info({ operation: 'job.start' }, 'filtered');
  logger.child({ operation: 'job.run' }).warn('visible');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? '{}').operation, 'job.run');
});

test('a failing destination cannot break business execution', async () => {
  const runtime = await startObservability(
    loadObservabilityConfig({}, { serviceName: 'test-service', serviceVersion: '1' }),
  );
  const logger = createObservabilityLogger(runtime, {
    service: 'api', environment: 'test', destination: { write() { throw new Error('disk unavailable'); } },
  });
  assert.doesNotThrow(() => logger.error({ operation: 'request.fail' }, 'still fail-open'));
});

test('discarded log bindings are not evaluated', async () => {
  const runtime = await startObservability(
    loadObservabilityConfig({}, { serviceName: 'test-service', serviceVersion: '1' }),
  );
  const lines: string[] = [];
  const logger = createObservabilityLogger(runtime, {
    service: 'api', environment: 'test', destination: { write(chunk) { lines.push(chunk); } },
  });
  const bindings = { operation: 'safe' } as Record<string, unknown>;
  Object.defineProperty(bindings, 'unknown', {
    enumerable: true,
    get() { throw new Error('discarded getter must not run'); },
  });
  assert.doesNotThrow(() => logger.info(bindings, 'visible'));
  assert.equal(JSON.parse(lines[0] ?? '{}').operation, 'safe');
});

test('free-form messages redact content fields while retaining stable error metadata', async () => {
  const runtime = await startObservability(
    loadObservabilityConfig({}, { serviceName: 'test-service', serviceVersion: '1' }),
  );
  const lines: string[] = [];
  const logger = createObservabilityLogger(runtime, {
    service: 'worker', environment: 'test', destination: { write(chunk) { lines.push(chunk); } },
  });
  const error = Object.assign(new Error('prompt=ERROR_PROMPT_LEAK document contents=ERROR_DOCUMENT_LEAK'), {
    name: 'ModelError', code: 'MODEL_FAILED',
  });
  error.stack = 'ModelError: completion=ERROR_COMPLETION_LEAK toolArgs=ERROR_TOOL_LEAK';

  logger.error(
    error,
    'Authorization=MSG_AUTH_LEAK cookie=MSG_COOKIE_LEAK token=MSG_TOKEN_LEAK prompt="MSG_PROMPT_LEAK" completion="MSG_COMPLETION_LEAK" tool args={"value":"MSG_TOOL_LEAK"} document contents=MSG_DOCUMENT_LEAK',
  );

  const record = JSON.parse(lines[0] ?? '{}') as { msg?: string; error?: unknown };
  assert.deepEqual(record.error, { type: 'ModelError', code: 'MODEL_FAILED' });
  assert.match(record.msg ?? '', /\[REDACTED\]/);
  for (const secret of [
    'MSG_AUTH_LEAK', 'MSG_COOKIE_LEAK', 'MSG_TOKEN_LEAK',
    'MSG_PROMPT_LEAK', 'MSG_COMPLETION_LEAK', 'MSG_TOOL_LEAK', 'MSG_DOCUMENT_LEAK',
    'ERROR_PROMPT_LEAK', 'ERROR_COMPLETION_LEAK', 'ERROR_TOOL_LEAK', 'ERROR_DOCUMENT_LEAK',
  ]) {
    assert.equal(lines[0]?.includes(secret), false, `log output leaked ${secret}`);
  }
});
