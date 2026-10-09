import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages';
import { Command, GraphInterrupt, MemorySaver, Overwrite, Send } from '@langchain/langgraph';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createAgent, FakeToolCallingModel, todoListMiddleware, tool, type AnyAgentMiddleware, type ToolCallRequest } from 'langchain';
import { z } from 'zod';
import {
  createToolExecutionMiddleware, deserializeToolResult, serializeToolResult,
  stableToolInputHash, isDurableExecutionError,
  type ToolExecutionRecord, type ToolExecutionStore,
} from '../src/tool-execution.js';

class Ledger implements ToolExecutionStore {
  records = new Map<string, ToolExecutionRecord>();
  async begin(intent: Parameters<ToolExecutionStore['begin']>[0]) {
    const key = `${intent.scopeId}:${intent.toolCallId}`;
    const previous = this.records.get(key);
    if (previous) return { record: { ...previous }, fresh: false };
    const record: ToolExecutionRecord = {
      ...intent, executionId: key, idempotencyKey: `stable:${key}`,
      status: 'started', result: null, retryCount: 0,
    };
    this.records.set(key, record);
    return { record: { ...record }, fresh: true };
  }
  async complete(id: string, result: unknown) {
    Object.assign(this.records.get(id)!, { status: 'succeeded', result: JSON.parse(JSON.stringify(result)) });
  }
  async retry(id: string) {
    const record = this.records.get(id)!;
    record.status = 'started';
    record.retryCount += 1;
  }
  async uncertain(id: string) { this.records.get(id)!.status = 'uncertain'; }
}

type MiddlewareRequest = Parameters<NonNullable<ReturnType<typeof createToolExecutionMiddleware>['wrapToolCall']>>[0];
function request(name = 'write_file', args: Record<string, unknown> = {}, id: string | undefined = 'call-1') {
  return { toolCall: { name, args, id, type: 'tool_call' }, state: { messages: [] }, tool: undefined, runtime: {} } as MiddlewareRequest;
}

test('canonical input identity ignores key order but detects changed values', () => {
  assert.equal(stableToolInputHash({ b: 2, a: { d: 4, c: 3 } }), stableToolInputHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(stableToolInputHash({ a: 1 }), stableToolInputHash({ a: 2 }));
  assert.notEqual(stableToolInputHash([1, 2]), stableToolInputHash([2, 1]));
});

test('succeeded replay returns stored ToolMessage without repeating its external effect', async () => {
  const store = new Ledger();
  const middleware = createToolExecutionMiddleware({ store, scopeId: 'root' });
  let writes = 0;
  const handler = async () => { writes++; return new ToolMessage({ content: 'saved', tool_call_id: 'call-1', artifact: { version: 3 } }); };
  await middleware.wrapToolCall!(request(), handler);
  const replay = await middleware.wrapToolCall!(request(), handler);
  assert.equal(writes, 1);
  assert.ok(replay instanceof ToolMessage);
  assert.deepEqual(replay.artifact, { version: 3 });
  assert.equal(replay.content, 'saved');
});

test('an explicit MCP error reaches the model and replays without another remote call', async () => {
  const store = new Ledger();
  let calls = 0;
  const [search] = await loadMcpTools('firecrawl', {
    listTools: async () => ({ tools: [{ name: 'firecrawl_search', description: 'Search the web', inputSchema: { type: 'object', properties: {} } }] }),
    callTool: async () => {
      calls++;
      return { isError: true, content: [{ type: 'text', text: 'Request failed with status code 400' }] };
    },
  } as unknown as Parameters<typeof loadMcpTools>[1]);
  for (const thread of ['initial', 'replay']) {
    const saver = new MemorySaver();
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [[{ name: 'firecrawl_search', id: 'call-1', args: {} }], []] }),
      tools: [search!], middleware: [createToolExecutionMiddleware({ store, scopeId: 'root' })], checkpointer: saver,
    });
    const config = { configurable: { thread_id: thread } };
    const result = await agent.invoke({ messages: [new HumanMessage('Compare these cars')] }, config);
    const errorMessage = result.messages.find((message) => ToolMessage.isInstance(message));
    assert.ok(errorMessage instanceof ToolMessage);
    assert.equal(errorMessage.status, 'error');
    assert.match(String(errorMessage.content), /status code 400/);
    const answer = result.messages.at(-1);
    assert.ok(answer instanceof AIMessage);
    assert.equal(answer.tool_calls?.length ?? 0, 0);
    assert.match(String(answer.content), /status code 400/);
  }
  assert.equal(calls, 1);
  assert.equal(store.records.get('root:call-1')?.status, 'succeeded');
});

