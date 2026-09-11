import assert from 'node:assert/strict';
import test from 'node:test';

import type { PersistedAgentEvent } from '@repo/contracts';

import { chunksFrom } from '../src/chat-stream.js';

const runId = '00000000-0000-4000-8000-000000000001';

test('durable agent events map to a valid framed text response', () => {
  const events: PersistedAgentEvent[] = [
    { runId, seq: 1, timestamp: new Date().toISOString(), type: 'run.started' },
    {
      runId,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'assistant.delta',
      text: 'hello',
    },
    { runId, seq: 3, timestamp: new Date().toISOString(), type: 'run.completed' },
  ];
  const chunks = chunksFrom(runId, events);
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['start', 'data-agent', 'text-start', 'text-delta', 'data-agent', 'text-end', 'finish'],
  );
});
