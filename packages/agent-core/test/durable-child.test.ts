import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph, interrupt } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

import * as subagent from '../src/subagent.js';
import { createToolExecutionMiddleware, DurableExecutionError, stableToolInputHash, type ToolExecutionRecord, type ToolExecutionStore } from '../src/tool-execution.js';

import {
  createBackgroundRunContext,
  createSpawnSubagentTool,
  runSpawnLoop,
  type DurableChildRecord,
  type DurableChildStore,
  type SpawnLoopDeps,
  type SpawnSubagentInput,
  type SpawnSubagentOptions,
} from '../src/subagent.js';

const input: SpawnSubagentInput = {
  role_prompt: 'Researcher', task: 'Produce the report', model_tier: 'fast', background: false,
};

function memoryStore(): DurableChildStore & { records: Map<string, DurableChildRecord> } {
  const records = new Map<string, DurableChildRecord>();
  return {
    records,
    async ensure(parentToolCallId, childInput, background) {
      const existing = [...records.values()].find((item) => item.parentToolCallId === parentToolCallId);
      if (existing) return structuredClone(existing);
      const record: DurableChildRecord = {
        id: `child-${parentToolCallId}`, parentToolCallId, threadId: `thread-${parentToolCallId}`,
        input: childInput, background, status: 'pending', attempt: 1, feedback: null,
        attemptResult: null, summary: null, review: null,
      };
      records.set(record.id, structuredClone(record));
      return structuredClone(record);
    },
    async get(id) { return structuredClone(records.get(id) ?? null); },
    async listBackground() { return structuredClone([...records.values()].filter((item) => item.background)); },
    async save(id, patch) {
      const current = records.get(id);
      assert.ok(current);
      const saved = { ...current, ...patch };
      records.set(id, structuredClone(saved));
      return structuredClone(saved);
    },
  };
}
function options(store: DurableChildStore): SpawnSubagentOptions {
  return { runId: 'run-1', router: { primary: null, middleware: null }, tools: [],
    durable: { store, checkpointer: {} } };
}
function deps(run: SpawnLoopDeps['run'], review: SpawnLoopDeps['review'] = async () => ({ skipped: true })): SpawnLoopDeps {
  return { run, review, emit: () => {} };
}

test('durable foreground spawn reuses the saved identity and final result for the same parent call', async () => {
  const store = memoryStore();
  let executions = 0;
  const spawn = createSpawnSubagentTool(options(store), {
    runSpawnLoop: (opts, childInput, config, _deps, override) => runSpawnLoop(opts, childInput, config, deps(async () => {
      executions++; return { status: 'completed', summary: 'Saved report', toolCalls: 1 };
    }), override),
  });
  const call = { name: 'spawn_subagent', type: 'tool_call' as const, id: 'parent-call', args: input };
  const first = await spawn.invoke(call);
  const second = await spawn.invoke(call);
  assert.equal(first.content, 'Saved report');
  assert.equal(second.content, 'Saved report');
  assert.equal(executions, 1);
  assert.equal(store.records.size, 1);
  assert.equal(store.records.get('child-parent-call')?.status, 'completed');
});

test('durable spawn refuses an invocation without a stable parent tool call ID', async () => {
  const spawn = createSpawnSubagentTool(options(memoryStore()), { runSpawnLoop: async () => 'unguarded' });
  await assert.rejects(() => spawn.invoke(input), /tool.call.*id/i);
});

test('durable loop saves completed attempt output before review and reuses it after review crashes', async () => {
  const store = memoryStore();
  let executions = 0;
  let reviews = 0;
  const loopDeps = deps(async () => {
    executions++;
    return { status: 'completed', summary: 'Attempt output', toolCalls: 2 };
  }, async () => {
    reviews++;
    assert.equal(store.records.get('child-parent-review')?.attemptResult?.summary, 'Attempt output');
    if (reviews === 1) throw Object.assign(new Error('review connection lost'), { code: 'DURABLE_EXECUTION_INTERRUPTED' });
    return { skipped: false, verdict: { passed: true, score: 95, feedback: '', checklist: [] } };
  });
  const config = { toolCall: { id: 'parent-review' } };
  await assert.rejects(() => runSpawnLoop(options(store), input, config, loopDeps), /review connection lost/);
  assert.equal(await runSpawnLoop(options(store), input, config, loopDeps), 'Attempt output');
  assert.equal(executions, 1);
  assert.equal(reviews, 2);
});