test('MCP transport failures and malformed responses keep their execution outcome uncertain', async () => {
  for (const failure of ['transport', 'malformed'] as const) {
    const store = new Ledger();
    const [search] = await loadMcpTools('firecrawl', {
      listTools: async () => ({ tools: [{ name: 'firecrawl_search', inputSchema: { type: 'object', properties: {} } }] }),
      callTool: async () => {
        // Even error-like remote text is not proof of a completed call when the transport throws.
        if (failure === 'transport') throw new Error("MCP tool 'firecrawl_search' on server 'firecrawl' returned an error: connection lost");
        return { content: 'invalid result' };
      },
    } as unknown as Parameters<typeof loadMcpTools>[1]);
    const middleware = createToolExecutionMiddleware({ store, scopeId: 'root' });
    await assert.rejects(async () => middleware.wrapToolCall!(request('firecrawl_search'),
      async (req) => search!.invoke(req.toolCall)), isDurableExecutionError);
    assert.equal(store.records.get('root:call-1')?.status, 'uncertain');
    assert.equal(store.records.get('root:call-1')?.result, null);
  }
});

test('an explicit MCP error received after cancellation is not saved as a completed result', async () => {
  const store = new Ledger();
  const controller = new AbortController();
  const req = request('firecrawl_search');
  req.runtime.signal = controller.signal;
  const middleware = createToolExecutionMiddleware({ store, scopeId: 'root' });
  await assert.rejects(async () => middleware.wrapToolCall!(req, async () => {
    controller.abort(new Error('worker shutting down'));
    throw Object.assign(new Error("MCP tool 'firecrawl_search' on server 'firecrawl' returned an error: cancelled"), { name: 'ToolException' });
  }), isDurableExecutionError);
  assert.equal(store.records.get('root:call-1')?.status, 'uncertain');
});

