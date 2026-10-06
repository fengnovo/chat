import { createDatabase } from '../../../db/src/index.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent, tool } from 'langchain';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

import { createDurableRuntimePorts } from '../../../../apps/worker/src/durable-runtime.js';
import { createFencedCheckpointer } from '../../../../apps/worker/src/fenced-checkpointer.js';
import { createBackgroundRunContext, createSpawnSubagentTool, type SpawnSubagentOptions } from '../../../agent-core/src/subagent.js';
import { createToolExecutionMiddleware } from '../../../agent-core/src/tool-execution.js';

const databaseUrl = process.env.DATABASE_URL!;
const job = JSON.parse(process.env.DURABLE_E2E_JOB!) as import('../../../contracts/src/index.js').RunJob;
const mode = process.env.DURABLE_E2E_MODE!;

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
  override _llmType() { return 'durable-child-crash-e2e'; }
  override bindTools() { return this; }
  override async _generate(messages: BaseMessage[]) {
    if (messages.some((message) => ToolMessage.isInstance(message))) {
      return { generations: [{ text: 'child report', message: new AIMessage('child report') }] };
    }
    return { generations: [{ text: '', message: new AIMessage({ content: '', tool_calls: [
      { name: 'external_write', args: {}, id: 'stable-child-tool-call', type: 'tool_call' },
    ] }) }] };
  }
}

const database = createDatabase(databaseUrl);
const require = createRequire(new URL('../../../../apps/worker/package.json', import.meta.url));
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres') as { PostgresSaver: new (pool: unknown) => any };
const checkpointer = new PostgresSaver(database.pool);
await checkpointer.setup();
const lease = await database.repository.durable.claimRun(job, 30_000, `crash-fixture-${process.pid}`);
if (!lease) throw new Error('crash fixture could not claim the run');
await database.repository.markDispatchConsumed(process.env.DURABLE_E2E_DISPATCH_ID!);

const durable = createDurableRuntimePorts(database.repository, lease, {});
const realComplete = durable.tools.complete;
durable.tools.complete = async (executionId, result) => {
  await realComplete(executionId, result);
  if (mode === 'after-ledger-success' || mode === 'subagent-background-after-ledger-success') process.kill(process.pid, 'SIGKILL');
};

if (mode === 'subagent-background-after-ledger-success') {
  const effect = tool(async () => {
    await database.pool.query('UPDATE durable_crash_e2e_effects SET effect_count=effect_count+1 WHERE run_id=$1', [job.runId]);
    return 'child effect committed';
  }, { name: 'external_write', description: 'Controlled child effect', schema: z.object({}) });
  const childOptions: SpawnSubagentOptions = {
    runId: job.runId,
    router: { primary: new DeterministicChildModel({}), middleware: createMiddleware({ name: 'DurableCrashE2ERouter' }) },
    tools: [effect],
    durable: { store: durable.children, checkpointer: createFencedCheckpointer(checkpointer, database.repository.durable, lease),
      toolMiddleware: (scopeId) => createToolExecutionMiddleware({ store: durable.tools, scopeId, assertOwnership: durable.assertOwnership }) },
  };
  const spawned = createSpawnSubagentTool(childOptions, { review: async () => ({ skipped: true }) });
  const background = createBackgroundRunContext();
  await spawned.invoke({ name: 'spawn_subagent', type: 'tool_call', id: 'stable-parent-spawn-call', args: {
    role_prompt: 'Researcher', task: 'Complete the controlled background child task', background: true,
  } }, { configurable: { backgroundCtx: background } });
  await background.settled();
  throw new Error('background child should have been killed after committing its Tool ledger result');
}

const effect = tool(async () => {
  await database.pool.query('UPDATE durable_crash_e2e_effects SET effect_count=effect_count+1 WHERE run_id=$1', [job.runId]);
  if (mode === 'after-external-effect') process.kill(process.pid, 'SIGKILL');
  return 'external effect committed';
}, { name: 'external_write', description: 'Controlled PostgreSQL effect', schema: z.object({}) });

const middleware = (await import('../../../agent-core/src/tool-execution.js')).createToolExecutionMiddleware({
  store: durable.tools, scopeId: job.runId, assertOwnership: durable.assertOwnership,
});
const agentValue = createAgent({
  model: new DeterministicModel({}), tools: [effect], middleware: [middleware as never],
  checkpointer: createFencedCheckpointer(checkpointer, database.repository.durable, lease),
});
const agent = agentValue as unknown as { invoke(input: unknown, config: unknown): Promise<unknown> };
const config = {
  configurable: { thread_id: job.sessionId },
  metadata: { run_id: `${job.runId}:initial`, business_run_id: job.runId },
  durability: 'sync' as const,
};
await agent.invoke({ messages: [new HumanMessage({ id: `user-${job.runId}`, content: job.kind === 'start' ? job.message : 'task' })] }, config);
await checkpointer.end();
await database.repository.close();
process.exit(0);
