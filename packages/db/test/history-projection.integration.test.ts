import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AgentEvent, AuthContext } from '@repo/contracts';
import { createDatabase, migrateDatabase } from '../src/index.js';

test('history projects snapshots atomically and pages every run without scanning events in JavaScript', {
  skip: process.env.RUN_INTEGRATION_TESTS !== '1',
}, async (t) => {
  const url = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55439/chat_hardening_test';
  assert.match(new URL(url).pathname, /test/);
  const db = createDatabase(url);
  const context: AuthContext = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
  try {
    await migrateDatabase(db.pool);
    await db.repository.ensureIdentity(context);
    const session = await db.repository.createSession(context, { title: 'history', workspacePath: `/tmp/history-${randomUUID()}` });
    const run = (await db.repository.createRun(context, { sessionId: session.id, message: 'question' })).run;
    const append = (fields: object) => db.repository.appendEvent(context.tenantId, { runId: run.id, timestamp: new Date().toISOString(), ...fields } as AgentEvent);
    const citation = { chunkId: randomUUID(), kbId: randomUUID(), documentId: randomUUID(), documentName: 'notes.md', ordinal: 0, score: 0.8, via: 'vector' };
    await append({ type: 'assistant.delta', text: 'discarded draft' });
    await append({ type: 'assistant.snapshot', text: 'canonical' });
    await append({ type: 'assistant.delta', text: ' answer' });
    await append({ type: 'assistant.reasoning', text: 'reason' });
    await append({ type: 'retrieval.completed', citations: [citation] });
    await append({ type: 'tool.started', invocationId: 'w', tool: 'write_file', input: { file_path: 'src/a.ts', content: 'const answer = 42;' } });
    await append({ type: 'tool.started', invocationId: 'r', tool: 'read_file', input: { file_path: 'src/a.ts' } });
    await append({ type: 'run.completed' });

    await t.test('snapshot, reasoning, citations and read-file content are durable', async () => {
      const page = await db.repository.history.pageRuns(context, session.id, { limit: 10 });
      assert.equal(page.runs[0]!.projection.text, 'canonical answer');
      assert.equal(page.runs[0]!.projection.reasoning, 'reason');
      assert.deepEqual(page.runs[0]!.projection.citations, [citation]);
      const files = await db.repository.history.listFiles(context, session.id, { limit: 1 });
      assert.deepEqual(files.files, [{ path: 'src/a.ts', content: 'const answer = 42;', operation: 'read_file' }]);
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO run_events(run_id,tenant_id,seq,event_type,payload) VALUES($1,$2,100,'assistant.snapshot',$3)`, [run.id, context.tenantId, { type: 'assistant.snapshot', text: 'rolled back' }]);
        await client.query('ROLLBACK');
      } finally { client.release(); }
      assert.equal((await db.repository.history.latestRun(context, session.id))?.projection.text, 'canonical answer');
      await append({ type: 'assistant.snapshot', text: '' });
      assert.equal((await db.repository.history.latestRun(context, session.id))?.projection.text, '');
    });

    await t.test('missing legacy projections rebuild in SQL and preserve latest semantics', async () => {
      await db.pool.query('DELETE FROM run_message_projections WHERE run_id=$1', [run.id]);
      const page = await db.repository.history.pageRuns(context, session.id, { limit: 10 });
      assert.equal(page.runs[0]!.projection.text, '');
      assert.equal(page.runs[0]!.projection.reasoning, 'reason');
      assert.deepEqual(page.runs[0]!.projection.citations, [citation]);
    });

    await t.test('microsecond ties and concurrent newer runs neither duplicate nor drop older pages', async () => {
      const ids = Array.from({ length: 61 }, () => randomUUID());
      for (let index = 0; index < ids.length; index++) {
        await db.pool.query(`INSERT INTO agent_runs(id,tenant_id,user_id,session_id,status,user_message,created_at)
          VALUES($1,$2,$3,$4,'completed',$5,'2027-01-01 00:00:00.123456+00')`, [ids[index], context.tenantId, context.userId, session.id, `question-${index}`]);
      }
      const first = await db.repository.history.pageRuns(context, session.id, { limit: 500 });
      assert.equal(first.runs.length, 50, 'repository caps pages at fifty runs');
      assert.equal(first.hasMore, true);
      assert.ok(first.nextCursor);
      await db.pool.query(`INSERT INTO agent_runs(id,tenant_id,user_id,session_id,status,user_message,created_at)
        VALUES($1,$2,$3,$4,'completed','new run','2028-01-01')`, [randomUUID(), context.tenantId, context.userId, session.id]);
      const second = await db.repository.history.pageRuns(context, session.id, { limit: 50, cursor: first.nextCursor! });
      const combined = [...first.runs, ...second.runs];
      assert.equal(combined.length, 62);
      assert.equal(new Set(combined.map((entry) => entry.id)).size, 62);
      assert.equal(second.hasMore, false);
      await assert.rejects(db.repository.history.pageRuns(context, session.id, { cursor: 'invalid' }), /cursor/i);
      const forged = Buffer.from(JSON.stringify({ createdAt: '2027-01-01T00:00:00Z', id: '-'.repeat(36) })).toString('base64url');
      await assert.rejects(db.repository.history.pageRuns(context, session.id, { cursor: forged }), /cursor/i);
    });

    await t.test('latest events are bounded and unauthorized history never leaks projections or files', async () => {
      for (let index = 0; index < 205; index++) await append({ type: 'tool.started', invocationId: `file-${index}`, tool: 'read_file', input: { path: `file-${String(index).padStart(3, '0')}.ts` } });
      const firstFiles = await db.repository.history.listFiles(context, session.id, { limit: 10_000 });
      assert.equal(firstFiles.files.length, 200);
      assert.equal(firstFiles.hasMore, true);
      const secondFiles = await db.repository.history.listFiles(context, session.id, { cursor: firstFiles.nextCursor! });
      assert.equal(secondFiles.files.length, 6);
      assert.equal(secondFiles.hasMore, false);
      assert.equal(new Set([...firstFiles.files, ...secondFiles.files].map((file) => file.path)).size, 206);
      for (let index = 0; index < 520; index++) await append({ type: 'assistant.delta', text: 'x' });
      const events = await db.repository.history.latestEvents(context, run.id, 10_000);
      assert.equal(events.length, 500);
      assert.ok(events[0]!.seq > 1);
      assert.equal((await db.repository.history.pageRuns({ ...context, userId: randomUUID() }, session.id, {})).runs.length, 0);
      assert.deepEqual((await db.repository.history.listFiles({ ...context, userId: randomUUID() }, session.id, {})).files, []);
      assert.deepEqual(await db.repository.history.latestEvents({ ...context, userId: randomUUID() }, run.id), []);
    });
  } finally {
    await db.pool.query('DELETE FROM tenants WHERE id=$1', [context.tenantId]);
    await db.pool.query('DELETE FROM users WHERE id=$1', [context.userId]);
    await db.repository.close();
  }
});