test('durable loop commits review feedback and attempt before running remediation', async () => {
  const store = memoryStore();
  const seen: string[] = [];
  const loopDeps = deps(async (_options, runInput) => {
    const record = store.records.get('child-parent-remediation');
    assert.ok(record);
    seen.push(`${record.attempt}:${runInput.prior_feedback ?? ''}`);
    assert.equal(record.feedback, runInput.prior_feedback ?? null);
    return { status: 'completed', summary: `Report ${record.attempt}`, toolCalls: 0 };
  }, async () => seen.length === 1
    ? { skipped: false, verdict: { passed: false, score: 40, feedback: 'Add sources', checklist: [] } }
    : { skipped: false, verdict: { passed: true, score: 95, feedback: '', checklist: [] } });
  assert.equal(await runSpawnLoop(options(store), input, { toolCallId: 'parent-remediation' }, loopDeps), 'Report 2');
  assert.deepEqual(seen, ['1:', '2:Add sources']);
});

test('durable background intent is saved before ack and registered once per context', async () => {
  const store = memoryStore();
  const ctx = createBackgroundRunContext();
  let executions = 0;
  const spawn = createSpawnSubagentTool(options(store), {
    run: async () => { executions++; return { status: 'completed', summary: 'Background report', toolCalls: 0 }; },
    review: async () => ({ skipped: true }),
  });
  const call = { name: 'spawn_subagent', type: 'tool_call' as const, id: 'parent-background', args: { ...input, background: true } };
  const config = { configurable: { backgroundCtx: ctx } };
  const first = await spawn.invoke(call, config);
  const second = await spawn.invoke(call, config);
  assert.match(String(first.content), /child-parent-background/);
  assert.equal(second.content, first.content);
  assert.equal(store.records.size, 1);
  const results = await ctx.settled();
  assert.equal(results.length, 1);
  assert.equal(results[0]?.summary, 'Background report');
  assert.equal(executions, 1);
});


// 生产环境的栅栏 saver 会在原子 put 事务中保留调用元数据。
class MetadataMemorySaver extends MemorySaver {
  override async put(...args: Parameters<MemorySaver['put']>): ReturnType<MemorySaver['put']> {
    const [config, checkpoint, metadata] = args;
    return super.put(config, checkpoint, { ...config.metadata, ...metadata });
  }
}

// 使用真实 LangGraph 检查点验证恢复决策，不依赖模型服务。
test('durable child graph resumes its own checkpoint with no duplicated task input or inherited parent namespace', async () => {
  const store = memoryStore();
  const record = await store.ensure('checkpoint', input, false);
  const saver = new MetadataMemorySaver();
  let sideEffects = 0;
  let failOnce = true;
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('effect', () => { sideEffects++; return { messages: [new AIMessage('Effect committed')] }; })
    .addNode('finish', () => {
      if (failOnce) { failOnce = false; throw Object.assign(new Error('worker lost'), { code: 'DURABLE_EXECUTION_INTERRUPTED' }); }
      return { messages: [new AIMessage('Recovered report')] };
    })
    .addEdge(START, 'effect').addEdge('effect', 'finish').addEdge('finish', END)
    .compile({ checkpointer: saver });
  const childOptions: SpawnSubagentOptions = {
    ...options(store), durable: { store, checkpointer: saver },
    childExecution: { record, config: { configurable: { thread_id: 'parent-thread', checkpoint_ns: 'parent:spawn', checkpoint_id: 'parent-checkpoint' } }, background: false },
  };
  const invokeChild = subagent.invokeDurableChildGraph;
  await assert.rejects(() => AsyncLocalStorageProviderSingleton.runWithConfig({ configurable: {
    thread_id: 'parent-thread', checkpoint_ns: 'parent:spawn', checkpoint_id: 'parent-checkpoint', __pregel_read: () => {},
  } }, () => invokeChild(graph, input, childOptions)), /worker lost/);
  const result = await invokeChild(graph, input, childOptions) as { messages: unknown[] };
  assert.equal(sideEffects, 1);
  assert.equal(result.messages.filter((message) => HumanMessage.isInstance(message)).length, 1);
  assert.equal(subagent.extractSubagentSummary(result), 'Recovered report');
  assert.equal((await saver.getTuple({ configurable: { thread_id: 'parent-thread' } })), undefined);
  const checkpoint = await saver.getTuple({ configurable: { thread_id: 'thread-checkpoint:attempt:1', checkpoint_ns: '' } });
  assert.ok(checkpoint);
  assert.equal((checkpoint.metadata as unknown as { child_id: string }).child_id, 'child-checkpoint');
});

