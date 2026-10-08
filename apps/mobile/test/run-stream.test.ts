import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunStream, SseFrameParser } from '../src/api/run-stream';

const frame = (seq: number, type = 'assistant.delta', runId = 'r1') =>
  `data: ${JSON.stringify({ seq, runId, type, text: '回答' })}\n\n`;

test('SSE handles split CRLF boundaries, multiline data and heartbeats', () => {
  const parser = new SseFrameParser();
  assert.deepEqual(
    parser.push(': heartbeat\r\n\r\ndata: hello\r\ndata: world\r\n\r'),
    [],
  );
  assert.deepEqual(parser.push('\n'), ['hello\nworld']);
});

test('stream skips replayed events and events for a different run', async () => {
  const events: number[] = [];
  let finished = 0;
  const transport: typeof fetch = async () =>
    new Response(
      frame(1) +
        frame(1) +
        frame(99, 'run.completed', 'other') +
        frame(2, 'run.completed'),
    );
  await new Promise<void>((resolve) => {
    createRunStream(transport, 'http://localhost', 'token', 'r1', {
      onEvent: (event) => events.push(event.seq),
      onFinished: () => {
        finished++;
        resolve();
      },
    });
  });
  assert.deepEqual(events, [1, 2]);
  assert.equal(finished, 1);
});

test('closing a subscription suppresses buffered events and terminal callbacks', async () => {
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const events: number[] = [];
  let finished = 0;
  const stream = createRunStream(
    async () => pending,
    'http://localhost',
    'token',
    'r1',
    {
      onEvent: (event) => events.push(event.seq),
      onFinished: () => {
        finished++;
      },
    },
  );
  stream.close();
  release(new Response(frame(1) + frame(2, 'run.completed')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, []);
  assert.equal(finished, 0);
});

test('connection loss resumes with the last accepted cursor and finishes only on a terminal event', async () => {
  const requests: string[] = [];
  const events: number[] = [];
  let reconnecting = 0;
  const transport: typeof fetch = async (url) => {
    requests.push(String(url));
    return new Response(
      requests.length === 1 ? frame(1) : frame(1) + frame(2, 'run.completed'),
    );
  };
  await new Promise<void>((resolve) => {
    createRunStream(transport, 'http://localhost', 'token', 'r1', {
      onEvent: (event) => events.push(event.seq),
      onFinished: resolve,
      onReconnecting: () => {
        reconnecting++;
      },
    });
  });
  assert.deepEqual(events, [1, 2]);
  assert.equal(
    requests[1],
    'http://localhost/api/agent/runs/r1/events?cursor=1',
  );
  assert.equal(reconnecting, 1);
});

test('retry exhaustion reports a connection error without marking the run completed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finished = 0;
  let failed = 0;
  let attempts = 0;
  const stream = createRunStream(
    async () => new Response('', { status: 503 }),
    'http://localhost',
    'token',
    'r1',
    {
      onEvent: () => assert.fail('no data expected'),
      onFinished: () => {
        finished++;
      },
      onError: () => {
        failed++;
      },
      onReconnecting: (attempt) => {
        attempts = attempt;
      },
    },
  );
  for (let index = 0; index < 32; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
  }
  assert.equal(attempts, 30);
  assert.equal(failed, 1);
  assert.equal(finished, 0);
  stream.close();
});
