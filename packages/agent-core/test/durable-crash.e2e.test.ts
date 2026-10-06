import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent, tool } from 'langchain';
import { z } from 'zod';

import { createDatabase, migrateDatabase, type RunExecutionLease } from '../../db/src/index.js';
import type { RunJob } from '../../contracts/src/index.js';
import { chooseRecoveryInput } from '../src/graph-recovery.js';
import { createToolExecutionMiddleware } from '../src/tool-execution.js';
import { createBackgroundRunContext, rehydrateBackgroundChildren, type SpawnSubagentOptions } from '../src/subagent.js';
import { createMiddleware } from 'langchain';
import { createDurableRuntimePorts } from '../../../apps/worker/src/durable-runtime.js';
import { createFencedCheckpointer } from '../../../apps/worker/src/fenced-checkpointer.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55433/agent_test';
const fixture = fileURLToPath(new URL('./fixtures/durable-crash-worker.ts', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../../../apps/worker/package.json', import.meta.url));
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres') as { PostgresSaver: new (pool: unknown) => any };

class DeterministicModel extends BaseChatModel {
  override _llmType() { return 'durable-crash-e2e'; }
  override bindTools() { return this; }
  override async _generate(messages: BaseMessage[]) {
    if (messages.some((message) => ToolMessage.isInstance(message))) {
      return { generations: [{ text: 'operation recorded', message: new AIMessage('operation recorded') }] };
    }
    return { generations: [{ text: '', message: new AIMessage({ content: '', tool_calls: [
      { name: 'external_write', args: {}, id: 'stable-tool-call', type: 'tool_call' },
    ] }) }] };
  }
}

class DeterministicChildModel extends BaseChatModel {
  humanCounts: number[] = [];
  override _llmType() { return 'durable-child-crash-e2e'; }
  override bindTools() { return this; }
  override async _generate(messages: BaseMessage[]) {
    this.humanCounts.push(messages.filter((message) => HumanMessage.isInstance(message)).length);
    if (messages.some((message) => ToolMessage.isInstance(message))) {
      return { generations: [{ text: 'child report', message: new AIMessage('child report') }] };
    }
    return { generations: [{ text: '', message: new AIMessage({ content: '', tool_calls: [
      { name: 'external_write', args: {}, id: 'stable-child-tool-call', type: 'tool_call' },
    ] }) }] };
  }
}

function createDurableChildOptions(database: ReturnType<typeof createDatabase>, saver: InstanceType<typeof PostgresSaver>, lease: RunExecutionLease, job: RunJob) {
  const durable = createDurableRuntimePorts(database.repository, lease, {});
  const model = new DeterministicChildModel({});
  const effect = tool(async () => {
    await database.pool.query('UPDATE durable_crash_e2e_effects SET effect_count=effect_count+1 WHERE run_id=$1', [job.runId]);
    return 'child effect committed';
  }, { name: 'external_write', description: 'Controlled child effect', schema: z.object({}) });
  const options: SpawnSubagentOptions = {
    runId: job.runId,
    router: { primary: model, middleware: createMiddleware({ name: 'DurableCrashE2ERouter' }) },
    tools: [effect],
    durable: {
      store: durable.children,
      checkpointer: createFencedCheckpointer(saver as never, database.repository.durable, lease),
      toolMiddleware: (scopeId) => createToolExecutionMiddleware({ store: durable.tools, scopeId, assertOwnership: durable.assertOwnership }),
    },
  };
  return { options, model };
}

async function runKilledWorker(job: RunJob, dispatchId: string, mode: string): Promise<void> {
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fixture], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, DURABLE_E2E_JOB: JSON.stringify(job), DURABLE_E2E_DISPATCH_ID: dispatchId, DURABLE_E2E_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker fixture did not reach its controlled crash point')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.equal(result.signal, 'SIGKILL', `fixture should be killed by SIGKILL (exit ${result.code}): ${stderr}`);
}

async function makeRecoveredAgent(database: ReturnType<typeof createDatabase>, saver: InstanceType<typeof PostgresSaver>, lease: RunExecutionLease, job: RunJob) {
  const durable = createDurableRuntimePorts(database.repository, lease, {});
  const effect = tool(async () => {
    await database.pool.query('UPDATE durable_crash_e2e_effects SET effect_count=effect_count+1 WHERE run_id=$1', [job.runId]);
    return 'external effect committed';
  }, { name: 'external_write', description: 'Controlled PostgreSQL effect', schema: z.object({}) });
  const middleware = createToolExecutionMiddleware({ store: durable.tools, scopeId: job.runId, assertOwnership: durable.assertOwnership });
  const agent = createAgent({ model: new DeterministicModel({}), tools: [effect], middleware: [middleware as never],
    checkpointer: createFencedCheckpointer(saver as never, database.repository.durable, lease) });
  const config = { configurable: { thread_id: job.sessionId }, metadata: { run_id: `${job.runId}:initial`, business_run_id: job.runId }, durability: 'sync' as const };
  const runtimeAgent = agent as unknown as {
    getState(config: unknown): Promise<any>;
    invoke(input: unknown, config: unknown): Promise<any>;
  };
  return { agent: runtimeAgent, config, durable };
}

async function deliverThroughBullMq(database: ReturnType<typeof createDatabase>, saver: InstanceType<typeof PostgresSaver>, job: RunJob, dispatchId: string, mode: string) {
  const { Queue, QueueEvents, Worker } = require('bullmq') as any;
  const Redis = require('ioredis') as new (url: string, options: object) => any;
  const redisUrl = process.env.DURABLE_E2E_REDIS_URL ?? 'redis://127.0.0.1:56379';
  const queueName = `durable-crash-e2e-${job.runId}`;
  const producer = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const consumer = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const observer = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection: producer });
  const events = new QueueEvents(queueName, { connection: observer });
  const worker = new Worker(queueName, async (bullJob: { data: RunJob; id?: string }) => {
    const lease = await database.repository.durable.claimRun(bullJob.data, 30_000, 'bullmq-replacement-worker', 10);
    if (!lease) throw new Error('recovery dispatch is waiting for execution ownership');
    try {
      if (bullJob.id) await database.repository.markDispatchConsumed(bullJob.id);
      if (mode === 'subagent-background-after-ledger-success') {
        const { options } = createDurableChildOptions(database, saver, lease, job);
        const background = createBackgroundRunContext();
        await rehydrateBackgroundChildren(options, background, { review: async () => ({ skipped: true }) });
        const children = await background.settled();
        const child = children[0];
        await database.repository.durable.appendEvent(lease, { runId: job.runId, timestamp: new Date().toISOString(), type: 'assistant.snapshot', text: child?.summary ?? '' });
        await database.repository.durable.appendEvent(lease, { runId: job.runId, timestamp: new Date().toISOString(), type: 'run.completed' });
        return { kind: 'child-completed', answer: child?.summary };
      }
      const { agent, config } = await makeRecoveredAgent(database, saver, lease, job);
      const snapshot = await agent.getState(config);
      const next = chooseRecoveryInput(snapshot, job.runId, { messages: [new HumanMessage({ id: `user-${job.runId}`, content: 'perform controlled write' })] });
      const result = await agent.invoke(next, config);
      const interrupted = result.__interrupt__?.[0];
      if (interrupted) {
        const request = interrupted.value;
        await database.repository.durable.appendEvent(lease, {
          runId: job.runId, timestamp: new Date().toISOString(), type: 'approval.required',
          interruptId: request.durableApprovalId ?? interrupted.id,
          actions: request.actionRequests.map((action: { name: string; args: Record<string, unknown>; description?: string }) => ({
            name: action.name, args: action.args, summary: action.description ?? action.name,
          })),
        });
        return { kind: 'approval', description: request.actionRequests[0].description };
      }
      await database.repository.durable.appendEvent(lease, { runId: job.runId, timestamp: new Date().toISOString(), type: 'assistant.snapshot', text: 'operation recorded' });
      await database.repository.durable.appendEvent(lease, { runId: job.runId, timestamp: new Date().toISOString(), type: 'run.completed' });
      return {
        kind: 'completed',
        userMessageCount: result.messages.filter((message: BaseMessage) => HumanMessage.isInstance(message) && message.id === `user-${job.runId}`).length,
        answer: result.messages.at(-1)?.content,
      };
    } finally {
      await database.repository.durable.releaseLease(lease);
    }
  }, { connection: consumer, concurrency: 1, lockDuration: 10_000 });
  try {
    await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
    const queued = await queue.add(job.kind, job, { jobId: dispatchId, attempts: 4, backoff: { type: 'exponential', delay: 100 }, removeOnComplete: true });
    await database.repository.markDispatchPublished(dispatchId);
    return await queued.waitUntilFinished(events, 30_000) as { kind: string; answer?: unknown; userMessageCount?: number; description?: string };
  } finally {
    await worker.close();
    await events.close();
    await queue.close();
    await Promise.all([producer.quit(), consumer.quit(), observer.quit()]);
  }
}