test('rehydration runs unfinished background children and returns completed summaries once per context', async () => {
  const store = memoryStore();
  await store.ensure('pending-background', { ...input, background: true }, true);
  const done = await store.ensure('done-background', { ...input, background: true }, true);
  await store.save(done.id, { status: 'completed', summary: 'Already saved' });
  const context = createBackgroundRunContext();
  let executions = 0;
  const rehydrate = subagent.rehydrateBackgroundChildren;
  const loopDeps = { run: async () => { executions++; return { status: 'completed' as const, summary: 'Recovered background', toolCalls: 0 }; }, review: async () => ({ skipped: true as const }) };
  await rehydrate(options(store), context, loopDeps);
  await rehydrate(options(store), context, loopDeps);
  const results = await context.settled();
  assert.equal(executions, 1);
  assert.deepEqual(results.map((item) => [item.subagentId, item.summary]), [
    ['child-pending-background', 'Recovered background'], ['child-done-background', 'Already saved'],
  ]);
});

test('cancelled children cannot execute again, accept approvals, or rehydrate', async () => {
  const store = memoryStore();
  const cancelled = await store.ensure('cancelled', { ...input, background: true }, true);
  await store.save(cancelled.id, { status: 'cancelled' as DurableChildRecord['status'], summary: null,
    review: { kind: 'interrupt', request: {}, interruptId: 'cancelled-approval', checkpointId: 'checkpoint-1' } });
  let executions = 0;
  const loopDeps = deps(async () => { executions++; return { status: 'completed', summary: 'Incorrect restart', toolCalls: 0 }; });
  const summary = await runSpawnLoop(options(store), { ...input, background: true }, { toolCall: { id: 'cancelled' } }, loopDeps);
  assert.match(summary, /取消|cancel/i);
  assert.equal(await subagent.resumeBackgroundChild(options(store), { decisions: [{ type: 'approve' }] }, 'cancelled-approval'), false);
  const context = createBackgroundRunContext();
  const spawn = createSpawnSubagentTool(options(store), { run: loopDeps.run });
  const cancelledResult = await spawn.invoke({ name: 'spawn_subagent', type: 'tool_call', id: 'cancelled', args: { ...input, background: true } },
    { configurable: { backgroundCtx: context } });
  assert.match(String(cancelledResult.content), /随主任务取消/);
  await subagent.rehydrateBackgroundChildren(options(store), context, loopDeps);
  assert.deepEqual(await context.settled(), []);
  assert.equal(executions, 0);
  assert.equal(store.records.get(cancelled.id)?.status, 'cancelled');
  const record = await store.get(cancelled.id);
  assert.ok(record);
  await assert.rejects(() => subagent.invokeDurableChildGraph({
    getState: async () => ({}), invoke: async () => { executions++; return {}; },
  }, input, { ...options(store), childExecution: { record, config: {}, background: true } }), /cancel/i);
  assert.equal(executions, 0);
});

test('local background abort preserves unfinished intent for recovery instead of completing it', async () => {
  const store = memoryStore();
  const pending = await store.ensure('recoverable-stop', { ...input, background: true }, true);
  const context = createBackgroundRunContext();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  await subagent.rehydrateBackgroundChildren(options(store), context, {
    run: async (opts) => {
      started();
      await new Promise<void>((resolve) => opts.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'completed', summary: 'Incomplete after abort', toolCalls: 0 };
    },
  });
  await ready;
  await context.abortAll();
  await assert.rejects(() => context.settled(), subagent.isDurableChildError);
  assert.equal(store.records.get(pending.id)?.status, 'running');
  assert.equal(store.records.get(pending.id)?.attemptResult, null);
  const recovered = createBackgroundRunContext();
  await subagent.rehydrateBackgroundChildren(options(store), recovered, {
    run: async () => ({ status: 'completed', summary: 'Recovered', toolCalls: 0 }),
    review: async () => ({ skipped: true }),
  });
  assert.equal((await recovered.settled())[0]?.summary, 'Recovered');
});

