import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase, migrateDatabase } from '../src/index.js';
import type { AuthContext } from '@repo/contracts';

test(
  'first run persists an untitled session title without overwriting custom titles',
  { skip: process.env.RUN_INTEGRATION_TESTS !== '1' },
  async () => {
    const url =
      process.env.DATABASE_URL ??
      'postgresql://agent:agent@127.0.0.1:55433/agent_test';
    assert.match(new URL(url).pathname, /test/i);
    const database = createDatabase(url);
    const context: AuthContext = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      roles: ['owner'],
    };
    try {
      await migrateDatabase(database.pool);
      await database.repository.ensureIdentity(context);
      for (const title of ['新会话', '我命名的会话']) {
        const session = await database.repository.createSession(context, {
          title,
          externalKey: randomUUID(),
          workspacePath: `/tmp/mobile-title-test-${randomUUID()}`,
        });
        await database.repository.createRun(context, {
          sessionId: session.id,
          message: '第一条消息\n补充内容',
        });
        const saved = await database.repository.getSession(context, session.id);
        assert.equal(saved?.title, title === '新会话' ? '第一条消息' : title);
        assert.equal(
          await database.repository.getWorkspaceIdByExternalKey(session.id),
          session.workspaceId,
        );
        assert.equal(
          await database.repository.getWorkspaceIdByExternalKey(
            session.externalKey!,
          ),
          session.workspaceId,
        );
        await database.repository.setInitialSessionTitle(
          context,
          session.id,
          '不要覆盖',
        );
        assert.equal(
          (await database.repository.getSession(context, session.id))?.title,
          saved?.title,
        );
      }
    } finally {
      await database.pool.query('DELETE FROM tenants WHERE id = $1', [
        context.tenantId,
      ]);
      await database.pool.end();
    }
  },
);
