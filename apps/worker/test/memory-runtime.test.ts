import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { startMemoryRuntime } from '../src/memory-runtime.js';

// 即使 Redis 从未发布提示，生产启动流程也必须清空持久化队列。
test('memory runtime polls durable work without receiving a Redis job and drains before shutdown', async () => {
  const completed: string[] = [];
  let pending = false;
  let resolveCompleted: () => void;
  const done = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const runtime = startMemoryRuntime({
    repository: {
      claimMemoryJob: async () => {
        if (!pending) return null;
        pending = false;
        return { id: 'memory-job', tenantId: 'tenant', userId: 'user', sessionId: 'session', runId: 'run', attempts: 1 };
      },
      getRunForWorker: async () => null, // 运行已被替代或删除：无需请求供应商。
      completeMemoryJob: async (id: string) => { completed.push(id); resolveCompleted(); },
    } as never,
    models: [{ id: 'test', model: 'offline', provider: 'openai', apiKey: 'test-only' }],
    intervalMs: 5,
  });
  let deadline: NodeJS.Timeout | undefined;
  try {
    await nextTurn();
    pending = true; // 启动后任务才持久化；此时不会投递 Redis 作业。
    await Promise.race([done, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('durable memory job was not polled')), 500); })]);
    await runtime.stop();
    assert.deepEqual(completed, ['memory-job']);
  } finally { clearTimeout(deadline); await runtime.stop(); }
});

test('memory runtime shutdown waits for an already claimed durable job', async () => {
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const runtime = startMemoryRuntime({
    repository: {
      claimMemoryJob: async () => ({ id: 'job', tenantId: 'tenant', userId: 'user', sessionId: 'session', runId: 'run', attempts: 1 }),
      getRunForWorker: async () => { await gate; return null; },
      completeMemoryJob: async () => { completed = true; },
    } as never,
    models: [{ id: 'test', model: 'offline', provider: 'openai', apiKey: 'test-only' }],
  });
  let stopped = false;
  const stop = runtime.stop().then(() => { stopped = true; });
  try {
    await nextTurn();
    assert.equal(stopped, false);
    release!();
    await stop;
    assert.equal(completed, true);
  } finally { release!(); await stop; }
});