test('background child approval is persisted and resumed into the same independent graph', async () => {
  const store = memoryStore();
  const record = await store.ensure('approval', { ...input, background: true }, true);
  const saver = new MetadataMemorySaver();
  const request = { actionRequests: [{ name: 'unsafe-write', args: {}, description: 'Previous write outcome unknown' }], reviewConfigs: [{ actionName: 'unsafe-write', allowedDecisions: ['approve', 'reject'] }] };
  let effects = 0;
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('approval', () => {
      const response = interrupt(request) as { decisions: Array<{ type: string }> };
      if (response.decisions[0]?.type === 'approve') effects++;
      return { messages: [new AIMessage('Approved report')] };
    })
    .addEdge(START, 'approval').addEdge('approval', END).compile({ checkpointer: saver });
  const childOptions: SpawnSubagentOptions = { ...options(store), durable: { store, checkpointer: saver }, childExecution: { record, config: null, background: true } };
  const invokeChild = subagent.invokeDurableChildGraph;
  const resume = subagent.resumeBackgroundChild;
  const ctx = createBackgroundRunContext();
  ctx.register({ subagentId: record.id, role: 'Researcher', description: input.task, run: async () => {
    await invokeChild(graph, input, childOptions); return 'unexpected success';
  } });
  await assert.rejects(() => ctx.settled(), (error: unknown) => {
    assert.equal((error as { interruptId?: string }).interruptId, 'child-child-approval-1');
    assert.deepEqual((error as { request?: unknown }).request, request);
    return true;
  });
  assert.equal(store.records.get(record.id)?.status, 'waiting');
  assert.equal(effects, 0);
  assert.equal(await resume(options(store), { decisions: [{ type: 'approve' }] }, 'different-child'), false);
  assert.equal(await resume(options(store), { decisions: [{ type: 'approve' }] }, 'child-child-approval-1'), true);
  const resumedRecord = await store.get(record.id);
  assert.ok(resumedRecord);
  const result = await invokeChild(graph, input, { ...childOptions, childExecution: { record: resumedRecord, config: null, background: true } });
  assert.equal(subagent.extractSubagentSummary(result), 'Approved report');
  assert.equal(effects, 1);
});

test('foreground child transfers approval to the parent checkpoint and resumes the child without repeating effects', async () => {
  const store = memoryStore();
  const saver = new MetadataMemorySaver();
  const request = { actionRequests: [{ name: 'unsafe-write', args: {}, description: 'Approve repeated external write' }], reviewConfigs: [{ actionName: 'unsafe-write', allowedDecisions: ['approve', 'reject'] }] };
  let firstEffect = 0;
  let approvedEffect = 0;
  const child = new StateGraph(MessagesAnnotation)
    .addNode('first', () => { firstEffect++; return { messages: [new AIMessage('First effect done')] }; })
    .addNode('unsafe', () => {
      const response = interrupt(request) as { decisions: Array<{ type: string }> };
      if (response.decisions[0]?.type === 'approve') approvedEffect++;
      return { messages: [new AIMessage('Foreground approved report')] };
    })
    .addEdge(START, 'first').addEdge('first', 'unsafe').addEdge('unsafe', END).compile({ checkpointer: saver });
  const childOptions = { ...options(store), durable: { store, checkpointer: saver } };
  const spawn = createSpawnSubagentTool(childOptions, {
    run: async (opts, childInput) => {
      const result = await subagent.invokeDurableChildGraph(child, childInput, opts);
      return { status: 'completed', summary: subagent.extractSubagentSummary(result), toolCalls: 1 };
    },
    review: async () => ({ skipped: true }),
  });
  const parent = new StateGraph(MessagesAnnotation)
    .addNode('spawn', async () => {
      const response = await spawn.invoke({ name: 'spawn_subagent', type: 'tool_call', id: 'foreground-approval', args: input });
      return { messages: [new AIMessage(String(response.content))] };
    })
    .addEdge(START, 'spawn').addEdge('spawn', END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'parent-approval' }, durability: 'sync' as const };
  const paused = await parent.invoke({ messages: [new HumanMessage('Run child')] }, config) as { __interrupt__?: Array<{ value: unknown }> };
  assert.deepEqual(paused.__interrupt__?.[0]?.value, request);
  assert.equal(store.records.get('child-foreground-approval')?.status, 'waiting');
  assert.equal(firstEffect, 1);
  assert.equal(approvedEffect, 0);
  const result = await parent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config);
  assert.equal(subagent.extractSubagentSummary(result), 'Foreground approved report');
  assert.equal(firstEffect, 1);
  assert.equal(approvedEffect, 1);
  assert.equal(store.records.get('child-foreground-approval')?.status, 'completed');
});

