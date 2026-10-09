import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepAgentRuntime } from '@repo/agent-core';
import type { RunJob } from '@repo/contracts';
import { buildLongTermMemory } from '../src/processor.js';

test('temporary memory reads preserve runtime compatibility in both outage directions', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const job = { tenantId: 'tenant', userId: 'user', sessionId: 'session', runId: 'run' } as RunJob;
  let unavailable = true;
  const row = {
    id: 'memory', tenantId: job.tenantId, userId: job.userId, projectId: null,
    assistantKey: 'chat', scope: 'global', kind: 'preference', content: 'prefers TypeScript',
    normalizedKey: 'language', importance: 0.7, confidence: 0.9, status: 'active',
    sourceSessionId: job.sessionId, sourceRunId: job.runId, supersedesId: null,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    lastAccessedAt: null, metadata: {},
  };
  const services = {
    memoryStore: {},
    repository: {
      listMemories: async () => { if (unavailable) throw new Error('temporary read outage'); return [row]; },
      upsertMemory: async (input: object) => ({ ...input, id: 'saved-memory' }),
      getMemory: async () => ({ id: 'saved-memory' }),
      deleteMemory: async () => undefined,
    },
  } as never;
  let saved: Record<string, unknown> | undefined;
  const accepted = new Error('descriptor accepted; stop before graph execution');
  for (const failing of [true, false, true, false]) {
    unavailable = failing;
    const memory = await buildLongTermMemory(services, job, null, 'hello', { refreshProfile: false });
    assert.ok(memory, 'retrieval failure must preserve memory capabilities');
    if (failing) assert.equal(memory.context, '');
    else assert.match(memory.context!, /prefers TypeScript/);
    assert.equal(await memory.remember!({ content: 'prefers TypeScript' }), '已记住（id: saved-memory）');
    assert.equal(await memory.forget!('saved-memory'), true);
    await assert.rejects(createDeepAgentRuntime({
      runId: job.runId, sessionId: job.sessionId, workspacePath: '/workspace',
      backend: {}, checkpointer: {}, longTermMemory: memory,
      mcpConfigPath: '/nonexistent/memory-recovery-mcp.json',
      models: [{ id: 'main', model: 'gpt-4o', provider: 'openai', apiKey: 'unused-test-key' }],
      durable: { tools: {} as never, children: {} as never, assertOwnership: async () => {},
        bindRuntimeDescriptor: async (descriptor) => {
          if (saved) assert.deepEqual(descriptor, saved);
          saved = descriptor;
          assert.equal(descriptor.longTermMemoryEnabled, true);
          const names = (descriptor.tools as Array<{ name: string }>).map(({ name }) => name);
          assert.ok(names.includes('remember_fact'));
          assert.ok(names.includes('forget_memory'));
          throw accepted;
        },
      },
    }), (error) => error === accepted);
  }
});
