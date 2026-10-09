import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes.js';

test('history returns bounded projected pages, latest metadata and attachments without reading the ledger', async (t) => {
  const app = Fastify(); t.after(() => app.close());
  const received: unknown[] = [];
  const projection = { text: 'canonical answer', reasoning: 'thinking', citations: [{ documentName: 'notes.md' }], lastSeq: 1200 };
  const run = { id: 'run', userMessage: 'question', continuation: false, status: 'running', lastEventSeq: 1200, createdAt: 'now', updatedAt: 'now', projection };
  await registerRoutes(app, { config: {}, repository: {
    getSession: async () => ({ id: 'session', title: 'named' }),
    listSessionRuns: async () => { throw new Error('unbounded runs must not be read'); },
    listEvents: async () => { throw new Error('unbounded events must not be read'); },
    listChatAttachmentsByRuns: async () => new Map([['run', [{ id: 'attachment', filename: 'note.md', contentType: 'text/plain', sizeBytes: 8, kind: 'text' }]]]),
    history: {
      pageRuns: async (_: unknown, __: unknown, options: unknown) => { received.push(options); return { runs: [run], hasMore: true, nextCursor: 'older' }; },
      latestRun: async () => run,
      latestEvents: async (_: unknown, __: unknown, limit: number) => { assert.equal(limit, 500); return [{ runId: 'run', type: 'assistant.delta', text: 'tail', seq: 1200 }]; },
    },
  } } as never);
  const response = await app.inject('/api/agent/sessions/session/history?limit=2&cursor=previous&includeLatestEvents=1');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, [{ limit: 2, cursor: 'previous' }]);
  const payload = response.json();
  assert.equal(payload.hasMore, true); assert.equal(payload.nextCursor, 'older');
  assert.equal(payload.messages[0].attachments[0].url, '/api/agent/chat-attachments/attachment/content');
  assert.equal(payload.messages[1].text, 'canonical answer');
  assert.equal(payload.messages[1].reasoning, 'thinking');
  assert.deepEqual(payload.messages[1].citations, projection.citations);
  assert.deepEqual(payload.latestRunProjection, projection);
  assert.equal(payload.latestRunEventsTruncated, true);
  assert.equal(payload.latestRun.projection, undefined);
});

test('history/files reject oversized pages and invalid cursors while preserving session 404s', async (t) => {
  const app = Fastify(); t.after(() => app.close());
  await registerRoutes(app, { config: {}, repository: {
    getSession: async (_: unknown, id: string) => id === 'missing' ? null : { id, title: 'named' },
    history: {
      pageRuns: async () => { throw new Error('invalid_history_cursor'); },
      latestRun: async () => null,
      listFiles: async () => { throw new Error('invalid_files_cursor'); },
    },
  } } as never);
  for (const url of ['/history?limit=51', '/history?limit=0', '/history?cursor=bad', '/files?limit=201', '/files?cursor=bad']) {
    assert.equal((await app.inject(`/api/agent/sessions/session${url}`)).statusCode, 400, url);
  }
  for (const endpoint of ['history', 'files']) assert.equal((await app.inject(`/api/agent/sessions/missing/${endpoint}`)).statusCode, 404);
});

test('files reads bounded durable file pages rather than accumulating event ledgers', async (t) => {
  const app = Fastify(); t.after(() => app.close());
  await registerRoutes(app, { config: {}, repository: {
    getSession: async () => ({ id: 'session' }),
    listSessionRuns: async () => { throw new Error('unbounded scan'); },
    history: { listFiles: async (_: unknown, __: unknown, options: unknown) => {
      assert.deepEqual(options, { limit: 10, cursor: 'older' });
      return { files: [{ path: 'src/a.ts', content: 'answer', operation: 'read_file' }], hasMore: true, nextCursor: 'next' };
    } },
  } } as never);
  const response = await app.inject('/api/agent/sessions/session/files?limit=10&cursor=older');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { files: [{ path: 'src/a.ts', content: 'answer', operation: 'read_file' }], hasMore: true, nextCursor: 'next' });
});