test('durable child persistence failure escapes background settlement for root recovery', async () => {
  const store = memoryStore();
  const originalSave = store.save;
  store.save = async (id, patch) => {
    if (patch.attemptResult) throw new Error('database offline after result');
    return originalSave(id, patch);
  };
  const ctx = createBackgroundRunContext();
  const spawn = createSpawnSubagentTool(options(store), {
    run: async () => ({ status: 'completed', summary: 'External operation done', toolCalls: 1 }),
    review: async () => ({ skipped: true }),
  });
  await spawn.invoke({ name: 'spawn_subagent', type: 'tool_call', id: 'db-failure', args: { ...input, background: true } }, { configurable: { backgroundCtx: ctx } });
  await assert.rejects(() => ctx.settled(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'DURABLE_EXECUTION_INTERRUPTED');
    return true;
  });
  assert.equal(store.records.get('child-db-failure')?.status, 'running');
  assert.equal(store.records.get('child-db-failure')?.summary, null);
});


class DeterministicChildModel extends BaseChatModel {
  failed = false;
  observedHumanCounts: number[] = [];
  override _llmType() { return 'durable-child-test'; }
  override bindTools() { return this; }
  override async _generate(messages: BaseMessage[]) {
    this.observedHumanCounts.push(messages.filter((message) => HumanMessage.isInstance(message)).length);
    if (ToolMessage.isInstance(messages.at(-1))) {
      if (!this.failed) {
        this.failed = true;
        throw Object.assign(new Error('model connection interrupted after tool'), { code: 'DURABLE_EXECUTION_INTERRUPTED' });
      }
      return { generations: [{ text: 'Durable deepagent report', message: new AIMessage('Durable deepagent report') }] };
    }
    return { generations: [{ text: '', message: new AIMessage({ content: '', tool_calls: [
      { name: 'write_fixture', args: {}, id: 'fixture-write', type: 'tool_call' },
    ] }) }] };
  }
}

test('production deepagent child checkpoints tools and uses a child attempt middleware scope', async () => {
  const store = memoryStore();
  const saver = new MetadataMemorySaver();
  const model = new DeterministicChildModel({});
  let effects = 0;
  const scopes: string[] = [];
  const fixtureTool = tool(() => { effects++; return 'Write completed'; }, { name: 'write_fixture', description: 'Controlled test effect', schema: z.object({}) });
  const childOptions: SpawnSubagentOptions = {
    runId: 'run-1',
    router: { primary: model, middleware: createMiddleware({ name: 'FixtureRouter' }) },
    tools: [fixtureTool],
    durable: { store, checkpointer: saver, toolMiddleware: (scope) => {
      scopes.push(scope);
      return createMiddleware({ name: 'FixtureLedger' });
    } },
  };
  const spawn = createSpawnSubagentTool(childOptions, { review: async () => ({ skipped: true }) });
  const call = { name: 'spawn_subagent', type: 'tool_call' as const, id: 'deepagent', args: { ...input, tools_allowlist: ['write_fixture'] } };
  await assert.rejects(() => spawn.invoke(call), (error: unknown) => (error as { code?: string }).code === 'DURABLE_EXECUTION_INTERRUPTED');
  assert.equal(effects, 1);
  const result = await spawn.invoke(call);
  assert.equal(result.content, 'Durable deepagent report');
  assert.equal(effects, 1);
  assert.deepEqual(scopes, ['child-deepagent:1', 'child-deepagent:1']);
  assert.ok(model.observedHumanCounts.every((count) => count === 1));
});

