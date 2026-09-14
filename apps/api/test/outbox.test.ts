import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunJob } from '@repo/contracts';
import type { AgentRepository, DispatchOutboxRecord } from '@repo/db';
import type { Queue } from 'bullmq';

import { RunOutboxDispatcher } from '../src/outbox.js';

const job: RunJob = {
  kind: 'start',
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  runId: '00000000-0000-4000-8000-000000000004',
  message: 'test',
  workspacePath: '/tmp/workspace',
  knowledgeBaseIds: [],
  attachments: [],
};

const dispatch: DispatchOutboxRecord = {
  id: '00000000-0000-4000-8000-000000000005',
  tenantId: job.tenantId,
  runId: job.runId,
  job,
  attempts: 1,
};

const logger = {
  error() {},
  warn() {},
};

test('outbox publishes with a stable job id before marking the row complete', async () => {
  const operations: string[] = [];
  let claimed = false;
  const repository = {
    async claimDispatches() {
      if (claimed) return [];
      claimed = true;
      return [dispatch];
    },
    async requeueStaleDispatches() {
      return 0;
    },
    async markDispatchPublished(id: string) {
      operations.push(`published:${id}`);
    },
    async rescheduleDispatch() {
      assert.fail('dispatch should not be rescheduled');
    },
  } as unknown as AgentRepository;
  const queue = {
    async add(_name: string, _data: RunJob, options: { jobId: string }) {
      operations.push(`queued:${options.jobId}`);
    },
  } as unknown as Queue;
  const dispatcher = new RunOutboxDispatcher({
    repository,
    queue,
    logger: logger as never,
    pollIntervalMs: 500,
    batchSize: 10,
    leaseMs: 30_000,
    reconcileIntervalMs: 5_000,
    staleAfterMs: 30_000,
  });

  await dispatcher.drainNow();

  assert.deepEqual(operations, [
    `queued:${dispatch.id}`,
    `published:${dispatch.id}`,
  ]);
});

test('outbox reschedules a failed queue publish', async () => {
  let claimed = false;
  let retry: { id: string; error: string; delayMs: number } | undefined;
  const repository = {
    async claimDispatches() {
      if (claimed) return [];
      claimed = true;
      return [dispatch];
    },
    async requeueStaleDispatches() {
      return 0;
    },
    async markDispatchPublished() {
      assert.fail('failed dispatch must not be marked published');
    },
    async rescheduleDispatch(id: string, error: string, delayMs: number) {
      retry = { id, error, delayMs };
    },
  } as unknown as AgentRepository;
  const queue = {
    async add() {
      throw new Error('redis unavailable');
    },
  } as unknown as Queue;
  const dispatcher = new RunOutboxDispatcher({
    repository,
    queue,
    logger: logger as never,
    pollIntervalMs: 500,
    batchSize: 10,
    leaseMs: 30_000,
    reconcileIntervalMs: 5_000,
    staleAfterMs: 30_000,
  });

  await dispatcher.drainNow();

  assert.deepEqual(retry, {
    id: dispatch.id,
    error: 'redis unavailable',
    delayMs: 250,
  });
});
