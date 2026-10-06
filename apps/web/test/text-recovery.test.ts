import assert from 'node:assert/strict';
import test from 'node:test';
import { messageText } from '../app/components/resilient-chat/utils';
import { agentEventToTrace } from '../app/components/resilient-chat/events';

test('persisted text recovery replaces previous parts and preserves later deltas', () => {
  const message = { id: 'message', role: 'assistant', parts: [
    { type: 'text', text: 'unfinished' },
    { type: 'data-text-recovery', data: { text: 'correct' } },
    { type: 'text', text: ' answer' },
  ] } as const;
  assert.equal(messageText(message as never), 'correct answer');
  assert.equal(messageText({ ...message, parts: [...message.parts, { type: 'data-text-recovery', data: { text: '' } }] } as never), '');
});

test('snapshots do not create an extra trace entry', () => {
  assert.equal(agentEventToTrace({ runId: 'run', timestamp: new Date().toISOString(), type: 'assistant.snapshot', text: 'answer' }), null);
});
