import assert from 'node:assert/strict';
import test from 'node:test';

import type { PersistedAgentEvent } from '@repo/contracts';

import { chunksFrom, createCoalescedRunner } from '../src/chat-stream.js';

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
