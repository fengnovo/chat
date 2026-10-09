import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver, MessagesAnnotation, StateGraph, interrupt } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildRuntimeDescriptor, createDeepAgentRuntime } from '../src/deep-agent.js';
import { adaptLangGraph } from '../src/graph-recovery.js';
import type { HeadlessAgentOptions } from '../src/types.js';
import { DurableExecutionError } from '../src/tool-execution.js';
import { closeSharedMcpClients } from '../src/mcp-client-cache.js';

for (const source of ['base', 'knowledge'] as const) {
  test(`${source} MCP outage allows fresh runs but preserves and retries established tool descriptors`, async (t) => {
    let unavailable = false;
    const server = createServer(async (request, response) => {
      if (unavailable) { response.writeHead(503).end('temporarily unavailable'); return; }
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let body = '';
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : { tools: [{ name: 'external_read', description: 'Read external data', inputSchema: { type: 'object', properties: {} } }] };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-discovery-'));
    t.after(async () => {
      await closeSharedMcpClients();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const configPath = path.join(directory, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: { external: { type: 'http', url } } }));
    const accepted = new Error('descriptor accepted; stop before graph execution');
    const descriptors: Record<string, unknown>[] = [];
    let savedDescriptor: Record<string, unknown> | undefined;
    const options: HeadlessAgentOptions = {
      runId: 'run', sessionId: 'session', workspacePath: '/workspace', backend: {}, checkpointer: new MemorySaver(),
      models: [{ id: 'main', model: 'gpt-4o', provider: 'openai', apiKey: 'unused-local-test-key' }],
      ...(source === 'base' ? { mcpConfigPath: configPath } : { knowledgeMcp: { enabled: true, url, token: 'local-test', timeoutMs: 1000 } }),
      durable: { tools: {} as never, children: {} as never, assertOwnership: async () => {},
        bindRuntimeDescriptor: async (descriptor) => {
          if (savedDescriptor && JSON.stringify(savedDescriptor) !== JSON.stringify(descriptor)) {
            throw new DurableExecutionError('storage wrapper', { cause: Object.assign(new Error('descriptor mismatch'), { code: 'RECOVERY_INCOMPATIBLE' }) });
          }
          savedDescriptor = descriptor;
          descriptors.push(descriptor);
          throw accepted;
        } },
    };
    // 新 run 可以在缺少可选 MCP 工具时启动。
    unavailable = true;
    await assert.rejects(() => createDeepAgentRuntime(options), (error) => error === accepted);
    assert.ok(!(descriptors[0]!.tools as Array<{ name: string }>).some((tool) => tool.name === 'external_read'));
    savedDescriptor = undefined;
    descriptors.length = 0;
    unavailable = false;
    await assert.rejects(() => createDeepAgentRuntime(options), (error) => error === accepted);
    assert.equal(descriptors.length, 1);
    assert.ok((descriptors[0]!.tools as Array<{ name: string }>).some((tool) => tool.name === 'external_read'));
    await closeSharedMcpClients();
    unavailable = true;
    await assert.rejects(() => createDeepAgentRuntime(options), (error) => {
      if (!(error instanceof DurableExecutionError)) return false;
      let cause: unknown = error;
      while (cause && typeof cause === 'object') {
        if ('code' in cause && cause.code === 'RECOVERY_INCOMPATIBLE') return false;
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      return true;
    });
    assert.equal(descriptors.length, 1, 'an outage must not replace the saved descriptor');
    unavailable = false;
    await assert.rejects(() => createDeepAgentRuntime(options), (error) => error === accepted);
    assert.equal(descriptors.length, 2, 'the original tool set becomes usable again after recovery');
  });
}

test('runtime descriptor changes with trusted policy or tool schema but excludes credentials and mutable memory', async () => {
  const makeTool = (schema: z.ZodObject) => tool(async () => 'no provider call', { name: 'external', description: 'external', schema });
  const options: HeadlessAgentOptions = { runId: 'run', sessionId: 'session', backend: {}, checkpointer: {},
    workspacePath: '/ephemeral/workspace', backendMode: 'docker',
    models: [{ id: 'main', provider: 'openai', model: 'model-1', apiKey: 'SECRET', baseUrl: 'https://host.test/v1?token=SECRET' }],
    longTermMemory: { context: 'mutable fact', store: {}, namespace: ['user'] },
    durable: { tools: {} as never, children: {} as never, assertOwnership: async () => {},
      toolPolicies: { external: { replaySafe: false } }, runtimeResources: { skills: 'skill-hash' } },
  };
  const first = buildRuntimeDescriptor(options, [makeTool(z.object({ text: z.string() }))]);
  const equivalent = buildRuntimeDescriptor({ ...options, workspacePath: '/different',
    models: [{ ...options.models[0]!, apiKey: 'OTHER', baseUrl: 'https://host.test/v1?token=OTHER' }],
    longTermMemory: { store: {}, namespace: ['user'], context: 'new mutable fact' },
  }, [makeTool(z.object({ text: z.string() }))]);
  assert.deepEqual(equivalent, first);
  assert.doesNotMatch(JSON.stringify(first), /SECRET|mutable fact|ephemeral|token=/);
  assert.notDeepEqual(buildRuntimeDescriptor(options, [makeTool(z.object({ count: z.number() }))]), first);
  assert.notDeepEqual(buildRuntimeDescriptor({ ...options, durable: { ...options.durable!, toolPolicies: { external: { replaySafe: true } } } }, [makeTool(z.object({ text: z.string() }))]), first);
  assert.notDeepEqual(buildRuntimeDescriptor({ ...options, durable: { ...options.durable!, runtimeResources: { skills: 'changed-hash' } } }, [makeTool(z.object({ text: z.string() }))]), first);
  assert.notDeepEqual(buildRuntimeDescriptor({ ...options, memory: ['/instructions-v2.md'] }, [makeTool(z.object({ text: z.string() }))]), first);
  assert.notDeepEqual(buildRuntimeDescriptor({ ...options, models: [{ ...options.models[0]!, model: 'model-2' }] }, [makeTool(z.object({ text: z.string() }))]), first);
  assert.deepEqual(buildRuntimeDescriptor({ ...options, autoApproveTools: true }, [makeTool(z.object({ text: z.string() }))]), first);
  const ordered = buildRuntimeDescriptor({ ...options, memory: ['/first.md', '/second.md'] }, []);
  assert.notDeepEqual(buildRuntimeDescriptor({ ...options, memory: ['/second.md', '/first.md'] }, []), ordered);
});

test('recovery adapter validates snapshots and preserves real graph interrupt and message behavior', async () => {
  const graph = new StateGraph(MessagesAnnotation).addNode('approval', () => {
    const accepted = interrupt('approve child');
    return { messages: [new AIMessage(accepted ? 'done' : 'rejected')] };
  }).addEdge('__start__', 'approval').addEdge('approval', '__end__').compile({ checkpointer: new MemorySaver() });
  const adapter = adaptLangGraph(graph);
  const config = { configurable: { thread_id: 'adapter' } };
  await adapter.invoke({ messages: [new HumanMessage('task')] }, config);
  assert.equal((await adapter.getState(config)).tasks?.[0]?.interrupts?.[0]?.value, 'approve child');
  await adapter.invoke(new Command({ resume: true }), config);
  assert.equal((await adapter.getState(config)).values?.messages?.at(-1)?.content, 'done');
  await assert.rejects(() => adaptLangGraph({ getState: async () => ({ tasks: 'invalid' }), invoke: async () => {} }).getState({}), /snapshot/i);
});

test('recovery adapter refuses a non-callable stream iterator before consuming graph output', async () => {
  const graph = adaptLangGraph({ stream: async () => ({ [Symbol.asyncIterator]: 'invalid' }) });
  await assert.rejects(() => graph.stream({}, {}), /Invalid LangGraph stream/);
});

test('descriptor refusal stops runtime before graph/backend execution without provider requests', async () => {
  const refused = new Error('RECOVERY_INCOMPATIBLE_RUNTIME');
  let seen: Record<string, unknown> | undefined;
  await assert.rejects(() => createDeepAgentRuntime({
    runId: 'run', sessionId: 'session', workspacePath: '/workspace',
    backend: () => { throw new Error('backend must not execute before descriptor acceptance'); },
    checkpointer: new MemorySaver(), mcpConfigPath: '/nonexistent/agent-core-mcp-config.json',
    models: [{ id: 'main', model: 'gpt-4o', provider: 'openai', apiKey: 'unused-local-test-key' }],
    durable: { tools: {} as never, children: {} as never, assertOwnership: async () => {},
      bindRuntimeDescriptor: async (descriptor) => { seen = descriptor; throw refused; },
    },
  }), (error) => error === refused);
  const tools = seen?.tools as Array<{ name: string }>;
  assert.ok(tools.some((item) => item.name === 'ask_user'));
  assert.ok(tools.some((item) => item.name === 'spawn_subagent'));
  assert.ok(tools.some((item) => item.name === 'preview_page'));
  assert.doesNotMatch(JSON.stringify(seen), /unused-local-test-key/);
});
