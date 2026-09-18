import assert from 'node:assert/strict';
import test from 'node:test';

import { processMemoryJob } from '../src/memory-consumer.js';

test('memory consumer extracts and persists a durable operation', async () => {
  const upserts: unknown[] = [];
  const completed: string[] = [];
  const repository = {
    getRunForWorker: async () => ({ status: 'completed', userMessage: '我偏好使用 TypeScript' }),
    listEventsForWorker: async () => [],
    getSessionForWorker: async () => null,
    upsertMemory: async (value: unknown) => {
      upserts.push(value);
      return { ...(value as object), id: 'memory-1', tenantId: 'tenant-1', userId: 'user-1', content: '用户偏好 TypeScript', normalizedKey: 'language' };
    },
    deleteMemory: async () => undefined,
    completeMemoryJob: async (id: string) => { completed.push(id); },
  } as never;
  await processMemoryJob(
    repository,
    { id: 'job-1', tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', runId: 'run-1', attempts: 1 },
    { invoke: async () => ({ content: JSON.stringify([{ action: 'insert', kind: 'preference', content: '用户偏好 TypeScript', normalizedKey: 'language', importance: 0.8, confidence: 0.9 }]) }) },
  );
  assert.equal(upserts.length, 1);
  assert.deepEqual(completed, ['job-1']);
});
