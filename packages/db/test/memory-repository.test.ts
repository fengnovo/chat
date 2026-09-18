import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRepository } from '../src/index.js';

test('listMemories always scopes reads to tenant and user', async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const pool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new AgentRepository(pool as never);

  await repository.listMemories({
    tenantId: 'tenant-a',
    userId: 'user-a',
    assistantKey: 'chat',
    scope: 'global',
  });

  assert.match(queries[0]?.text ?? '', /tenant_id\s*=\s*\$1/iu);
  assert.match(queries[0]?.text ?? '', /user_id\s*=\s*\$2/iu);
  assert.deepEqual(queries[0]?.values?.slice(0, 2), ['tenant-a', 'user-a']);
});

test('enqueueMemoryJob is idempotent by tenant and run', async () => {
  const queries: string[] = [];
  const pool = {
    async query(text: string) {
      queries.push(text);
      return { rows: [{ id: 'job-1' }], rowCount: 1 };
    },
  };
  const repository = new AgentRepository(pool as never);

  const id = await repository.enqueueMemoryJob({
    tenantId: 'tenant-a',
    userId: 'user-a',
    sessionId: 'session-a',
    runId: 'run-a',
  });

  assert.equal(id, 'job-1');
  assert.match(queries[0] ?? '', /ON CONFLICT\s*\(tenant_id, run_id\)/iu);
});

test('claimMemoryJob leases queued work and increments attempts', async () => {
  let sql = '';
  const pool = {
    async query(text: string) {
      sql = text;
      return { rows: [{ id: 'job-1', tenant_id: 't', user_id: 'u', session_id: 's', run_id: 'r', attempts: 1 }], rowCount: 1 };
    },
  };
  const job = await new AgentRepository(pool as never).claimMemoryJob();
  assert.equal(job?.id, 'job-1');
  assert.match(sql, /FOR UPDATE SKIP LOCKED/iu);
  assert.match(sql, /attempts\s*=\s*job\.attempts\s*\+\s*1/iu);
});