test('Command replay preserves state updates and nested BaseMessages after JSON storage', () => {
  const original = new Command({ update: {
    todos: [{ task: 'save', status: 'completed' }],
    messages: [new ToolMessage({ content: 'updated', tool_call_id: 'call-1' }), new AIMessage({ content: 'ok', id: 'ai-1', tool_calls: [] }), new HumanMessage('hello')],
    artifact: { missing: undefined, date: new Date('2026-01-01T00:00:00Z'), bigint: 7n },
  }, graph: Command.PARENT, goto: ['finish'] });
  const restored = deserializeToolResult(JSON.parse(JSON.stringify(serializeToolResult(original))));
  assert.ok(restored instanceof Command);
  assert.equal(restored.graph, Command.PARENT);
  assert.deepEqual(restored.goto, ['finish']);
  const update = restored.update as { todos: unknown; messages: Array<ToolMessage | AIMessage | HumanMessage>; artifact: { missing: undefined; date: Date; bigint: bigint } };
  assert.deepEqual(update.todos, [{ task: 'save', status: 'completed' }]);
  assert.ok(update.messages[0] instanceof ToolMessage);
  assert.equal(update.messages[0].content, 'updated');
  assert.ok(update.messages[1] instanceof AIMessage);
  assert.equal(update.messages[1].id, 'ai-1');
  assert.ok(update.messages[2] instanceof HumanMessage);
  assert.equal(update.artifact.date.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(update.artifact.bigint, 7n);
  assert.ok(Object.hasOwn(update.artifact, 'missing'));
});

test('changed input or missing stable call identity blocks the handler', async () => {
  const middleware = createToolExecutionMiddleware({ store: new Ledger(), scopeId: 'root' });
  let effects = 0;
  const handler = async () => { effects++; return new ToolMessage({ content: 'ok', tool_call_id: 'call-1' }); };
  await middleware.wrapToolCall!(request('write_file', { text: 'one' }), handler);
  await assert.rejects(async () => middleware.wrapToolCall!(request('write_file', { text: 'two' }), handler), isDurableExecutionError);
  const missing = request(); delete missing.toolCall.id;
  await assert.rejects(async () => middleware.wrapToolCall!(missing, handler), isDurableExecutionError);
  assert.equal(effects, 1);
});

test('safe retry uses the original record and injects its stable external idempotency key', async () => {
  const store = new Ledger();
  const middleware = createToolExecutionMiddleware({ store, scopeId: 'root', policies: { external_write: { replaySafe: true, idempotencyKeyArgument: 'key' } } });
  const keys: unknown[] = [];
  const handler = async (req: ToolCallRequest) => {
    keys.push(req.toolCall.args.key);
    if (keys.length === 1) throw new Error('connection lost after remote write');
    return new ToolMessage({ content: 'saved', tool_call_id: 'call-1' });
  };
  await assert.rejects(async () => middleware.wrapToolCall!(request('external_write'), handler), isDurableExecutionError);
  assert.equal(store.records.get('root:call-1')?.status, 'uncertain');
  await middleware.wrapToolCall!(request('external_write'), handler);
  assert.deepEqual(keys, ['stable:root:call-1', 'stable:root:call-1']);
  assert.equal(store.records.size, 1);
});

test('storage and ownership failures block side effects and remain recoverable graph errors', async () => {
  for (const failure of ['begin', 'ownership'] as const) {
    const store = new Ledger();
    if (failure === 'begin') store.begin = async () => { throw new Error('database unavailable'); };
    let effects = 0;
    const externalTool = tool(async () => { effects++; return 'saved'; }, { name: 'external_write', description: 'External write', schema: z.object({}) });
    const middleware = createToolExecutionMiddleware({ store, scopeId: 'root', ...(failure === 'ownership' ? { assertOwnership: async () => { throw new Error('lease lost'); } } : {}) });
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }]] }), tools: [externalTool], middleware: [middleware], checkpointer: new MemorySaver() });
    await assert.rejects(() => agent.invoke({ messages: [new HumanMessage('write')] }, { configurable: { thread_id: failure } }), isDurableExecutionError);
    assert.equal(effects, 0);
  }
});

test('a success persistence failure leaves unsafe effects uncertain for recovery', async () => {
  const store = new Ledger();
  store.complete = async () => { throw new Error('database disconnected after external success'); };
  const middleware = createToolExecutionMiddleware({ store, scopeId: 'root' });
  let effects = 0;
  await assert.rejects(async () => middleware.wrapToolCall!(request(), async () => { effects++; return new ToolMessage({ content: 'saved', tool_call_id: 'call-1' }); }), isDurableExecutionError);
  assert.equal(effects, 1);
  assert.equal(store.records.get('root:call-1')?.status, 'started');
});

test('graph interrupts propagate without falsely completing or marking tool execution uncertain', async () => {
  const store = new Ledger();
  const middleware = createToolExecutionMiddleware({ store, scopeId: 'root' });
  const graphInterrupt = new GraphInterrupt([{ value: 'approval', id: 'interrupt-id' }]);
  await assert.rejects(async () => middleware.wrapToolCall!(request(), async () => { throw graphInterrupt; }), (error) => error === graphInterrupt);
  assert.equal(store.records.get('root:call-1')?.status, 'started');
  await assert.rejects(async () => middleware.wrapToolCall!(request('ask_user'), async () => { throw graphInterrupt; }), (error) => error === graphInterrupt);
  assert.equal(store.records.size, 1);
});

