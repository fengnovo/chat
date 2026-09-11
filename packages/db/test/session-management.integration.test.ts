import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { AuthContext } from '@repo/contracts';

import { createDatabase, migrateDatabase } from '../src/index.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';

test(
  'session management is isolated, paginated, renameable, and soft-deletable',
  { skip: !enabled },
  async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      'postgresql://agent:agent@127.0.0.1:55433/agent_test';
    const databaseName = new URL(connectionString).pathname;
    assert.match(
      databaseName,
      /test/i,
      'integration tests must only run against a test database',
    );

    const database = createDatabase(connectionString);
    const tenantId = randomUUID();
    const context: AuthContext = {
      tenantId,
      userId: randomUUID(),
      roles: ['owner'],
    };
    const otherUser: AuthContext = {
      tenantId,
      userId: randomUUID(),
      roles: ['member'],
    };

    try {
      await migrateDatabase(database.pool);
      await database.repository.ensureIdentity(context);
      await database.repository.ensureIdentity(otherUser);

      const project = await database.repository.createProject(context, {
        name: 'Integration repository',
        sourceType: 'git',
        sourceRef: 'https://github.com/octocat/Hello-World.git',
        sourceRevision: 'master',
      });
      assert.equal(project.sourceType, 'git');

      const sessions = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          database.repository.createSession(context, {
            title: `Session ${index + 1}`,
            externalKey: randomUUID(),
            projectId: project.id,
            workspacePath: `/tmp/agent-test-${tenantId}-${index}`,
          }),
        ),
      );

      const firstPage = await database.repository.listSessions(context, {
        limit: 2,
      });
      assert.equal(firstPage.length, 2);
      const last = firstPage.at(-1);
      assert.ok(last);
      const secondPage = await database.repository.listSessions(context, {
        limit: 2,
        cursor: { updatedAt: last.updatedAt, id: last.id },
      });
      assert.equal(secondPage.length, 1);
      assert.equal(new Set([...firstPage, ...secondPage].map((item) => item.id)).size, 3);

      assert.deepEqual(await database.repository.listSessions(otherUser, { limit: 10 }), []);
      assert.equal(
        await database.repository.getSession(otherUser, sessions[0]!.id),
        null,
      );

      const renamed = await database.repository.renameSession(
        context,
        sessions[0]!.id,
        'Renamed session',
      );
      assert.equal(renamed?.title, 'Renamed session');
      assert.equal(
        await database.repository.deleteSession(context, sessions[0]!.id),
        'deleted',
      );
      assert.equal(
        await database.repository.getSession(context, sessions[0]!.id),
        null,
      );
    } finally {
      await database.pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      await database.pool.end();
    }
  },
);
