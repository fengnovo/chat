import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AuthContext, RunJob } from '@repo/contracts';
import { createDatabase, migrateDatabase, RepositoryConflictError, RepositoryNotFoundError } from '../src/index.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';
const connectionString = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55433/agent_test';

test('execution business contracts survive concurrent submissions and terminal transitions', { skip: !enabled }, async (t) => {
  assert.match(new URL(connectionString).pathname, /test/i);
  const db = createDatabase(connectionString);
  const owner: AuthContext = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
  const other = { ...owner, userId: randomUUID() };
  try {
    await migrateDatabase(db.pool);
    await db.repository.ensureIdentity(owner);
    await db.repository.ensureIdentity(other);
    const session = async (context = owner) => db.repository.createSession(context, { title: 'Contract test', workspacePath: `/tmp/contract-${randomUUID()}` });
    const fixture = async () => {
      const s = await session();
      const created = await db.repository.createRun(owner, { sessionId: s.id, message: 'hello' });
      const dispatch = await db.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [created.outboxId]);
      const job = dispatch.rows[0].payload as RunJob;
      const lease = await db.repository.durable.claimRun(job, 60_000, 'contract-worker');
      assert.ok(lease);
      return { job, lease };
    };

    await t.test('same idempotency key is private to its user and session', async () => {
      const [a, b, c] = await Promise.all([session(), session(other), session()]);
      const key = randomUUID();
      const results = await Promise.all([
        db.repository.createRun(owner, { sessionId: a.id, message: 'owner', idempotencyKey: key }),
        db.repository.createRun(other, { sessionId: b.id, message: 'other', idempotencyKey: key }),
        db.repository.createRun(owner, { sessionId: c.id, message: 'another session', idempotencyKey: key }),
      ]);
      assert.equal(new Set(results.map((result) => result.run.id)).size, 3);
      assert.ok(results.every((result) => result.created));
      await assert.rejects(db.repository.createRun(other, { sessionId: a.id, message: 'owner', idempotencyKey: key }), (error) => error instanceof RepositoryNotFoundError);
    });

    await t.test('concurrent identical requests create one run and one dispatch', async () => {
      const s = await session();
      const request = { sessionId: s.id, message: 'once', idempotencyKey: randomUUID() };
      const results = await Promise.all(Array.from({ length: 8 }, () => db.repository.createRun(owner, request)));
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(new Set(results.map((result) => result.run.id)).size, 1);
      const rows = await db.pool.query('SELECT count(*)::integer AS count FROM run_dispatch_outbox WHERE run_id=$1', [results[0]!.run.id]);
      assert.equal(rows.rows[0].count, 1);
    });

    await t.test('reused keys reject changed message, continuation, knowledge snapshot and attachment payload', async () => {
      const s = await session();
      const request = { sessionId: s.id, message: 'once', idempotencyKey: randomUUID() };
      await db.repository.createRun(owner, request);
      for (const patch of [
        { message: 'changed' }, { continuation: true }, { knowledgeBaseIds: [randomUUID()] },
        { attachments: [{ id: randomUUID(), kind: 'text' as const, filename: 'notes.txt', objectKey: 'object', contentType: 'text/plain', sizeBytes: 3, sha256: 'abc' }] },
      ]) {
        await assert.rejects(db.repository.createRun(owner, { ...request, ...patch }), (error) => error instanceof RepositoryConflictError && error.code === 'idempotency_conflict');
      }
    });

    await t.test('linked attachments replay canonically and every attachment field participates in the request identity', async () => {
      const s = await session();
      const attachment = { id: randomUUID(), kind: 'text' as const, filename: 'notes.txt', objectKey: 'test/notes', contentType: 'text/plain', sizeBytes: 3 };
      await db.repository.createChatAttachment(owner, { ...attachment, sha256: 'test-only-content-hash' });
      await db.repository.markChatAttachmentReady(owner, attachment.id);
      const request = { sessionId: s.id, message: 'read attachment', idempotencyKey: randomUUID(), attachments: [attachment] };
      const created = await db.repository.createRun(owner, request);
      const ready = await db.repository.getReadyChatAttachments(owner, [attachment.id]);
      assert.equal(ready[0]?.runId, created.run.id);
      const replay = await db.repository.createRun(owner, { ...request, attachments: [{ sizeBytes: 3, contentType: 'text/plain', objectKey: 'test/notes', filename: 'notes.txt', kind: 'text', id: attachment.id }] });
      assert.equal(replay.created, false); assert.equal(replay.run.id, created.run.id);
      for (const patch of [{ filename: 'changed.txt' }, { objectKey: 'test/other' }, { contentType: 'text/csv' }, { sizeBytes: 4 }, { kind: 'file' as const }, { contentEncoding: 'gzip' as const }]) {
        await assert.rejects(db.repository.createRun(owner, { ...request, attachments: [{ ...attachment, ...patch }] }), (error) => error instanceof RepositoryConflictError && error.code === 'idempotency_conflict');
      }
    });

    await t.test('completion creates memory extraction intent in the event transaction', async () => {
      const { job, lease } = await fixture();
      const event = { runId: job.runId, timestamp: new Date().toISOString(), type: 'run.completed' as const };
      await db.repository.durable.appendEvent(lease, event);
      await db.repository.durable.appendEvent(lease, event);
      const jobs = await db.pool.query('SELECT tenant_id,user_id,session_id,run_id FROM memory_jobs WHERE run_id=$1', [job.runId]);
      assert.deepEqual(jobs.rows, [{ tenant_id: owner.tenantId, user_id: owner.userId, session_id: job.sessionId, run_id: job.runId }]);
      const second = await fixture();
      await assert.rejects(db.repository.durable.withLease(second.lease, async (client) => {
        await client.query("UPDATE agent_runs SET status='completed' WHERE id=$1", [second.job.runId]);
        throw new Error('rollback terminal transition');
      }), /rollback terminal transition/);
      assert.equal((await db.pool.query('SELECT 1 FROM memory_jobs WHERE run_id=$1', [second.job.runId])).rowCount, 0);
      assert.equal((await db.repository.getRunForWorker(owner.tenantId, second.job.runId))?.status, 'running');
    });

    await t.test('new runs can finish descriptor preparation after an early worker crash', async () => {
      for (const alreadyBoundHost of [false, true]) {
        const { job, lease } = await fixture();
        const host = {runtimeVersion:'preparing-v1'};
        if (alreadyBoundHost) await db.repository.durable.bindExecutionDescriptor(lease, host, 'host');
        await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.runId]);
        const recovered = await db.repository.durable.claimRun(job, 60_000, 'recovered-preparation');
        assert.ok(recovered?.recovery);
        await db.repository.durable.bindExecutionDescriptor(recovered, host, 'host');
        await db.repository.durable.bindExecutionDescriptor(recovered, {graphVersion:'graph-v1'}, 'agent');
        assert.equal((await db.repository.getRunForWorker(owner.tenantId, job.runId))?.status, 'running');
      }
      // 滚动部署期间或旧版消费者可能创建未绑定新描述符的执行凭据。
      // 创建标记不能据此认定该凭据兼容。
      for (const evidence of ['event','tool','child'] as const) {
        const {job,lease} = await fixture();
        if (evidence === 'event') await db.repository.durable.appendEvent(lease,{runId:job.runId,timestamp:new Date().toISOString(),type:'run.started'});
        if (evidence === 'child') await db.repository.durable.ensureChild(lease,'spawn',{},true);
        if (evidence === 'tool') await db.repository.durable.beginTool(lease,{scopeId:'root',toolCallId:'call',toolName:'execute',inputHash:'hash',input:{},replayPolicy:'unsafe'});
        await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.runId]);
        const recovered = await db.repository.durable.claimRun(job,60_000,'replacement'); assert.ok(recovered);
        await assert.rejects(db.repository.durable.bindExecutionDescriptor(recovered,{runtimeVersion:'1'},'host'),{code:'RECOVERY_DESCRIPTOR_MISSING'});
      }
    });

    await t.test('terminal parents cancel every live child and expose authorized waiting ownership', async () => {
      for (const type of ['run.completed', 'run.failed', 'run.cancelled'] as const) {
        const { job, lease } = await fixture();
        const child = await db.repository.durable.ensureChild(lease, 'spawn', { task: 'research' }, true);
        await assert.rejects(db.repository.durable.saveChild(lease, child.id, { threadId: 'different-phase-identity' }), /identity|patch/i);
        await db.repository.durable.saveChild(lease, child.id, { status: 'waiting', feedback: 'awaiting reviewer' });
        const done = await db.repository.durable.ensureChild(lease, 'done', {}, false);
        await db.repository.durable.saveChild(lease, done.id, { status: 'completed', summary: 'done' });
        const tasks = await db.repository.listRunTasks(owner, job.runId);
        assert.ok(tasks);
        assert.equal(tasks.children.find((item) => item.id === child.id)?.waitingReason, 'awaiting reviewer');
        assert.equal(tasks.owner.workerId, 'contract-worker');
        assert.equal(tasks.owner.leaseEpoch, lease.epoch);
        assert.equal(await db.repository.listRunTasks(other, job.runId), null);
        const terminal = type === 'run.failed'
          ? { runId: job.runId, timestamp: new Date().toISOString(), type, code: 'FAIL', message: 'failure' }
          : { runId: job.runId, timestamp: new Date().toISOString(), type };
        await db.repository.durable.appendEvent(lease, terminal);
        assert.equal((await db.repository.durable.getChild(lease, child.id))?.status, 'cancelled');
        assert.equal((await db.repository.durable.getChild(lease, done.id))?.status, 'completed');
        await assert.rejects(db.repository.durable.saveChild(lease, child.id, { status: 'running' }), /terminal|cancelled/i);
      }
    });

    await t.test('cancelling a waiting parent persists terminal execution state and child cancellation', async () => {
      const { job, lease } = await fixture();
      const child = await db.repository.durable.ensureChild(lease, 'waiting-child', {}, true);
      await db.repository.durable.appendEvent(lease, {
        runId: job.runId, timestamp: new Date().toISOString(), type: 'question.required', interruptId: 'pause',
        question: { question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }], multiple: false, allowCustom: true },
      });
      await db.repository.durable.releaseLease(lease);
      await db.repository.requestCancellation(owner, job.runId);
      const tasks = await db.repository.listRunTasks(owner, job.runId);
      assert.equal(tasks?.status, 'cancelled');
      assert.equal(tasks?.executionState, 'terminal');
      assert.equal(tasks?.waitingReason, null);
      assert.equal(tasks?.children.find((item) => item.id === child.id)?.status, 'cancelled');
    });

    await t.test('descriptor equality survives JSON key ordering and incompatible recovery is refused', async () => {
      const { job, lease } = await fixture();
      await db.repository.durable.bindExecutionDescriptor(lease, { runtimeVersion: '1', models: [{ model: 'test', maxTokens: 1000 }] });
      await db.repository.durable.bindExecutionDescriptor(lease, { tools: [{ name: 'read', schemaHash: 'test-schema' }] }, 'agent');
      await db.repository.durable.bindExecutionDescriptor(lease, { models: [{ maxTokens: 1000, model: 'test' }], runtimeVersion: '1' });
      await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.runId]);
      const recovered = await db.repository.durable.claimRun(job, 60_000, 'replacement'); assert.ok(recovered);
      await db.repository.durable.bindExecutionDescriptor(recovered, { runtimeVersion: '1', models: [{ model: 'test', maxTokens: 1000 }] });
      await assert.rejects(db.repository.durable.bindExecutionDescriptor(recovered, { runtimeVersion: '2', models: [{ model: 'test', maxTokens: 1000 }] }), { code: 'RECOVERY_INCOMPATIBLE' });
      await assert.rejects(db.repository.durable.bindExecutionDescriptor(lease, { runtimeVersion: '1' }), { code: 'EXECUTION_LEASE_LOST' });
      const missing = await fixture();
      await db.pool.query('UPDATE agent_runs SET execution_descriptor=NULL WHERE id=$1', [missing.job.runId]);
      await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [missing.job.runId]);
      const old = await db.repository.durable.claimRun(missing.job, 60_000, 'replacement'); assert.ok(old);
      await assert.rejects(db.repository.durable.bindExecutionDescriptor(old, { runtimeVersion: '1' }), { code: 'RECOVERY_DESCRIPTOR_MISSING' });
      const partial = await fixture();
      await db.repository.durable.bindExecutionDescriptor(partial.lease, { runtimeVersion: '1' });
      await db.pool.query("UPDATE agent_runs SET execution_descriptor=execution_descriptor-'contractVersion' WHERE id=$1", [partial.job.runId]);
      await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [partial.job.runId]);
      const interrupted = await db.repository.durable.claimRun(partial.job, 60_000, 'replacement'); assert.ok(interrupted);
      await assert.rejects(db.repository.durable.bindExecutionDescriptor(interrupted, { runtimeVersion: '1' }), { code: 'RECOVERY_DESCRIPTOR_MISSING' });
      const missingHost = await fixture();
      await db.repository.durable.bindExecutionDescriptor(missingHost.lease, {graphVersion:'1'}, 'agent');
      await db.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [missingHost.job.runId]);
      const inconsistent = await db.repository.durable.claimRun(missingHost.job,60_000,'replacement'); assert.ok(inconsistent);
      await assert.rejects(db.repository.durable.bindExecutionDescriptor(inconsistent,{runtimeVersion:'1'},'host'),{code:'RECOVERY_DESCRIPTOR_MISSING'});
    });
  } finally {
    try {
      await db.pool.query('DELETE FROM chat_attachments WHERE tenant_id=$1', [owner.tenantId]);
      await db.pool.query('DELETE FROM tenants WHERE id=$1', [owner.tenantId]);
      await db.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner.userId, other.userId]]);
    } finally { await db.pool.end(); }
  }
});