test('Command routing Send packets and artifact marker keys survive typed encoding', () => {
  const command = new Command({ update: { artifact: { type: 'undefined', value: { __proto__: null, payload: [undefined, -0, NaN, Infinity] } } }, goto: new Send('child', { messages: [new HumanMessage('work')] }) });
  const result = deserializeToolResult(JSON.parse(JSON.stringify(serializeToolResult(command))));
  assert.ok(result instanceof Command);
  const send = Array.isArray(result.goto) ? result.goto[0] : result.goto;
  assert.ok(send instanceof Send);
  assert.equal(send.node, 'child');
  assert.ok(send.args.messages[0] instanceof HumanMessage);
  const artifact = (result.update as { artifact: { type: string; value: { payload: unknown[] } } }).artifact;
  assert.equal(artifact.type, 'undefined');
  assert.equal(artifact.value.payload[0], undefined);
  assert.ok(Object.is(artifact.value.payload[1], -0));
  assert.ok(Number.isNaN(artifact.value.payload[2]));
  assert.equal(artifact.value.payload[3], Infinity);
});

test('Command state reducer overwrite survives result replay', () => {
  const result = deserializeToolResult(JSON.parse(JSON.stringify(serializeToolResult(new Command({ update: { messages: new Overwrite([new HumanMessage('replacement')]) } })))));
  assert.ok(result instanceof Command);
  const messages = (result.update as { messages: Overwrite<HumanMessage[]> }).messages;
  assert.ok(Overwrite.isInstance(messages));
  assert.ok(messages.value[0] instanceof HumanMessage);
});

test('message removal commands preserve their BaseMessage operation on replay', () => {
  const result = deserializeToolResult(JSON.parse(JSON.stringify(serializeToolResult(new Command({ update: { messages: [new RemoveMessage({ id: 'obsolete-message' })] } })))));
  assert.ok(result instanceof Command);
  const message = (result.update as { messages: RemoveMessage[] }).messages[0];
  assert.ok(message instanceof RemoveMessage);
  assert.equal(message.id, 'obsolete-message');
});

test('schema must preserve the configured external idempotency argument before effects', async () => {
  let effects = 0;
  const externalTool = tool(async () => { effects++; return 'saved'; }, { name: 'external_write', description: 'External write', schema: z.object({ text: z.string() }) });
  const req = request('external_write', { text: 'hello' }); req.tool = externalTool;
  const middleware = createToolExecutionMiddleware({ store: new Ledger(), scopeId: 'root', policies: { external_write: { replaySafe: true, idempotencyKeyArgument: 'key' } } });
  await assert.rejects(async () => middleware.wrapToolCall!(req, async (input) => externalTool.invoke(input.toolCall) as Promise<ToolMessage>), isDurableExecutionError);
  assert.equal(effects, 0);
});

test('only trusted builtins and configured policies establish replay safety', async () => {
  for (const [name, annotations, policy, expected] of [
    ['read_file', undefined, undefined, 'safe'],
    ['read_file', undefined, { replaySafe: false }, 'unsafe'],
    ['execute', undefined, undefined, 'unsafe'],
    ['external', { readOnlyHint: true }, undefined, 'unsafe'],
    ['external', { idempotentHint: true }, undefined, 'unsafe'],
    ['external', { idempotentHint: true }, { replaySafe: false }, 'unsafe'],
  ] as const) {
    const store = new Ledger();
    const req = request(name);
    if (annotations) req.tool = tool(async () => 'value', { name, description: name, schema: z.object({}), metadata: { annotations } });
    const middleware = createToolExecutionMiddleware({ store, scopeId: 'root', ...(policy ? { policies: { [name]: policy } } : {}) });
    await middleware.wrapToolCall!(req, async () => new ToolMessage({ content: 'ok', tool_call_id: 'call-1' }));
    assert.equal(store.records.get('root:call-1')?.replayPolicy, expected);
  }
});

