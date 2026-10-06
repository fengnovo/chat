import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createDatabase, migrateDatabase, type RunExecutionLease } from '@repo/db';
import type { RunJob } from '@repo/contracts';
import { createFencedCheckpointer } from '../src/fenced-checkpointer.js';

test('checkpoint and pending writes commit only for the current execution owner', {
  skip: process.env.RUN_INTEGRATION_TESTS !== '1',
}, async () => {
  const url = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55433/agent_test';
  assert.match(new URL(url).pathname, /test/i);
  const db = createDatabase(url);
  const context = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
  const saver = new PostgresSaver(db.pool);
  let sessionId = '';
  try {
    await migrateDatabase(db.pool); await saver.setup(); await db.repository.ensureIdentity(context);
    const session = await db.repository.createSession(context, { title: 'fence', workspacePath: `/tmp/fence-${randomUUID()}` });
    sessionId = session.id;
    const { outboxId } = await db.repository.createRun(context, { sessionId, message: 'task' });
    const job = (await db.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [outboxId])).rows[0].payload as RunJob;
    const leaseA = (await db.repository.durable.claimRun(job, 30_000, 'A'))!;
    const fenced = createFencedCheckpointer(saver, db.repository.durable, leaseA);
    const config = { configurable: { thread_id: sessionId }, metadata: { business_run_id: job.runId } };
    const checkpoint = { v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_values: { input: 'task' },
      channel_versions: { input: 1 }, versions_seen: {}, pending_sends: [] };
    await fenced.put(config, checkpoint, { source: 'input', step: -1, parents: {} }, { input: 1 });
    const saved = await saver.getTuple(config);
    assert.equal((saved?.metadata as Record<string, unknown> | undefined)?.business_run_id, job.runId);
    assert.equal((await db.pool.query('SELECT checkpoint_id FROM agent_runs WHERE id=$1', [job.runId])).rows[0].checkpoint_id, checkpoint.id);
    await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.runId]);
    const leaseB = await db.repository.durable.claimRun(job, 30_000, 'B') as RunExecutionLease;
    assert.ok(leaseB.epoch > leaseA.epoch);
    await assert.rejects(fenced.put(config, { ...checkpoint, id: randomUUID() }, { source: 'loop', step: 1, parents: {} }, {}), /lease/i);
    await assert.rejects(fenced.putWrites({ configurable: { thread_id: sessionId, checkpoint_id: checkpoint.id } }, [['answer', 'stale']], 'task-id'), /lease/i);
    assert.equal((await saver.getTuple(config))?.checkpoint.id, checkpoint.id);
    assert.equal((await saver.getTuple(config))?.pendingWrites?.length ?? 0, 0);
  } finally {
    if (sessionId) await saver.deleteThread(sessionId);
    await db.pool.query('DELETE FROM tenants WHERE id=$1', [context.tenantId]);
    await db.pool.query('DELETE FROM users WHERE id=$1', [context.userId]);
    await db.repository.close();
  }
});
