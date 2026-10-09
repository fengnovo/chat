import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { startMemoryRuntime } from '../src/memory-runtime.js';

// Production startup must drain the durable queue even if Redis never publishes a hint.
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
      getRunForWorker: async () => null, // Superseded/deleted run: no provider request is needed.
      completeMemoryJob: async (id: string) => { completed.push(id); resolveCompleted(); },
    } as never,
    models: [{ id: 'test', model: 'offline', provider: 'openai', apiKey: 'test-only' }],
    intervalMs: 5,
  });
  let deadline: NodeJS.Timeout | undefined;
  try {
    await nextTurn();
    pending = true; // Work becomes durable after startup; no Redis job is delivered.
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
