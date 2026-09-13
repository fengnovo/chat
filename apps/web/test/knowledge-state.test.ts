import assert from 'node:assert/strict';
import test from 'node:test';

import { toggleKnowledgeBase, knowledgeBaseIdsForChat } from '../app/components/resilient-chat/knowledge-base-picker';
import { messagesFromHistory } from '../app/components/resilient-chat/utils';

test('knowledge picker toggles one id without dropping other selections', () => {
  assert.deepEqual(toggleKnowledgeBase(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleKnowledgeBase(['a', 'b'], 'c'), ['a', 'b', 'c']);
});

test('knowledge picker persists selections by chat id', () => {
  const storage = new Map<string, string>();
  assert.deepEqual(knowledgeBaseIdsForChat('chat-1', storage), []);
  storage.set('knowledge-bases:chat-1', JSON.stringify(['kb-1']));
  assert.deepEqual(knowledgeBaseIdsForChat('chat-1', storage), ['kb-1']);
  assert.deepEqual(knowledgeBaseIdsForChat('chat-2', storage), []);
});

test('history citation part is available to message rendering', () => {
  const [message] = messagesFromHistory([{
    id: 'message-1', runId: 'run-1', role: 'assistant', text: 'answer', createdAt: new Date().toISOString(),
    citations: [{ chunkId: 'c', documentId: 'd', documentName: 'doc.md', ordinal: 1, score: 0.8, via: 'graph' }],
  }]);
  assert.deepEqual(message.parts.at(-1), { type: 'data-citations', data: { citations: [{ chunkId: 'c', documentId: 'd', documentName: 'doc.md', ordinal: 1, score: 0.8, via: 'graph' }] } });
});
