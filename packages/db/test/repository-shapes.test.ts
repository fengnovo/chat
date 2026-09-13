import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthContext } from '@repo/contracts';

import { AgentRepository, RepositoryNotFoundError } from '../src/index.js';

test('repository not-found errors carry a stable resource code', () => {
  const error = new RepositoryNotFoundError('run');
  assert.equal(error.resource, 'run');
  assert.equal(error.message, 'run not found');
});

test('createRun persists the authorized knowledge-base snapshot into its dispatch job', async () => {
  const knowledgeBaseId = '00000000-0000-4000-8000-000000000004';
  const dispatched: unknown[] = [];
  const now = new Date();
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          if (text.includes('FROM agent_sessions s')) {
            return {
              rows: [
                {
                  id: '00000000-0000-4000-8000-000000000003',
                  approval_mode: 'manual',
                  workspace_path: '/workspace',
                  source_type: 'empty',
                  source_ref: null,
                  source_revision: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('FROM knowledge_bases')) {
            return { rows: [{ id: knowledgeBaseId }], rowCount: 1 };
          }
          if (text.includes('INSERT INTO agent_runs')) {
            return {
              rows: [
                {
                  id: values?.[0],
                  tenant_id: values?.[1],
                  user_id: values?.[2],
                  session_id: values?.[3],
                  status: 'queued',
                  user_message: values?.[4],
                  knowledge_base_ids: values?.[5],
                  last_event_seq: 0,
                  cancel_requested_at: null,
                  error_code: null,
                  error_message: null,
                  created_at: now,
                  updated_at: now,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('INSERT INTO run_dispatch_outbox')) {
            dispatched.push(JSON.parse(String(values?.[4])));
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const repository = new AgentRepository(pool as never);
  const context: AuthContext = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    roles: ['member'],
  };

  const created = await repository.createRun(context, {
    sessionId: '00000000-0000-4000-8000-000000000003',
    message: 'Search the knowledge base',
    knowledgeBaseIds: [knowledgeBaseId],
  });

  assert.deepEqual(created.run.knowledgeBaseIds, [knowledgeBaseId]);
  assert.deepEqual(dispatched, [
    {
      kind: 'start',
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: '00000000-0000-4000-8000-000000000003',
      runId: created.run.id,
      message: 'Search the knowledge base',
      workspacePath: '/workspace',
      approvalMode: 'manual',
      workspaceSource: { type: 'empty' },
      knowledgeBaseIds: [knowledgeBaseId],
    },
  ]);
});

test('createRun rejects a knowledge base that is not visible to the caller', async () => {
  const pool = {
    async connect() {
      return {
        async query(text: string) {
          if (text.includes('FROM agent_sessions s')) {
            return {
              rows: [
                {
                  approval_mode: 'manual',
                  workspace_path: '/workspace',
                  source_type: 'empty',
                  source_ref: null,
                  source_revision: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('FROM knowledge_bases')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const repository = new AgentRepository(pool as never);
  const context: AuthContext = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    roles: ['member'],
  };

  await assert.rejects(
    repository.createRun(context, {
      sessionId: '00000000-0000-4000-8000-000000000003',
      message: 'Search another tenant knowledge base',
      knowledgeBaseIds: ['00000000-0000-4000-8000-000000000004'],
    }),
    (error: unknown) =>
      error instanceof RepositoryNotFoundError && error.resource === 'knowledge_base',
  );
});

test('resolveInterrupt dispatches the knowledge-base snapshot stored on the run', async () => {
  const knowledgeBaseId = '00000000-0000-4000-8000-000000000004';
  const dispatched: unknown[] = [];
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          if (text.includes('FROM agent_runs r')) {
            return {
              rows: [
                {
                  user_id: '00000000-0000-4000-8000-000000000002',
                  session_id: '00000000-0000-4000-8000-000000000003',
                  knowledge_base_ids: [knowledgeBaseId],
                  workspace_path: '/workspace',
                  approval_mode: 'manual',
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('UPDATE interrupts')) {
            return {
              rows: [
                {
                  id: 'interrupt-1',
                  run_id: '00000000-0000-4000-8000-000000000005',
                  kind: 'question',
                  request: { question: 'Continue?' },
                  response: { selections: [] },
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('INSERT INTO run_dispatch_outbox')) {
            dispatched.push(JSON.parse(String(values?.[4])));
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const repository = new AgentRepository(pool as never);
  const context: AuthContext = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    roles: ['member'],
  };

  await repository.resolveInterrupt(
    context,
    '00000000-0000-4000-8000-000000000005',
    'interrupt-1',
    'question',
    { selections: [] },
  );

  assert.deepEqual(dispatched, [
    {
      kind: 'resume-question',
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: '00000000-0000-4000-8000-000000000003',
      runId: '00000000-0000-4000-8000-000000000005',
      workspacePath: '/workspace',
      approvalMode: 'manual',
      knowledgeBaseIds: [knowledgeBaseId],
      answer: { selections: [] },
    },
  ]);
});