for (const [stored, current, automatic] of [
  ['unsafe', true, false], ['safe', false, false], ['safe', undefined, false], ['safe', true, true],
] as const) {
  test(`automatic replay requires stored and current trusted safety (${stored}/${current})`, async () => {
    const store = new Ledger();
    await store.begin({ scopeId: 'root', toolCallId: 'call-1', toolName: 'external_write', inputHash: stableToolInputHash({}), input: {}, replayPolicy: stored });
    let effects = 0;
    const externalTool = tool(async () => { effects++; return 'saved'; }, {
      name: 'external_write', description: 'External write', schema: z.object({ key: z.string().optional() }),
      metadata: { annotations: { readOnlyHint: true, idempotentHint: true } },
    });
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }], []] }),
      tools: [externalTool], checkpointer: new MemorySaver(),
      middleware: [createToolExecutionMiddleware({ store, scopeId: 'root', autoApproveTools: true,
        policies: { external_write: { idempotencyKeyArgument: 'key', ...(current === undefined ? {} : { replaySafe: current }) } },
      })],
    });
    const result = await agent.invoke({ messages: [new HumanMessage('write')] }, { configurable: { thread_id: `policy-${stored}-${current}` } });
    assert.equal(effects, automatic ? 1 : 0);
    assert.equal(result.__interrupt__?.length ?? 0, automatic ? 0 : 1);
    assert.equal(store.records.get('root:call-1')?.status, automatic ? 'succeeded' : 'started');
  });
}

test('a cached write_todos Command still applies its state update in a real agent', async () => {
  const store = new Ledger();
  const todos = [{ content: 'Save the report', status: 'completed' as const }];
  for (const thread of ['original', 'replay']) {
    // Installed todo middleware still declares a legacy Zod state schema.
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ name: 'write_todos', id: 'call-1', args: { todos } }], []] }), middleware: [createToolExecutionMiddleware({ store, scopeId: 'root' }), todoListMiddleware() as unknown as AnyAgentMiddleware], checkpointer: new MemorySaver() });
    const result = await agent.invoke({ messages: [new HumanMessage('save todos')] }, { configurable: { thread_id: thread } });
    assert.deepEqual((result as unknown as { todos: unknown }).todos, todos);
    assert.ok(result.messages.some((message) => message instanceof ToolMessage && message.tool_call_id === 'call-1'));
  }
  assert.equal(store.records.size, 1);
  assert.ok(deserializeToolResult(store.records.get('root:call-1')!.result) instanceof Command);
});

test('an unsafe tool error leaves its graph checkpoint resumable and requires approval on recovery', async () => {
  const store = new Ledger();
  let writes = 0;
  const externalTool = tool(async () => {
    writes++;
    if (writes === 1) throw new Error('response lost after external effect');
    return 'saved';
  }, { name: 'external_write', description: 'External write', schema: z.object({}) });
  const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }], []] }), tools: [externalTool], middleware: [createToolExecutionMiddleware({ store, scopeId: 'root' })], checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'failed-unsafe' } };
  await assert.rejects(() => agent.invoke({ messages: [new HumanMessage('write')] }, config), isDurableExecutionError);
  assert.equal(store.records.get('root:call-1')?.status, 'uncertain');
  const paused = await agent.invoke(null, config);
  assert.equal(writes, 1);
  assert.equal(paused.__interrupt__?.length, 1);
  await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config);
  assert.equal(writes, 2);
  assert.equal(store.records.get('root:call-1')?.status, 'succeeded');
});

