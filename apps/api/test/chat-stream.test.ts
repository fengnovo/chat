import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import type { PersistedAgentEvent } from '@repo/contracts';
import Fastify from 'fastify';

import { chunksFrom, createChunkEncoder, createCoalescedRunner, streamWorkflowRun } from '../src/chat-stream.js';
import { streamAgentEvents } from '../src/sse.js';

const runId = '00000000-0000-4000-8000-000000000001';

for (const [name, stream] of [['workflow', streamWorkflowRun], ['raw events', streamAgentEvents]] as const) {
  test(`${name} waits for socket drain before sending the next event`, async () => {
    const events: PersistedAgentEvent[] = [
      { runId, seq: 1, timestamp: new Date().toISOString(), type: 'assistant.delta', text: 'hello' },
      { runId, seq: 2, timestamp: new Date().toISOString(), type: 'run.completed' },
    ];
    const written: string[] = [];
    let ended = false;
    const raw = Object.assign(new EventEmitter(), {
      setHeader() {}, writeHead() {}, flushHeaders() {}, writableLength: 0,
      write(value: string) { written.push(value); return written.length !== 1; }, end() { ended = true; },
    });
    const services = {
      repository: {
        getRun: async () => ({ id: runId, status: 'completed' }),
        listEvents: async (_auth: unknown, _id: string, cursor: number, limit = 500) => events.filter((event) => event.seq > cursor).slice(0, limit),
      },
      streamSubscriptions: { subscribe: async () => () => {} },
    };
    const running = stream({ auth: {}, headers: {}, query: {}, log: { warn() {} } } as never,
      { raw, hijack() {}, getHeaders: () => ({}) } as never, services as never, runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(written.length, 1, 'a blocked connection must not accumulate more frames');
    assert.equal(ended, false);
    raw.emit('drain');
    await running;
    assert.match(written.join(''), /hello/);
    assert.equal(ended, true);
    assert.equal(raw.listenerCount('drain'), 0);
  });
  test(`${name} replays long runs in bounded database pages`, async () => {
    const timestamp = new Date().toISOString();
    const events: PersistedAgentEvent[] = Array.from({ length: 1200 }, (_, i) => ({ runId, seq: i + 1, timestamp, type: 'assistant.delta', text: 'x' }));
    events.push({ runId, seq: 1201, timestamp, type: 'run.completed' });
    const requestedLimits: number[] = [];
    let output = '';
    const raw = Object.assign(new EventEmitter(), {
      setHeader() {}, writeHead() {}, flushHeaders() {},
      write(value: string) { output += value; return true; }, end() {},
    });
    const services = {
      repository: {
        getRun: async () => ({ id: runId, status: 'completed' }),
        listEvents: async (_auth: unknown, _id: string, cursor: number, limit = 500) => {
          requestedLimits.push(limit);
          return events.filter((event) => event.seq > cursor).slice(0, limit);
        },
      }, streamSubscriptions: { subscribe: async () => () => {} },
    };
    await stream({ auth: {}, headers: {}, query: {}, log: { warn() {} } } as never,
      { raw, hijack() {}, getHeaders: () => ({}) } as never, services as never, runId);
    assert.ok(requestedLimits.length >= 3);
    assert.ok(requestedLimits.every((limit) => limit <= 500));
    assert.match(output, /run.completed/);
    if (name === 'workflow') assert.equal((output.match(/text-delta/g) ?? []).length, 1200);
  });
}

test('snapshots replace stale text and keep subsequent deltas in a new text part', () => {
  const timestamp = new Date().toISOString();
  const events: PersistedAgentEvent[] = [
    { runId, seq: 1, timestamp, type: 'assistant.delta', text: 'unfinished' },
    { runId, seq: 2, timestamp, type: 'assistant.snapshot', text: '' },
    { runId, seq: 3, timestamp, type: 'assistant.delta', text: 'answer' },
    { runId, seq: 4, timestamp, type: 'assistant.snapshot', text: 'correct answer' },
    { runId, seq: 5, timestamp, type: 'run.completed' },
  ];
  const encode = createChunkEncoder(runId);
  const chunks = events.flatMap((event) => encode([event]));
  assert.deepEqual(chunks, chunksFrom(runId, events));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'data-text-recovery').map((chunk) => [chunk.data, chunk.transient]), [
    [{ text: '' }, false], [{ text: 'correct answer' }, false],
  ]);
  const starts = chunks.filter((chunk) => chunk.type === 'text-start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]!.id, starts[1]!.id);
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-end').length, 2);
  assert.equal(chunks[chunks.findIndex((chunk) => chunk.type === 'data-text-recovery') - 1]!.type, 'text-end');
});