test('background approval is surfaced during event polling while another child is still running', async () => {
  const store = memoryStore();
  const record = await store.ensure('poll-approval', { ...input, background: true }, true);
  const ctx = createBackgroundRunContext();
  ctx.register({ subagentId: 'long-child', role: 'Long', description: 'Waiting', run: async (_emit, signal) =>
    new Promise((resolve) => signal.addEventListener('abort', () => resolve('Aborted'), { once: true })) });
  ctx.register({ subagentId: record.id, role: 'Approval', description: 'Unsafe', run: async () => {
    throw new subagent.DurableChildInterruptError(record, { actionRequests: [] });
  } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ctx.size(), 1);
  assert.throws(() => ctx.drainEvents(), subagent.DurableChildInterruptError);
  await ctx.abortAll();
});

test('a saved child approval response cannot approve a later interrupt after a crash', async () => {
  const store = memoryStore();
  const record = await store.ensure('two-approvals', { ...input, background: true }, true);
  const saver = new MetadataMemorySaver();
  const originalGet = saver.getTuple.bind(saver);
  let failRead = false;
  saver.getTuple = async (...args) => {
    if (failRead) { failRead = false; throw new Error('crash after second interrupt checkpoint'); }
    return originalGet(...args);
  };
  const request1 = { actionRequests: [{ name: 'write-one', args: {} }], reviewConfigs: [] };
  const request2 = { actionRequests: [{ name: 'write-two', args: {} }], reviewConfigs: [] };
  let secondEffects = 0;
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('one', () => { interrupt(request1); return { messages: [new AIMessage('One approved')] }; })
    .addNode('two', () => {
      failRead = true;
      const response = interrupt(request2) as { decisions: Array<{ type: string }> };
      failRead = false;
      if (response.decisions[0]?.type === 'approve') secondEffects++;
      return { messages: [new AIMessage('Two approved')] };
    })
    .addEdge(START, 'one').addEdge('one', 'two').addEdge('two', END).compile({ checkpointer: saver });
  const childOptions: SpawnSubagentOptions = { ...options(store), durable: { store, checkpointer: saver } };
  const invoke = async () => {
    const current = await store.get(record.id);
    assert.ok(current);
    return subagent.invokeDurableChildGraph(graph, input, { ...childOptions, childExecution: { record: current, config: null, background: true } });
  };
  await assert.rejects(invoke, subagent.DurableChildInterruptError);
  await subagent.resumeBackgroundChild(childOptions, { decisions: [{ type: 'approve' }] });
  await assert.rejects(invoke, (error: unknown) => subagent.isDurableChildError(error));
  await assert.rejects(invoke, (error: unknown) => {
    assert.ok(error instanceof subagent.DurableChildInterruptError);
    assert.deepEqual(error.request, request2);
    return true;
  });
  assert.equal(secondEffects, 0);
});

test('foreground child consumes earlier parent resume slots before requesting a later approval', async () => {
  const store = memoryStore();
  const saver = new MetadataMemorySaver();
  const request1 = { actionRequests: [{ name: 'write-one', args: {} }], reviewConfigs: [], durableApprovalId: 'unsafe-one' };
  const request2 = { actionRequests: [{ name: 'write-two', args: {} }], reviewConfigs: [], durableApprovalId: 'unsafe-two' };
  let approvedEffects = 0;
  const child = new StateGraph(MessagesAnnotation)
    .addNode('one', () => { interrupt(request1); return { messages: [new AIMessage('One approved')] }; })
    .addNode('two', () => {
      const response = interrupt(request2) as { decisions: Array<{ type: string }> };
      if (response.decisions[0]?.type === 'approve') approvedEffects++;
      return { messages: [new AIMessage(response.decisions[0]?.type === 'approve' ? 'Two approved' : 'Two rejected')] };
    })
    .addEdge(START, 'one').addEdge('one', 'two').addEdge('two', END).compile({ checkpointer: saver });
  const childOptions = { ...options(store), durable: { store, checkpointer: saver } };
  const spawn = createSpawnSubagentTool(childOptions, {
    run: async (opts, childInput) => ({ status: 'completed', summary: subagent.extractSubagentSummary(await subagent.invokeDurableChildGraph(child, childInput, opts)), toolCalls: 0 }),
    review: async () => ({ skipped: true }),
  });
  const parent = new StateGraph(MessagesAnnotation)
    .addNode('spawn', async () => ({ messages: [new AIMessage(String((await spawn.invoke({ name: 'spawn_subagent', type: 'tool_call', id: 'positional', args: input })).content))] }))
    .addEdge(START, 'spawn').addEdge('spawn', END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'positional-parent' }, durability: 'sync' as const };
  const first = await parent.invoke({ messages: [new HumanMessage('Start')] }, config) as { __interrupt__?: Array<{ value: unknown }> };
  assert.deepEqual(first.__interrupt__?.[0]?.value, request1);
  const second = await parent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config) as { __interrupt__?: Array<{ value: unknown }> };
  assert.deepEqual(second.__interrupt__?.[0]?.value, request2);
  assert.equal(approvedEffects, 0);
  const result = await parent.invoke(new Command({ resume: { decisions: [{ type: 'reject' }], durableApprovalId: 'unsafe-two' } }), config);
  assert.equal(subagent.extractSubagentSummary(result), 'Two rejected');
  assert.equal(approvedEffects, 0);
});


