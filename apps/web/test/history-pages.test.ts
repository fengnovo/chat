import assert from 'node:assert/strict';
import test from 'node:test';
import { prependHistoryMessages, reconcileRecoveredHistory } from '../app/components/resilient-chat/history-pages';

test('older history pages prepend without replacing a newer answer or dropping current messages', () => {
  const current = [{ id: 'latest', text: 'streamed answer' }];
  const result = prependHistoryMessages(current, [{ id: 'old', text: 'earlier answer' }, { id: 'latest', text: 'stale snapshot' }]);
  assert.deepEqual(result, [{ id: 'old', text: 'earlier answer' }, { id: 'latest', text: 'streamed answer' }]);
  assert.deepEqual(current, [{ id: 'latest', text: 'streamed answer' }]);
});

test('reply recovery replaces overlapping optimistic turns while keeping older loaded pages', () => {
  const current = [
    { id: 'user-old', role: 'user', text: 'same question' },
    { id: 'message-old', role: 'assistant', text: 'older answer', metadata: { runId: 'old' } },
    { id: 'sdk-user-1', role: 'user', text: 'same question' },
    { id: 'message-r1', role: 'assistant', text: 'first answer', metadata: { runId: 'r1' } },
    { id: 'sdk-user-2', role: 'user', text: 'same question' },
    { id: 'message-r2', role: 'assistant', text: '', metadata: { runId: 'r2' } },
  ];
  const history = [
    { id: 'user-r1', role: 'user', text: 'same question', metadata: { runId: 'r1' } },
    { id: 'message-r1', role: 'assistant', text: 'first answer', metadata: { runId: 'r1' } },
    { id: 'user-r2', role: 'user', text: 'same question', metadata: { runId: 'r2' } },
    { id: 'message-r2', role: 'assistant', text: 'recovered answer', metadata: { runId: 'r2' } },
  ];
  const restored = reconcileRecoveredHistory(current, history, 'r2');
  assert.deepEqual(restored.map(({ id }) => id), ['user-old', 'message-old', 'user-r1', 'message-r1', 'user-r2', 'message-r2']);
  assert.equal(restored.at(-1)?.text, 'recovered answer');
});

test('reply recovery replaces the pending user even when no assistant frame arrived', () => {
  const history = [
    { id: 'user-r', role: 'user', metadata: { runId: 'r' } },
    { id: 'message-r', role: 'assistant', metadata: { runId: 'r' } },
  ];
  assert.deepEqual(reconcileRecoveredHistory<{ id: string; role: string; metadata?: { runId?: string } }>(
    [{ id: 'sdk-user', role: 'user' }], history, 'r'), history);
});

test('continuation recovery retains the original user when its run is outside the history page', () => {
  const current = [
    { id: 'sdk-original', role: 'user' },
    { id: 'message-original', role: 'assistant', metadata: { runId: 'original' } },
    { id: 'message-continuation', role: 'assistant', metadata: { runId: 'continuation' } },
  ];
  const history = [{ id: 'message-continuation', role: 'assistant', metadata: { runId: 'continuation' } }];
  assert.deepEqual(reconcileRecoveredHistory(current, history, 'continuation'), current);
});

test('recovery uses send-response run identities for consecutive users without assistant frames', () => {
  const current = [{ id: 'sdk-first', role: 'user' }, { id: 'sdk-second', role: 'user' }];
  const history = [{ id: 'user-first', role: 'user' }, { id: 'user-second', role: 'user' }, { id: 'message-second', role: 'assistant' }];
  assert.deepEqual(reconcileRecoveredHistory(current, history, 'second', new Map([
    ['sdk-first', 'first'], ['sdk-second', 'second'],
  ])), history);
});
