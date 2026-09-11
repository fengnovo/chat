import assert from 'node:assert/strict';
import test from 'node:test';

import { agentEventSchema, createRunSchema, runJobSchema } from '../src/index.js';

test('validates a persisted coding agent event', () => {
  const result = agentEventSchema.parse({
    runId: '00000000-0000-4000-8000-000000000001',
    timestamp: new Date().toISOString(),
    type: 'assistant.delta',
    text: 'hello',
  });

  assert.equal(result.type, 'assistant.delta');
});

test('rejects empty runs and malformed jobs', () => {
  assert.equal(createRunSchema.safeParse({ message: '  ' }).success, false);
  assert.equal(runJobSchema.safeParse({ kind: 'start' }).success, false);
});