for (const mode of ['after-ledger-success', 'after-external-effect', 'subagent-background-after-ledger-success'] as const) {
  test(`SIGKILL recovery after ${mode} reclaims the same graph without blind tool replay`, { skip: !enabled }, async () => {
    assert.match(new URL(databaseUrl).pathname, /test/i, 'refusing to run against a non-test database');
    const database = createDatabase(databaseUrl);
    const context = { tenantId: randomUUID(), userId: randomUUID(), roles: ['owner'] };
    const saver = new PostgresSaver(database.pool);
    let sessionId = '';
    let runId = '';
    try {
      await migrateDatabase(database.pool);
      await saver.setup();
      await database.pool.query(`CREATE TABLE IF NOT EXISTS durable_crash_e2e_effects (
        run_id uuid PRIMARY KEY, effect_count integer NOT NULL DEFAULT 0)`);
      await database.repository.ensureIdentity(context);
      const session = await database.repository.createSession(context, { title: 'kill-9 e2e', workspacePath: `/tmp/durable-e2e-${randomUUID()}` });
      sessionId = session.id;
      const created = await database.repository.createRun(context, { sessionId, message: 'perform controlled write' });
      runId = created.run.id;
      await database.pool.query('INSERT INTO durable_crash_e2e_effects(run_id,effect_count) VALUES($1,0)', [runId]);
      assert.ok(created.outboxId);
      const outbox = (await database.pool.query('SELECT payload FROM run_dispatch_outbox WHERE id=$1', [created.outboxId])).rows[0];
      const job = outbox.payload as RunJob;

      await runKilledWorker(job, created.outboxId, mode);
      const beforeRecovery = (await database.pool.query('SELECT effect_count FROM durable_crash_e2e_effects WHERE run_id=$1', [runId])).rows[0].effect_count;
      assert.equal(beforeRecovery, 1, 'the controlled external effect completed before Worker death');

      await database.pool.query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [runId]);
      const scheduled = await database.repository.durable.recoverExpiredRuns(10, 10);
      assert.equal(scheduled, 1, 'expired execution should create one durable recovery dispatch');
      const recoveryDispatch = (await database.pool.query("SELECT id,payload FROM run_dispatch_outbox WHERE run_id=$1 AND job_kind='recover' ORDER BY created_at DESC LIMIT 1", [runId])).rows[0];
      const recovered = await deliverThroughBullMq(database, saver, recoveryDispatch.payload as RunJob, recoveryDispatch.id, mode);
      const afterRecovery = (await database.pool.query('SELECT effect_count FROM durable_crash_e2e_effects WHERE run_id=$1', [runId])).rows[0].effect_count;
      assert.equal(afterRecovery, 1, 'a completed or uncertain Tool must not be executed automatically again');

      if (mode === 'after-ledger-success') {
        assert.equal(recovered.kind, 'completed');
        assert.equal(recovered.userMessageCount, 1);
        assert.equal(recovered.answer, 'operation recorded');
        const tools = await database.pool.query("SELECT status FROM tool_executions WHERE run_id=$1 AND tool_call_id='stable-tool-call'", [runId]);
        assert.equal(tools.rows[0].status, 'succeeded');
      } else if (mode === 'subagent-background-after-ledger-success') {
        assert.equal(recovered.kind, 'child-completed');
        assert.equal(recovered.answer, 'child report');
        const child = await database.pool.query('SELECT id,status,summary FROM child_executions WHERE root_run_id=$1', [runId]);
        assert.equal(child.rows[0].status, 'completed');
        assert.equal(child.rows[0].summary, 'child report');
        const tools = await database.pool.query("SELECT status,scope_id FROM tool_executions WHERE run_id=$1 AND tool_call_id='stable-child-tool-call'", [runId]);
        assert.equal(tools.rows[0].status, 'succeeded');
        assert.equal(tools.rows[0].scope_id, `${child.rows[0].id}:1`);
      } else {
        assert.equal(recovered.kind, 'approval', 'an external result missing from the ledger must ask for confirmation');
        assert.match(recovered.description ?? '', /outcome is unknown/);
        const tools = await database.pool.query("SELECT status FROM tool_executions WHERE run_id=$1 AND tool_call_id='stable-tool-call'", [runId]);
        assert.equal(tools.rows[0].status, 'started');
      }
    } finally {
      if (runId) {
        const childThreads = await database.pool.query('SELECT thread_id,attempt FROM child_executions WHERE root_run_id=$1', [runId]);
        for (const child of childThreads.rows) await saver.deleteThread(`${child.thread_id}:attempt:${child.attempt}`);
        await database.pool.query('DELETE FROM durable_crash_e2e_effects WHERE run_id=$1', [runId]);
        await database.pool.query('DELETE FROM agent_runs WHERE id=$1', [runId]);
      }
      if (sessionId) await saver.deleteThread(sessionId);
      await database.pool.query('DELETE FROM tenants WHERE id=$1', [context.tenantId]);
      await database.pool.query('DELETE FROM users WHERE id=$1', [context.userId]);
      await database.repository.close();
    }
  });
}
