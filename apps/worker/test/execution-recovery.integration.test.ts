import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DockerSandboxBackend } from '@repo/agent-core';
import { createDatabase, migrateDatabase } from '@repo/db';
import type { RunJob } from '@repo/contracts';
import { Redis } from 'ioredis';
import { loadWorkerConfig } from '../src/config.js';
import { buildHostExecutionDescriptor } from '../src/execution-compatibility.js';
import { createRunProcessor } from '../src/processor.js';

// Real repository ownership + Redis session lock; external runtime effects stop at the sandbox boundary.
test('changed runtime recovery writes one terminal failure and never starts a sandbox', { skip: process.env.RUN_INTEGRATION_TESTS !== '1' }, async (t) => {
  const url = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55433/agent_test';
  assert.match(new URL(url).pathname, /test/i);
  const db = createDatabase(url);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56389', { maxRetriesPerRequest: 1 });
  const context = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
  let sandboxAcquisitions = 0;
  t.mock.method(DockerSandboxBackend, 'create', async () => { sandboxAcquisitions++; throw new Error('Unexpected sandbox acquisition'); });
  try {
    await migrateDatabase(db.pool); await db.repository.ensureIdentity(context);
    const session = await db.repository.createSession(context, { title: 'Compatibility integration', workspacePath: `/tmp/recovery-contract-${randomUUID()}` });
    const created = await db.repository.createRun(context, { sessionId: session.id, message: 'test' });
    const job = (await db.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [created.outboxId])).rows[0].payload as RunJob;
    const original = loadWorkerConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'offline-only', MODEL: 'openai:old-model' });
    const lease = await db.repository.durable.claimRun(job, 60_000, 'old-worker'); assert.ok(lease);
    await db.repository.durable.bindExecutionDescriptor(lease, await buildHostExecutionDescriptor(original, job));
    await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.runId]);
    const processor = createRunProcessor({
      config: loadWorkerConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'offline-only', MODEL: 'openai:new-model' }),
      repository: db.repository, redis, publisher: redis, controllers: new Map(), workerId: 'new-worker',
      checkpointer: {} as never, artifacts: {} as never, memoryStore: {}, memoryQueue: {} as never,
    });
    await processor({ id: created.outboxId, data: job } as never);
    await processor({ id: created.outboxId, data: job } as never);
    const run = await db.repository.getRunForWorker(context.tenantId, job.runId);
    assert.equal(run?.status, 'failed'); assert.equal(run?.errorCode, 'RECOVERY_INCOMPATIBLE');
    const events = await db.repository.listEventsForWorker(context.tenantId, job.runId);
    assert.equal(events.length, 1); assert.equal(events[0]?.type, 'run.failed');
    assert.equal(sandboxAcquisitions, 0);
    assert.equal(await db.repository.durable.claimRun(job, 60_000, 'another-worker'), null);
  } finally {
    await redis.quit();
    await db.pool.query('DELETE FROM tenants WHERE id=$1', [context.tenantId]);
    await db.pool.query('DELETE FROM users WHERE id=$1', [context.userId]);
    await db.repository.close();
  }
});