for (const [name, stream] of [['workflow', streamWorkflowRun], ['raw events', streamAgentEvents]] as const) {
  test(`${name} heartbeat delivers durable completion without a Redis notification`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const events: PersistedAgentEvent[] = [];
    const written: string[] = [];
    let ended = false;
    const raw = Object.assign(new EventEmitter(), {
      setHeader() {}, writeHead() {}, flushHeaders() {},
      write(value: string) { written.push(value); }, end() { ended = true; },
    });
    const services = {
      repository: {
        getRun: async () => ({ id: runId, status: events.length ? 'completed' : 'running' }),
        listEvents: async (_auth: unknown, _id: string, cursor: number) => events.filter((event) => event.seq > cursor),
      },
      streamSubscriptions: { subscribe: async () => () => {} },
    };
    await stream({ auth: {}, headers: {}, query: {}, log: { warn() {} } } as never,
      { raw, hijack() {}, getHeaders: () => ({}) } as never, services as never, runId);
    events.push({ runId, seq: 1, timestamp: new Date().toISOString(), type: 'assistant.snapshot', text: 'recovered answer' },
      { runId, seq: 2, timestamp: new Date().toISOString(), type: 'run.completed' });
    t.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(written.join(''), /recovered answer/);
    assert.equal(ended, true);
    raw.emit('close');
  });
}

test('raw SSE drains events committed between its last read and terminal status check', async () => {
  const events: PersistedAgentEvent[] = [];
  const written: string[] = [];
  let runReads = 0;
  let ended = false;
  const raw = Object.assign(new EventEmitter(), {
    setHeader() {}, writeHead() {}, flushHeaders() {},
    write(value: string) { written.push(value); }, end() { ended = true; },
  });
  const services = {
    repository: {
      getRun: async () => {
        if (++runReads === 2) events.push({ runId, seq: 1, timestamp: new Date().toISOString(), type: 'run.completed' });
        return { id: runId, status: events.length ? 'completed' : 'running' };
      },
      listEvents: async (_auth: unknown, _id: string, cursor: number) => events.filter((event) => event.seq > cursor),
    },
    streamSubscriptions: { subscribe: async () => () => {} },
  };
  await streamAgentEvents({ auth: {}, headers: {}, query: {}, log: { warn() {} } } as never,
    { raw, hijack() {}, getHeaders: () => ({}) } as never, services as never, runId);
  assert.match(written.join(''), /run.completed/);
  assert.equal(ended, true);
});

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

test('incremental event batches preserve one message and one continuous text stream', () => {
  const timestamp = new Date().toISOString();
  const events: PersistedAgentEvent[] = [
    { runId, seq: 1, timestamp, type: 'run.started' },
    { runId, seq: 2, timestamp, type: 'assistant.delta', text: '第一段' },
    { runId, seq: 3, timestamp, type: 'assistant.delta', text: '第二段' },
    { runId, seq: 4, timestamp, type: 'run.completed' },
  ];
  const encode = createChunkEncoder(runId);
  assert.deepEqual(encode([]), []);
  const incremental = events.flatMap((event) => encode([event]));
  assert.deepEqual(incremental, chunksFrom(runId, events));
  assert.deepEqual(encode(events), [], 'terminal event must not replay the stream');
});

