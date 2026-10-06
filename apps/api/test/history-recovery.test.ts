import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes.js';

test('history folds snapshots as replacements including empty recovered text', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let events = [
    { type: 'assistant.delta', text: 'unfinished' },
    { type: 'assistant.snapshot', text: 'correct' },
    { type: 'assistant.delta', text: ' answer' },
  ];
  await registerRoutes(app, { config: {}, repository: {
    getSession: async () => ({ id: 'session' }),
    listSessionRuns: async () => [{ id: 'run', userMessage: 'hello', createdAt: 'now', updatedAt: 'now' }],
    listEvents: async () => events,
    listChatAttachmentsByRuns: async () => new Map(),
  } } as never);
  const response = await app.inject('/api/agent/sessions/session/history');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().messages.find((message: { role: string }) => message.role === 'assistant').text, 'correct answer');
  events = [...events, { type: 'assistant.snapshot', text: '' }];
  const cleared = await app.inject('/api/agent/sessions/session/history');
  assert.equal(cleared.json().messages.some((message: { role: string }) => message.role === 'assistant'), false);
});
