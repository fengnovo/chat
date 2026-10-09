import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes.js';

const id = '33333333-3333-4333-8333-333333333333';
test('generic run creation validates and forwards ready attachments to the worker', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let received: any;
  let records = [
    {
      id,
      kind: 'text',
      filename: 'note.md',
      objectKey: 'test/note',
      contentType: 'text/markdown',
      sizeBytes: 8,
    },
  ];
  await registerRoutes(app, {
    config: {},
    repository: {
      getSession: async () => ({ id: 'session' }),
      getReadyChatAttachments: async () => records,
      createRun: async (_: unknown, input: unknown) => {
        received = input;
        return { run: { id: 'run' }, created: true };
      },
    },
    outbox: { wake() {} },
  } as never);
  const response = await app.inject({
    method: 'POST',
    url: '/api/agent/sessions/session/runs',
    payload: { message: '读取附件', attachmentIds: [id] },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(received.attachments, records);
  records = [];
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/agent/sessions/session/runs',
    payload: { message: '读取附件', attachmentIds: [id] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'invalid_attachment');
});

test('mobile history optionally restores the latest run persisted events', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const events = [
    {
      type: 'todo.updated',
      runId: 'run',
      seq: 1,
      todos: [{ content: '继续', status: 'in_progress' }],
    },
  ];
  await registerRoutes(app, {
    config: {},
    repository: {
      getSession: async () => ({ id: 'session' }),
      history: {
        pageRuns: async () => ({ runs: [{ id: 'run', status: 'waiting_question', userMessage: 'hello', projection: { text: '', reasoning: '', citations: [], lastSeq: 1 } }], hasMore: false, nextCursor: null }),
        latestRun: async () => ({ id: 'run', status: 'waiting_question', lastEventSeq: 1, projection: { text: '', reasoning: '', citations: [], lastSeq: 1 } }),
        latestEvents: async () => events,
      },
      listChatAttachmentsByRuns: async () => new Map(),
    },
  } as never);
  const normal = await app.inject('/api/agent/sessions/session/history');
  assert.equal(normal.json().latestRunEvents, undefined);
  const mobile = await app.inject(
    '/api/agent/sessions/session/history?includeLatestEvents=1',
  );
  assert.deepEqual(mobile.json().latestRunEvents, events);
  assert.equal(mobile.json().latestRun.status, 'waiting_question');
});

test('opening legacy untitled history repairs the title from the first user run', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let title = '新会话';
  await registerRoutes(app, {
    config: {},
    repository: {
      getSession: async () => ({ id: 's', title }),
      history: {
        firstUserRun: async () => ({ id: 'r', userMessage: '原始问题\n详细描述' }),
        pageRuns: async () => ({ runs: [], hasMore: false, nextCursor: null }),
        latestRun: async () => null,
      },
      setInitialSessionTitle: async (
        _: unknown,
        _id: string,
        firstTitle: string,
      ) => {
        title = firstTitle;
        return { id: 's', title };
      },
      listEvents: async () => [],
      listChatAttachmentsByRuns: async () => new Map(),
    },
  } as never);
  const response = await app.inject('/api/agent/sessions/s/history');
  assert.equal(response.json().session.title, '原始问题');
  title = '用户改的标题';
  const custom = await app.inject('/api/agent/sessions/s/history');
  assert.equal(custom.json().session.title, '用户改的标题');
});