test('live SSE sends partial text before completion and reads only new events', { timeout: 5000 }, async (t) => {
  const timestamp = new Date().toISOString();
  const events: PersistedAgentEvent[] = [
    { runId, seq: 1, timestamp, type: 'run.started' },
    { runId, seq: 2, timestamp, type: 'assistant.delta', text: '第一段' },
  ];
  const afterSeqs: number[] = [];
  let notify: (() => void) | undefined;
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const services = {
    repository: {
      getRun: async () => ({ id: runId, status: 'running' }),
      listEvents: async (_auth: unknown, _runId: string, afterSeq: number) => {
        afterSeqs.push(afterSeq);
        return events.filter((event) => event.seq > afterSeq);
      },
    },
    streamSubscriptions: {
      subscribe: async (_channel: string, callback: () => void) => {
        notify = callback;
        return () => {};
      },
    },
  };
  app.get('/stream', async (request, reply) => streamWorkflowRun(request, reply, services as never, runId));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/stream`);
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const readUntil = async (snippet: string) => {
    while (!received.includes(snippet)) {
      const result = await reader.read();
      assert.equal(result.done, false, `stream ended before ${snippet}`);
      received += decoder.decode(result.value, { stream: true });
    }
  };
  await readUntil('第一段');
  assert.equal(received.includes('finish'), false);

  events.push({ runId, seq: 3, timestamp, type: 'assistant.delta', text: '第二段' });
  notify?.();
  await readUntil('第二段');
  assert.equal(received.includes('finish'), false);

  events.push({ runId, seq: 4, timestamp, type: 'run.completed' });
  notify?.();
  await readUntil('"type":"finish"');
  assert.equal(afterSeqs[0], 0);
  assert.equal(afterSeqs.slice(1).every((seq) => seq > 0), true);
  assert.equal(afterSeqs.includes(3), true);
  assert.equal((received.match(/"type":"text-start"/g) ?? []).length, 1);

  const tailResponse = await fetch(`${address}/stream?startIndex=999`);
  assert.equal(tailResponse.status, 200);
  assert.equal(await tailResponse.text(), '', 'a completed run must close even when no replay chunks remain');
});

test('a terminal task failure stays in the agent event channel', () => {
  const events: PersistedAgentEvent[] = [
    { runId, seq: 1, timestamp: new Date().toISOString(), type: 'run.started' },
    {
      runId,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'run.failed',
      code: 'model_quota_exhausted',
      message: 'The configured model quota is exhausted',
    },
  ];

  const chunks = chunksFrom(runId, events);

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['start', 'data-agent', 'data-agent', 'finish'],
  );
  assert.equal(chunks.some((chunk) => chunk.type === 'error'), false);
  assert.equal(chunks.at(-1)?.finishReason, 'error');
});

test('usage updates and the final todo snapshot survive into the stream', () => {
  // 对应线上问题：run 很长的结果里，收尾事件与最后一次 todo 快照必须都在，
  // 否则前端会停在「正在执行」且任务计划停在中间状态。
  const events: PersistedAgentEvent[] = [
    { runId, seq: 1, timestamp: new Date().toISOString(), type: 'run.started' },
    {
      runId,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'usage.updated',
      inputTokens: 9_010,
      outputTokens: 587,
      totalTokens: 9_597,
    },
    {
      runId,
      seq: 3,
      timestamp: new Date().toISOString(),
      type: 'todo.updated',
      todos: [{ content: 'Scaffold project', status: 'completed' }],
    },
    { runId, seq: 4, timestamp: new Date().toISOString(), type: 'run.completed' },
  ];

  const chunks = chunksFrom(runId, events);
  assert.equal(chunks.at(-1)?.type, 'finish');
  assert.equal(chunks.at(-1)?.finishReason, 'stop');
  const todoEvent = chunks.find(
    (chunk) =>
      chunk.type === 'data-agent' &&
      (chunk.data as { type?: string } | undefined)?.type === 'todo.updated',
  );
  assert.ok(todoEvent, 'final todo snapshot must reach the client');
  const usageEvent = chunks.find(
    (chunk) =>
      chunk.type === 'data-agent' &&
      (chunk.data as { type?: string } | undefined)?.type === 'usage.updated',
  );
  assert.ok(usageEvent, 'usage deltas must reach the client');
});

test('a notification arriving mid-flush is replayed instead of being dropped', async () => {
  // 回归：最后一次通知撞上进行中的 flush 时曾被直接丢弃，
  // 导致 finish 永不发送、前端卡在「正在执行」。
  let runs = 0;
  let release: () => void = () => {};
  const run = createCoalescedRunner(async () => {
    runs += 1;
    if (runs === 1) {
      // 第一次执行期间，模拟收到新的订阅通知。
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return false;
    }
    return true;
  });

  const first = run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 1);

  // flush 进行中到来的通知：必须被记住并在之后重跑。
  const second = run();
  release();
  await Promise.all([first, second]);

  assert.equal(runs, 2, 'the mid-flight notification must trigger a rerun');
});

test('a coalesced runner stops rerunning once the task reports completion', async () => {
  let runs = 0;
  const run = createCoalescedRunner(async () => {
    runs += 1;
    return true;
  });
  await run();
  await run();
  assert.equal(runs, 2);
});

test('retrieval completion keeps the transient trace and emits bounded persistent citations', () => {
  const retrieval = {
    runId,
    seq: 1,
    timestamp: new Date().toISOString(),
    type: 'retrieval.completed' as const,
    retrievalId: '00000000-0000-4000-8000-000000000002',
    toolCallId: 'tool-1',
    knowledgeBaseIds: [],
    query: 'hello',
    citations: [{
      chunkId: '00000000-0000-4000-8000-000000000003',
      kbId: '00000000-0000-4000-8000-000000000005',
      documentId: '00000000-0000-4000-8000-000000000004',
      documentName: 'guide.md',
      ordinal: 2,
      heading: 'Intro',
      score: 0.91,
      via: 'vector' as const,
    }],
    relations: [],
    stats: { vectorHits: 1, graphHops: 0, searchedKbs: 0, durationMs: 5, truncated: false },
  };
  const citationChunk = chunksFrom(runId, [retrieval]).find((chunk) => chunk.type === 'data-citations');
  assert.deepEqual((citationChunk?.data as { citations?: unknown[] })?.citations, retrieval.citations);
  assert.equal(citationChunk?.transient, false);
  assert.ok(chunksFrom(runId, [retrieval]).some((chunk) => chunk.type === 'data-agent'));
  const trace = chunksFrom(runId, [retrieval]).find((chunk) => chunk.type === 'data-agent');
  assert.equal((trace?.data as { citations?: unknown[] }).citations, undefined);
  assert.equal(JSON.stringify(citationChunk).includes('passage'), false);
});

test('subagent lifecycle emits persistent data-subagent parts and keeps the agent trace', () => {
  // 子 Agent 卡片依赖 data-subagent part 持久化（transient: false），
  // 刷新后才能从消息 parts 重建；同时 data-agent 过程流必须照常保留。
  const events: PersistedAgentEvent[] = [
    {
      runId,
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'subagent.started',
      subagentId: 'sub-1',
      role: '依赖调研员',
      description: '检索依赖的最新版本',
      attempt: 1,
    },
    {
      runId,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'subagent.completed',
      subagentId: 'sub-1',
      attempt: 1,
      status: 'completed',
      summary: '已确认版本',
      toolCalls: 3,
      durationMs: 12_345,
    },
    {
      runId,
      seq: 3,
      timestamp: new Date().toISOString(),
      type: 'subagent.reviewed',
      subagentId: 'sub-1',
      attempt: 1,
      passed: true,
      score: 92,
      feedback: '',
      checklist: [{ item: '给出依赖版本', met: true }],
    },
  ];

  const chunks = chunksFrom(runId, events);
  const subagentChunks = chunks.filter((chunk) => chunk.type === 'data-subagent');
  assert.equal(subagentChunks.length, 3);
  assert.equal(subagentChunks.every((chunk) => chunk.transient === false), true);
  assert.equal(
    (subagentChunks[0]?.data as { type?: string }).type,
    'subagent.started',
  );
  assert.equal(
    (subagentChunks[1]?.data as { status?: string }).status,
    'completed',
  );
  assert.equal(
    (subagentChunks[2]?.data as { type?: string }).type,
    'subagent.reviewed',
  );
  assert.equal(chunks.filter((chunk) => chunk.type === 'data-agent').length, 3);
});
