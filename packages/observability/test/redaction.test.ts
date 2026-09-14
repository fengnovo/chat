import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PINO_REDACT_PATHS,
  createPinoRedactPaths,
  normalizeRoute,
  redactTelemetryValue,
} from '../src/redaction.js';

test('redacts nested headers, prompts, tool arguments, and secrets while allow-listing unknown objects', () => {
  const input = {
    request_id: 'request-safe',
    operation: 'chat.run',
    req: {
      headers: {
        authorization: 'Bearer header-secret',
        cookie: 'session=cookie-secret',
        'x-request-id': 'header-request-id',
      },
      body: { prompt: 'body prompt', privateField: 'must-not-leak' },
    },
    prompt: 'user prompt',
    completion: 'model response',
    toolArgs: { command: 'cat /private/file' },
    nested: { token: 'nested-token', safe: 'kept', unknown: 'dropped' },
    unknown: { authorization: 'Bearer hidden', privateField: 'hidden' },
  };

  const result = redactTelemetryValue(input, {
    allowKeys: ['request_id', 'operation', 'req', 'headers', 'x-request-id', 'body', 'nested', 'safe'],
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result, {
    request_id: 'request-safe',
    operation: 'chat.run',
    req: {
      headers: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'x-request-id': 'header-request-id',
      },
      body: { prompt: '[REDACTED]' },
    },
    prompt: '[REDACTED]',
    completion: '[REDACTED]',
    toolArgs: '[REDACTED]',
    nested: { token: '[REDACTED]', safe: 'kept' },
  });
  for (const secret of ['header-secret', 'cookie-secret', 'body prompt', 'privateField', 'nested-token', 'cat /private/file']) {
    assert.equal(serialized.includes(secret), false, `redacted output leaked ${secret}`);
  }
});

test('sanitizes Error stacks and exposes only stable error metadata', () => {
  const error = Object.assign(new Error('request failed with Authorization=super-secret'), {
    name: 'ProviderError',
    code: 'UPSTREAM_TIMEOUT',
  });
  error.stack = 'ProviderError: Bearer jwt-secret\n    at https://alice:password@internal.example/file.ts:1:1';

  const result = redactTelemetryValue(error);
  const serialized = JSON.stringify(result);

  assert.equal((result as { type?: string }).type, 'ProviderError');
  assert.equal((result as { code?: string }).code, 'UPSTREAM_TIMEOUT');
  assert.match((result as { stack?: string }).stack ?? '', /\[REDACTED\]/);
  assert.equal(serialized.includes('jwt-secret'), false);
  assert.equal(serialized.includes('alice:password'), false);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('request failed'), false);
});

test('exports composable Pino redact paths without mutating the shared defaults', () => {
  assert.deepEqual(PINO_REDACT_PATHS, [
    'req.headers.authorization', 'req.headers.cookie', 'password', 'token', 'secret',
    'apiKey', 'prompt', 'completion', 'toolArgs', 'documentContent',
  ]);
  assert.deepEqual(createPinoRedactPaths(['req.headers.set-cookie', 'token']), [
    ...PINO_REDACT_PATHS,
    'req.headers.set-cookie',
  ]);
  assert.equal(PINO_REDACT_PATHS.includes('req.headers.set-cookie'), false);
});

test('allow-listing does not evaluate properties that will be discarded', () => {
  const input = { operation: 'safe' } as Record<string, unknown>;
  Object.defineProperty(input, 'unknown', {
    enumerable: true,
    get() { throw new Error('discarded getter must not run'); },
  });
  assert.doesNotThrow(() => redactTelemetryValue(input));
  assert.deepEqual(redactTelemetryValue(input), { operation: 'safe' });
});

test('normalizes routes without query strings, identifiers, or filenames', () => {
  assert.equal(
    normalizeRoute('/users/550e8400-e29b-41d4-a716-446655440000?token=secret', '/users/:userId'),
    '/users/:userId',
  );
  assert.equal(normalizeRoute('/users/alice?view=full'), '/users/:id');
  assert.equal(normalizeRoute('/runs/run_123456/events'), '/runs/:id/events');
  assert.equal(normalizeRoute('/files/private-report.pdf?signature=secret'), '/files/:id');
  assert.equal(normalizeRoute('https://example.test/api/chat?user=alice'), '/api/chat');
  assert.ok(normalizeRoute(`/${'safe/'.repeat(100)}`).length <= 128);
});