test('session approval cannot authorize another unsafe retry after an approved response is lost', async () => {
  const store = new Ledger();
  await store.begin({ scopeId: 'root', toolCallId: 'call-1', toolName: 'external_write', inputHash: stableToolInputHash({}), input: {}, replayPolicy: 'unsafe' });
  await store.uncertain('root:call-1');
  let writes = 0;
  const externalTool = tool(async () => {
    writes++;
    if (writes === 1) throw new Error('response lost after the approved retry');
    return 'saved';
  }, { name: 'external_write', description: 'External write', schema: z.object({}) });
  const checkpointer = new MemorySaver();
  const model = new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }], []] });
  const build = (autoApproveTools: boolean) => createAgent({ model, tools: [externalTool],
    middleware: [createToolExecutionMiddleware({ store, scopeId: 'root', ...{ autoApproveTools } })], checkpointer });
  const config = { configurable: { thread_id: 'session-approved-retry' } };
  const manual = build(false);
  const paused = await manual.invoke({ messages: [new HumanMessage('write')] }, config);
  assert.equal(paused.__interrupt__?.length, 1);
  assert.equal(writes, 0);
  const approval = paused.__interrupt__![0]!.value as { durableApprovalId: string };
  // Worker rebuilds the runtime with the persisted session authorization on resume/recovery.
  await assert.rejects(() => build(true).invoke(new Command({ resume: {
    decisions: [{ type: 'approve' }], durableApprovalId: approval.durableApprovalId,
  } }), config), isDurableExecutionError);
  assert.equal(writes, 1);
  const recovered = await build(true).invoke(null, config);
  assert.equal(recovered.__interrupt__?.length, 1);
  assert.equal(writes, 1);
  assert.equal(store.records.get('root:call-1')?.retryCount, 1);
  assert.equal(store.records.get('root:call-1')?.replayPolicy, 'unsafe');
  assert.equal(store.records.get('root:call-1')?.status, 'uncertain');
  const nextApproval = recovered.__interrupt__![0]!.value as { durableApprovalId: string };
  assert.equal(nextApproval.durableApprovalId, 'tool-root:call-1-1');
  await build(true).invoke(new Command({ resume: {
    decisions: [{ type: 'approve' }], durableApprovalId: nextApproval.durableApprovalId,
  } }), config);
  assert.equal(writes, 2);
  assert.equal(store.records.get('root:call-1')?.status, 'succeeded');
});

test('every execution scope requires explicit approval for unknown unsafe effects', async () => {
  const store = new Ledger();
  for (const scopeId of ['authorized', 'manual']) {
    await store.begin({ scopeId, toolCallId: 'call-1', toolName: 'external_write', inputHash: stableToolInputHash({}), input: {}, replayPolicy: 'unsafe' });
    await store.uncertain(`${scopeId}:call-1`);
  }
  let writes = 0;
  const externalTool = tool(async () => { writes++; return 'saved'; }, { name: 'external_write', description: 'External write', schema: z.object({}) });
  for (const scopeId of ['authorized', 'manual']) {
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }], []] }),
      tools: [externalTool], middleware: [createToolExecutionMiddleware({ store, scopeId, ...{ autoApproveTools: scopeId === 'authorized' } })],
      checkpointer: new MemorySaver(),
    });
    const result = await agent.invoke({ messages: [new HumanMessage('write')] }, { configurable: { thread_id: scopeId } });
    assert.equal(result.__interrupt__?.length, 1);
  }
  assert.equal(writes, 0);
  assert.equal(store.records.get('manual:call-1')?.status, 'uncertain');
});

test('a lost response after approved unsafe replay requires a fresh approval before another effect', async () => {
  const store = new Ledger();
  await store.begin({ scopeId: 'root', toolCallId: 'call-1', toolName: 'external_write', inputHash: stableToolInputHash({}), input: {}, replayPolicy: 'unsafe' });
  await store.uncertain('root:call-1');
  let writes = 0;
  const externalTool = tool(async () => {
    writes++;
    if (writes === 1) throw new Error('remote side effect happened but response was lost');
    return 'saved';
  }, { name: 'external_write', description: 'External write', schema: z.object({}) });
  const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }], []] }), tools: [externalTool], middleware: [createToolExecutionMiddleware({ store, scopeId: 'root' })], checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'repeated-unsafe-failure' } };
  const firstPause = await agent.invoke({ messages: [new HumanMessage('write')] }, config);
  assert.equal(writes, 0);
  await assert.rejects(() => agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config), isDurableExecutionError);
  assert.equal(writes, 1);
  assert.equal(store.records.get('root:call-1')?.retryCount, 1);
  const secondPause = await agent.invoke(null, config);
  assert.equal(writes, 1, 'a previously consumed approval must not authorize another external effect');
  assert.equal(secondPause.__interrupt__?.length, 1);
  const firstRequest = firstPause.__interrupt__?.[0]?.value as { durableApprovalId: string };
  const secondRequest = secondPause.__interrupt__?.[0]?.value as { durableApprovalId: string };
  assert.notEqual(firstRequest.durableApprovalId, secondRequest.durableApprovalId);
  assert.equal(firstRequest.durableApprovalId, 'tool-root:call-1-0');
  assert.equal(secondRequest.durableApprovalId, 'tool-root:call-1-1');
  await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }], durableApprovalId: secondRequest.durableApprovalId } }), config);
  assert.equal(writes, 2);
  assert.equal(store.records.get('root:call-1')?.retryCount, 2);
  assert.equal(store.records.get('root:call-1')?.status, 'succeeded');
});