test('a failed approved unsafe child retry requires a new parent approval and respects rejection', async () => {
  const store = memoryStore();
  const saver = new MetadataMemorySaver();
  const ledger: ToolExecutionRecord = {
    executionId: 'unsafe-execution', idempotencyKey: 'stable-key', scopeId: 'child-repeated-unsafe:1',
    toolCallId: 'fixture-write', toolName: 'write_fixture', inputHash: stableToolInputHash({}),
    status: 'uncertain', result: null, replayPolicy: 'unsafe', retryCount: 0,
  };
  const ledgerStore: ToolExecutionStore = {
    async begin() { return { record: structuredClone(ledger), fresh: false }; },
    async retry() { ledger.retryCount++; ledger.status = 'started'; },
    async uncertain() { ledger.status = 'uncertain'; },
    async complete(_id, result) { ledger.status = 'succeeded'; ledger.result = result; },
  };
  let effects = 0;
  const unsafeTool = tool(() => { effects++; throw new Error('external write result lost'); }, { name: 'write_fixture', description: 'Controlled unsafe effect', schema: z.object({}) });
  const model = new DeterministicChildModel({});
  model.failed = true;
  const childOptions: SpawnSubagentOptions = {
    runId: 'run-1', router: { primary: model, middleware: createMiddleware({ name: 'RetryFixtureRouter' }) }, tools: [unsafeTool],
    durable: { store, checkpointer: saver, toolMiddleware: (scopeId) => createToolExecutionMiddleware({ store: ledgerStore, scopeId }) },
  };
  const spawn = createSpawnSubagentTool(childOptions, { review: async () => ({ skipped: true }) });
  const parent = new StateGraph(MessagesAnnotation)
    .addNode('spawn', async () => ({ messages: [new AIMessage(String((await spawn.invoke({ name: 'spawn_subagent', type: 'tool_call', id: 'repeated-unsafe', args: { ...input, tools_allowlist: ['write_fixture'] } })).content))] }))
    .addEdge(START, 'spawn').addEdge('spawn', END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'unsafe-retry-parent' }, durability: 'sync' as const };
  const first = await parent.invoke({ messages: [new HumanMessage('Start')] }, config) as { __interrupt__?: Array<{ value: { durableApprovalId?: string } }> };
  assert.equal(first.__interrupt__?.[0]?.value.durableApprovalId, 'tool-unsafe-execution-0');
  assert.equal(effects, 0);
  await assert.rejects(() => parent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config), subagent.isDurableChildError);
  assert.equal(effects, 1);
  const second = await parent.invoke(null, config) as { __interrupt__?: Array<{ value: { durableApprovalId?: string } }> };
  assert.equal(second.__interrupt__?.[0]?.value.durableApprovalId, 'tool-unsafe-execution-1');
  assert.equal(effects, 1);
  const result = await parent.invoke(new Command({ resume: { decisions: [{ type: 'reject' }], durableApprovalId: 'tool-unsafe-execution-1' } }), config);
  assert.equal(subagent.extractSubagentSummary(result), 'Durable deepagent report');
  assert.equal(effects, 1);
  assert.equal(ledger.status, 'succeeded');
});

test('reviewer infrastructure interruption escapes instead of approving a child by skipping review', async () => {
  const model = { withStructuredOutput: () => ({ invoke: async () => { throw new DurableExecutionError('Reviewer lease lost'); } }) };
  await assert.rejects(() => subagent.reviewSubagentOutput(model, input, 'Saved report'), subagent.isDurableChildError);
});
