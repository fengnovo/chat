import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase, migrateDatabase, RepositoryNotFoundError } from '../src/index.js';
import type { AuthContext, RunJob } from '@repo/contracts';

test('continuation preserves the actual user request and original attachments before any checkpoint exists',
  { skip: process.env.RUN_INTEGRATION_TESTS !== '1' }, async () => {
    const url = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55433/agent_test';
    assert.match(new URL(url).pathname, /test/i);
    const db = createDatabase(url);
    const auth: AuthContext = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
    try {
      await migrateDatabase(db.pool);
      await db.repository.ensureIdentity(auth);
      const session = await db.repository.createSession(auth, { title: '新会话', workspacePath: '/tmp/continuation-context' });
      const attachment = { id: randomUUID(), kind: 'image' as const, filename: 'sample.png', objectKey: 'test/sample', contentType: 'image/png', sizeBytes: 3 };
      await db.repository.createChatAttachment(auth, { ...attachment, sha256: 'test-hash' });
      await db.repository.markChatAttachmentReady(auth, attachment.id);
      const original = await db.repository.createRun(auth, { sessionId: session.id, message: '你好啊，陈水扁', attachments: [attachment] });
      const fail = async (outboxId: string | undefined) => {
        const row = await db.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [outboxId]);
        const job = row.rows[0].payload as RunJob;
        const lease = await db.repository.durable.claimRun(job, 60_000, 'continuation-test');
        assert.ok(lease);
        await db.repository.durable.appendEvent(lease, { type: 'run.failed', runId: job.runId, timestamp: new Date().toISOString(), code: 'TEST_BEFORE_MODEL', message: 'Failed before model initialization' });
      };
      await fail(original.outboxId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const continued = await db.repository.createRun(auth, { sessionId: session.id, message: '请继续回应用户原始请求。', continuation: true });
        const row = await db.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [continued.outboxId]);
        const job = row.rows[0].payload;
        assert.match(job.message, /你好啊，陈水扁/);
        assert.equal(job.message, continued.run.userMessage);
        assert.equal(job.message.split('你好啊，陈水扁').length - 1, 1, 'repeated continuations must anchor the original request once');
        assert.equal(job.attachments[0]?.id, attachment.id);
        assert.equal(job.attachments[0]?.objectKey, attachment.objectKey);
        assert.equal((await db.repository.getChatAttachment(auth, attachment.id))?.runId, original.run.id);
        await fail(continued.outboxId);
      }
      const empty = await db.repository.createSession(auth, { title: 'empty', workspacePath: '/tmp/empty-context' });
      await assert.rejects(db.repository.createRun(auth, { sessionId: empty.id, message: 'continue', continuation: true }),
        (e) => e instanceof RepositoryNotFoundError && e.resource === 'continuation_source');
    } finally {
      await db.pool.query('DELETE FROM chat_attachments WHERE tenant_id=$1', [auth.tenantId]);
      await db.pool.query('DELETE FROM tenants WHERE id=$1', [auth.tenantId]);
      await db.pool.end();
    }
  });