test('changing a previously safe retry to unsafe still honors the first explicit rejection', async () => {
  const store = new Ledger();
  await store.begin({ scopeId: 'root', toolCallId: 'call-1', toolName: 'external_write', inputHash: stableToolInputHash({}), input: {}, replayPolicy: 'safe' });
  await store.retry('root:call-1');
  await store.uncertain('root:call-1');
  let writes = 0;
  const externalTool = tool(async () => { writes++; return 'saved'; }, { name: 'external_write', description: 'External write', schema: z.object({}) });
  const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: {} }], []] }), tools: [externalTool], middleware: [createToolExecutionMiddleware({ store, scopeId: 'root', policies: { external_write: { replaySafe: false } } })], checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'policy-changed-to-unsafe' } };
  const paused = await agent.invoke({ messages: [new HumanMessage('write')] }, config);
  const approval = paused.__interrupt__?.[0]?.value as { durableApprovalId: string };
  const resumed = await agent.invoke(new Command({ resume: { decisions: [{ type: 'reject' }], durableApprovalId: approval.durableApprovalId } }), config);
  assert.equal(writes, 0);
  assert.equal(resumed.__interrupt__?.length ?? 0, 0, 'a rejected action must finish without asking for additional historical approvals');
  assert.equal(store.records.get('root:call-1')?.status, 'succeeded');
});

for (const decision of ['approve', 'reject'] as const) {
  test(`unknown unsafe replay pauses before side effects and resumes with ${decision}`, async () => {
    const store = new Ledger();
    await store.begin({ scopeId: 'root', toolCallId: 'call-1', toolName: 'external_write', inputHash: stableToolInputHash({ text: 'hello' }), input: { text: 'hello' }, replayPolicy: 'unsafe' });
    let writes = 0;
    const externalTool = tool(async () => { writes++; return 'saved'; }, { name: 'external_write', description: 'External write', schema: z.object({ text: z.string() }) });
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ name: 'external_write', id: 'call-1', args: { text: 'hello' } }], []] }), tools: [externalTool], middleware: [createToolExecutionMiddleware({ store, scopeId: 'root' })], checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: `unsafe-${decision}` } };
    const paused = await agent.invoke({ messages: [new HumanMessage('write')] }, config);
    assert.equal(writes, 0);
    assert.equal(store.records.get('root:call-1')?.status, 'started');
    const hitl = paused.__interrupt__?.[0]?.value as { actionRequests: Array<{ description: string }>; reviewConfigs: Array<{ allowedDecisions: string[] }> };
    assert.match(hitl.actionRequests[0]!.description, /unknown|uncertain/i);
    assert.deepEqual(hitl.reviewConfigs[0]?.allowedDecisions, ['approve', 'reject']);
    const resumed = await agent.invoke(new Command({ resume: { decisions: [{ type: decision }] } }), config);
    assert.equal(writes, decision === 'approve' ? 1 : 0);
    assert.equal(store.records.get('root:call-1')?.status, 'succeeded');
    const result = resumed.messages.find((message) => message instanceof ToolMessage);
    assert.ok(result instanceof ToolMessage);
    assert.match(String(result.content), decision === 'approve' ? /saved/ : /not repeated|not replayed|reject/i);
  });
}
