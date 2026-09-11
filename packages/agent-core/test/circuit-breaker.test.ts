import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryCircuitBreakerStore, isRecoverableModelError } from '../src/index.js';

test('circuit opens after the configured failure threshold', async () => {
  const breaker = new InMemoryCircuitBreakerStore(2, 60_000);
  await breaker.recordFailure('model');
  assert.equal(await breaker.allows('model'), true);
  await breaker.recordFailure('model');
  assert.equal(await breaker.allows('model'), false);
});

test('only transient model errors are retried', () => {
  assert.equal(isRecoverableModelError({ status: 429 }), true);
  assert.equal(isRecoverableModelError({ status: 503 }), true);
  assert.equal(isRecoverableModelError({ status: 401 }), false);
});
