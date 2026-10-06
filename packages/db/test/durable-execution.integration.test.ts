import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AgentEvent, AuthContext, RunJob } from '@repo/contracts';
import { createDatabase, migrateDatabase } from '../src/index.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';
const connectionString = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55433/agent_test';

// Real row locks, transactions, and takeover exercise the ownership boundary.
test('durable execution persists ownership and replay identities', { skip: !enabled }, async (t) => {
  assert.match(new URL(connectionString).pathname, /test/i);
  const database = createDatabase(connectionString);
  const context: AuthContext = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
  try {
    await migrateDatabase(database.pool);

    await t.test('forward migration upgrades an existing tool ledger missing retry_count', async () => {
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('CREATE TEMP TABLE tool_executions (execution_id uuid PRIMARY KEY)');
        const migration = await readFile(new URL('../migrations/024_durable_tool_retry_count.sql', import.meta.url), 'utf8');
        await client.query(migration);
        await client.query(migration); // Re-running is safe for partially upgraded databases.
        const result = await client.query('SELECT retry_count FROM tool_executions');
        assert.deepEqual(result.rows, []);
        await client.query("INSERT INTO tool_executions(execution_id) VALUES ($1)", [randomUUID()]);
        const inserted = await client.query('SELECT retry_count FROM tool_executions');
        assert.equal(inserted.rows[0].retry_count, 0);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    await database.repository.ensureIdentity(context);
    const durable = database.repository.durable;
    assert.ok(durable, 'repository must expose durable execution storage');
    const fixture = async () => {
      const session = await database.repository.createSession(context, { title: 'Durable test', workspacePath: `/tmp/durable-${randomUUID()}` });
      const { run, outboxId } = await database.repository.createRun(context, { sessionId: session.id, message: 'hello' });
      const dispatch = await database.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [outboxId]);
      return dispatch.rows[0].payload as RunJob;
    };
    const expire = async (job: RunJob) => database.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.runId]);
    const event = (job: RunJob, type: 'run.completed' | 'run.started'): AgentEvent => ({ runId: job.runId, type, timestamp: new Date().toISOString() });

    await t.test('one concurrent claimant owns a run and stale owners cannot write after takeover', async () => {
      const job = await fixture();
      const claims = await Promise.all([durable.claimRun(job, 60_000, 'a'), durable.claimRun(job, 60_000, 'b')]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find(Boolean)!;
      assert.equal(first.recovery, false);
      assert.equal(await durable.renewLease(first, 60_000), true);
      await expire(job);
      await assert.rejects(durable.assertLease(first), { code: 'EXECUTION_LEASE_LOST' });
      assert.equal(await durable.renewLease(first, 60_000), false);
      const second = await durable.claimRun(job, 60_000, 'c');
      assert.ok(second);
      assert.equal(second.epoch, first.epoch + 1);
      assert.equal(second.recovery, true);
      await assert.rejects(durable.appendEvent(first, event(job, 'run.started')), { code: 'EXECUTION_LEASE_LOST' });
      await durable.releaseLease(first);
      await durable.assertLease(second);
      await assert.rejects(durable.withLease(second, async (client) => {
        await client.query('UPDATE agent_runs SET checkpoint_id=$2 WHERE id=$1', [job.runId, 'rolled-back']);
        throw new Error('abort checkpoint');
      }), /abort checkpoint/);
      const row = await database.pool.query('SELECT checkpoint_id FROM agent_runs WHERE id=$1', [job.runId]);
      assert.equal(row.rows[0].checkpoint_id, null);
    });

    await t.test('recovery queues expired execution once and preserves resume input', async () => {
      const job = await fixture();
      const first = await durable.claimRun(job, 60_000, 'a'); assert.ok(first);
      await durable.appendEvent(first, { runId: job.runId, timestamp: new Date().toISOString(), type: 'question.required', interruptId: 'question-1', question: { question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }], multiple: false, allowCustom: true } });
      await durable.releaseLease(first);
      assert.equal(await durable.claimRun(job, 60_000, 'stale'), null);
      const waiting = await database.pool.query('SELECT status, execution_state FROM agent_runs WHERE id=$1', [job.runId]);
      assert.deepEqual(waiting.rows[0], { status: 'waiting_question', execution_state: 'waiting' });
      const answer = { selections: [], customText: 'yes' };
      await database.repository.resolveInterrupt(context, job.runId, 'question-1', 'question', answer);
      const resume: RunJob = { ...job, kind: 'resume-question', interruptId: 'question-1', answer };
      const resumed = await durable.claimRun(resume, 60_000, 'b'); assert.ok(resumed);
      assert.deepEqual(resumed.input, resume);
      await expire(job);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 1);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 0);
      const recovered = await database.pool.query("SELECT payload FROM run_dispatch_outbox WHERE run_id=$1 AND job_kind='recover'", [job.runId]);
      assert.equal(recovered.rows.length, 1);
      const next = await durable.claimRun(job, 60_000, 'old-start'); assert.ok(next);
      assert.deepEqual(next.input, resume);
      assert.equal(next.recovery, true);
      await durable.appendEvent(next, event(job, 'run.completed'));
      await durable.releaseLease(next);
    });

    await t.test('waiting runs never enter recovery and legacy running payload is restored', async () => {
      // Other subtests own live leases, so only these deliberately expired rows are eligible.
      const waitingJob = await fixture();
      await database.pool.query("UPDATE agent_runs SET status='waiting_approval',execution_state='waiting',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [waitingJob.runId]);
      const legacyJob = await fixture();
      await database.pool.query("UPDATE agent_runs SET status='running',execution_state='running' WHERE id=$1", [legacyJob.runId]);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 1);
      const row = await database.pool.query('SELECT execution_input,execution_state FROM agent_runs WHERE id=$1', [legacyJob.runId]);
      assert.deepEqual(row.rows[0].execution_input, legacyJob);
      assert.equal(row.rows[0].execution_state, 'recovering');
      const recoverRows = await database.pool.query("SELECT payload FROM run_dispatch_outbox WHERE run_id=$1 AND job_kind='recover'", [legacyJob.runId]);
      const lease = await durable.claimRun(recoverRows.rows[0].payload, 60_000, 'recovery'); assert.ok(lease);
      await durable.appendEvent(lease, event(legacyJob, 'run.completed'));
      await durable.releaseLease(lease);
    });

    await t.test('recovery budget exhaustion atomically fails the run and emits one failure', async () => {
      const job = await fixture();
      const lease = await durable.claimRun(job, 60_000, 'a'); assert.ok(lease);
      await database.pool.query('UPDATE agent_runs SET recovery_attempts=2 WHERE id=$1', [job.runId]);
      await expire(job);
      assert.equal(await durable.recoverExpiredRuns(100, 2), 1);
      assert.equal(await durable.recoverExpiredRuns(100, 2), 0);
      const row = await database.pool.query('SELECT status,execution_state,error_code FROM agent_runs WHERE id=$1', [job.runId]);
      assert.deepEqual(row.rows[0], { status: 'failed', execution_state: 'terminal', error_code: 'RECOVERY_EXHAUSTED' });
      const events = await database.pool.query('SELECT event_type FROM run_events WHERE run_id=$1', [job.runId]);
      assert.deepEqual(events.rows, [{ event_type: 'run.failed' }]);
    });

    await t.test('terminal event is atomic and duplicate publication returns the original sequence', async () => {
      const job = await fixture();
      const lease = await durable.claimRun(job, 60_000, 'a'); assert.ok(lease);
      const terminal = event(job, 'run.completed');
      const saved = await durable.appendEvent(lease, terminal);
      assert.equal((await durable.appendEvent(lease, terminal)).seq, saved.seq);
      await durable.assertLease(lease); // Cleanup/checkpoint may finish before release.
      await durable.releaseLease(lease);
      assert.equal(await durable.claimRun(job, 60_000, 'b'), null);
      await assert.rejects(durable.appendEvent(lease, event(job, 'run.started')), { code: 'EXECUTION_LEASE_LOST' });
      const row = await database.pool.query('SELECT status,last_event_seq,execution_state FROM agent_runs WHERE id=$1', [job.runId]);
      assert.deepEqual(row.rows[0], { status: 'completed', last_event_seq: saved.seq, execution_state: 'terminal' });
    });

    await t.test('tool intent is unique, preserves successful results, and rejects changed input', async () => {
      const job = await fixture();
      const lease = await durable.claimRun(job, 60_000, 'a'); assert.ok(lease);
      const intent = { scopeId: 'root', toolCallId: 'call-1', toolName: 'edit', inputHash: 'same-hash', input: { path: 'x' }, replayPolicy: 'unsafe' as const };
      const created = await durable.beginTool(lease, intent);
      assert.equal(created.fresh, true);
      assert.equal(created.record.retryCount, 0);
      const repeated = await durable.beginTool(lease, intent);
      assert.equal(repeated.fresh, false);
      assert.equal(repeated.record.idempotencyKey, created.record.idempotencyKey);
      const policyOverride = await durable.beginTool(lease, { ...intent, replayPolicy: 'safe' });
      assert.equal(policyOverride.record.replayPolicy, 'unsafe');
      await durable.markToolUncertain(lease, created.record.executionId);
      assert.equal((await durable.beginTool(lease, intent)).record.status, 'uncertain');
      await durable.retryTool(lease, created.record.executionId);
      const retried = await durable.beginTool(lease, intent);
      assert.equal(retried.record.status, 'started');
      assert.equal(retried.record.retryCount, 1);
      await durable.retryTool(lease, created.record.executionId);
      assert.equal((await durable.beginTool(lease, intent)).record.retryCount, 2);
      await durable.completeTool(lease, created.record.executionId, { kind: 'command', update: { messages: ['saved'] } });
      await durable.markToolUncertain(lease, created.record.executionId);
      await durable.retryTool(lease, created.record.executionId);
      const replay = await durable.beginTool(lease, intent);
      assert.equal(replay.record.status, 'succeeded');
      assert.equal(replay.record.retryCount, 2);
      assert.deepEqual(replay.record.result, { kind: 'command', update: { messages: ['saved'] } });
      await assert.rejects(durable.beginTool(lease, { ...intent, inputHash: 'different' }), /identity|input/i);
      await assert.rejects(durable.beginTool(lease, { ...intent, toolName: 'delete' }), /identity|input/i);
      await assert.rejects(durable.beginTool(lease, { ...intent, toolCallId: '' }), /tool.call|stable/i);
      await expire(job);
      await assert.rejects(durable.completeTool(lease, created.record.executionId, {}), { code: 'EXECUTION_LEASE_LOST' });
      // Restore only this test-owned run so later reconciliation counts remain isolated.
      await database.pool.query("UPDATE agent_runs SET execution_state='terminal',status='failed' WHERE id=$1", [job.runId]);
    });

    await t.test('an old resume job cannot answer a newer persisted interrupt', async () => {
      const job = await fixture();
      const first = await durable.claimRun(job, 60_000, 'a'); assert.ok(first);
      const question = { question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }], multiple: false, allowCustom: true };
      await durable.appendEvent(first, { runId: job.runId, timestamp: new Date().toISOString(), type: 'question.required', interruptId: 'q1', question });
      await durable.releaseLease(first);
      const answer = { selections: [], customText: 'yes' };
      await database.repository.resolveInterrupt(context, job.runId, 'q1', 'question', answer);
      const resume: RunJob = { ...job, kind: 'resume-question', interruptId: 'q1', answer };
      const second = await durable.claimRun(resume, 60_000, 'b'); assert.ok(second);
      await durable.appendEvent(second, { runId: job.runId, timestamp: new Date().toISOString(), type: 'question.required', interruptId: 'q2', question });
      await durable.releaseLease(second);
      assert.equal(await durable.claimRun(resume, 60_000, 'stale'), null);
      // Legacy payloads without interruptId are still fenced by the current persisted response.
      const { interruptId: _oldId, ...legacyResume } = resume;
      assert.equal(await durable.claimRun(legacyResume, 60_000, 'legacy-stale'), null);
      await database.repository.resolveInterrupt(context, job.runId, 'q2', 'question', answer);
      assert.equal(await durable.claimRun(resume, 60_000, 'still-stale'), null);
      const third = await durable.claimRun({ ...resume, interruptId: 'q2' }, 60_000, 'c'); assert.ok(third);
      await durable.appendEvent(third, event(job, 'run.completed'));
      await durable.releaseLease(third);
    });

    await t.test('lease expiry during a transaction rolls back writes before they can commit', async () => {
      const job = await fixture();
      const lease = await durable.claimRun(job, 60_000, 'a'); assert.ok(lease);
      await assert.rejects(durable.withLease(lease, async (client) => {
        await client.query("UPDATE agent_runs SET checkpoint_id='late',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.runId]);
      }), { code: 'EXECUTION_LEASE_LOST' });
      await durable.assertLease(lease);
      const row = await database.pool.query('SELECT checkpoint_id FROM agent_runs WHERE id=$1', [job.runId]);
      assert.equal(row.rows[0].checkpoint_id, null);
    });

    await t.test('concurrent recovery scans atomically schedule each expired run once', async () => {
      const jobs = await Promise.all([fixture(), fixture()]);
      for (const job of jobs) {
        assert.ok(await durable.claimRun(job, 60_000, 'a'));
        await expire(job);
      }
      const counts = await Promise.all([durable.recoverExpiredRuns(1, 3), durable.recoverExpiredRuns(1, 3)]);
      assert.equal(counts.reduce((sum, count) => sum + count, 0), 2);
      const rows = await database.pool.query("SELECT run_id,count(*)::integer AS count FROM run_dispatch_outbox WHERE run_id=ANY($1::uuid[]) AND job_kind='recover' GROUP BY run_id", [jobs.map((job) => job.runId)]);
      assert.equal(rows.rows.length, 2);
      assert.ok(rows.rows.every((row) => row.count === 1));
    });

    await t.test('takeover retains persisted cancellation so the successor can finalize it', async () => {
      const job = await fixture();
      assert.ok(await durable.claimRun(job, 60_000, 'a'));
      await database.pool.query('UPDATE agent_runs SET cancel_requested_at=clock_timestamp() WHERE id=$1', [job.runId]);
      await expire(job);
      const lease = await durable.claimRun(job, 60_000, 'b'); assert.ok(lease);
      await durable.appendEvent(lease, { runId: job.runId, timestamp: new Date().toISOString(), type: 'run.cancelled' });
      await durable.releaseLease(lease);
      assert.equal(await durable.claimRun(job, 60_000, 'c'), null);
    });

    await t.test('waiting and terminal ownership permits cleanup but blocks new execution intents', async () => {
      const job = await fixture();
      const lease = await durable.claimRun(job, 60_000, 'a'); assert.ok(lease);
      const intent = { scopeId: 'root', toolCallId: 'call', toolName: 'edit', inputHash: 'hash', input: {}, replayPolicy: 'unsafe' as const };
      const tool = await durable.beginTool(lease, intent);
      const child = await durable.ensureChild(lease, 'spawn', {}, true);
      await durable.appendEvent(lease, { runId: job.runId, timestamp: new Date().toISOString(), type: 'question.required', interruptId: 'pause', question: { question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }], multiple: false, allowCustom: true } });
      await assert.rejects(durable.beginTool(lease, intent), /running/i);
      await assert.rejects(durable.retryTool(lease, tool.record.executionId), /running/i);
      await assert.rejects(durable.ensureChild(lease, 'spawn', {}, true), /running/i);
      await durable.completeTool(lease, tool.record.executionId, { saved: true });
      await durable.saveChild(lease, child.id, { status: 'completed', summary: 'done' });
      await durable.appendEvent(lease, event(job, 'run.completed'));
      await durable.assertLease(lease);
      await assert.rejects(durable.beginTool(lease, { ...intent, toolCallId: 'late' }), /running/i);
      await durable.releaseLease(lease);
    });

    await t.test('direct expired takeovers consume the recovery budget', async () => {
      const job = await fixture();
      assert.ok(await durable.claimRun(job, 60_000, 'a', 1));
      await expire(job);
      assert.ok(await durable.claimRun(job, 60_000, 'b', 1));
      const recovered = await database.pool.query('SELECT recovery_attempts FROM agent_runs WHERE id=$1', [job.runId]);
      assert.equal(recovered.rows[0].recovery_attempts, 1);
      await expire(job);
      assert.equal(await durable.claimRun(job, 60_000, 'c', 1), null);
      const failed = await database.pool.query('SELECT status,error_code FROM agent_runs WHERE id=$1', [job.runId]);
      assert.deepEqual(failed.rows[0], { status: 'failed', error_code: 'RECOVERY_EXHAUSTED' });
    });

    await t.test('persisted cancellation takes priority over recovery budget exhaustion', async () => {
      for (const mode of ['claim', 'reconcile']) {
        const job = await fixture();
        assert.ok(await durable.claimRun(job, 60_000, 'a', 0));
        await database.pool.query('UPDATE agent_runs SET cancel_requested_at=clock_timestamp() WHERE id=$1', [job.runId]);
        await expire(job);
        if (mode === 'claim') assert.equal(await durable.claimRun(job, 60_000, 'b', 0), null);
        else assert.equal(await durable.recoverExpiredRuns(100, 0), 1);
        const row = await database.pool.query('SELECT status,execution_state,error_code FROM agent_runs WHERE id=$1', [job.runId]);
        assert.deepEqual(row.rows[0], { status: 'cancelled', execution_state: 'terminal', error_code: null });
        const events = await database.pool.query('SELECT event_type FROM run_events WHERE run_id=$1', [job.runId]);
        assert.deepEqual(events.rows, [{ event_type: 'run.cancelled' }]);
      }
    });

    await t.test('a consumed recovery dispatch is replaced after a crash before run claim', async () => {
      const job = await fixture();
      assert.ok(await durable.claimRun(job, 60_000, 'a'));
      await expire(job);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 1);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 0);
      await database.pool.query("UPDATE run_dispatch_outbox SET consumed_at=clock_timestamp() WHERE run_id=$1 AND job_kind='recover'", [job.runId]);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 1);
      assert.equal(await durable.recoverExpiredRuns(100, 3), 0);
      const dispatch = await database.pool.query("SELECT payload FROM run_dispatch_outbox WHERE run_id=$1 AND job_kind='recover' AND consumed_at IS NULL", [job.runId]);
      assert.equal(dispatch.rows.length, 1);
      const lease = await durable.claimRun(dispatch.rows[0].payload, 60_000, 'b', 3); assert.ok(lease);
      const row = await database.pool.query('SELECT recovery_attempts FROM agent_runs WHERE id=$1', [job.runId]);
      assert.equal(row.rows[0].recovery_attempts, 2);
      await durable.appendEvent(lease, event(job, 'run.completed'));
      await durable.releaseLease(lease);
    });

    await t.test('child identity persists across owner takeover and patches cannot alter identity', async () => {
      const job = await fixture();
      const lease = await durable.claimRun(job, 60_000, 'a'); assert.ok(lease);
      const child = await durable.ensureChild(lease, 'spawn-1', { task: 'read', role: 'researcher' }, true);
      const repeated = await durable.ensureChild(lease, 'spawn-1', { role: 'researcher', task: 'read' }, true);
      assert.equal(repeated.id, child.id);
      assert.equal(repeated.threadId, child.threadId);
      assert.equal(child.threadId, `child:${child.id}`);
      const saved = await durable.saveChild(lease, child.id, { status: 'waiting', feedback: 'try again', attemptResult: { status: 'completed', summary: 'output', toolCalls: 2 }, review: { score: 7 } });
      assert.equal(saved.status, 'waiting');
      await assert.rejects(durable.ensureChild(lease, 'spawn-1', { task: 'write' }, true), /identity|input/i);
      await assert.rejects(durable.saveChild(lease, child.id, { id: randomUUID() }), /identity|patch/i);
      await expire(job);
      const next = await durable.claimRun(job, 60_000, 'b'); assert.ok(next);
      assert.deepEqual(await durable.getChild(next, child.id), saved);
      assert.deepEqual(await durable.listBackgroundChildren(next), [saved]);
      await assert.rejects(durable.saveChild(lease, child.id, { status: 'completed' }), { code: 'EXECUTION_LEASE_LOST' });
      const otherJob = await fixture(); const otherLease = await durable.claimRun(otherJob, 60_000, 'b'); assert.ok(otherLease);
      assert.equal(await durable.getChild(otherLease, child.id), null);
      await assert.rejects(durable.saveChild(otherLease, child.id, { status: 'completed' }), /child/i);
    });
  } finally {
    await database.pool.query('DELETE FROM tenants WHERE id=$1', [context.tenantId]);
    await database.pool.query('DELETE FROM users WHERE id=$1', [context.userId]);
    await database.pool.end();
  }
});
