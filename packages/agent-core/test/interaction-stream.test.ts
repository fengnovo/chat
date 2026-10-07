import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import type { AgentEvent } from '@repo/contracts';
import { createDeepAgentRuntime } from '../src/deep-agent.js';

// Keep the production SDK/router/graph/stream adapter; only the remote model is local.
async function modelServer(t: test.TestContext, replies: Array<{ tool?: string; args?: unknown; text?: string }>) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const reply = replies[requests.length - 1];
    assert.ok(reply, 'unexpected model call');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = reply.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function',
      function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { role: 'assistant', content: reply.text };
    const chunk = (delta: unknown, finish_reason: string | null) => ({ id: 'local-model', object: 'chat.completion.chunk',
      created: 1, model: 'gpt-4o', choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, reply.tool ? 'tool_calls' : 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = await createDeepAgentRuntime({
    runId: '11111111-1111-4111-8111-111111111111', sessionId: 'interaction-test', workspacePath: '/workspace',
    backend: (config: ConstructorParameters<typeof StateBackend>[0]) => new StateBackend(config),
    checkpointer: new MemorySaver(), autoApproveTools: true, summarization: false,
    models: [{ id: 'local', provider: 'openai', model: 'gpt-4o', apiKey: 'test', baseUrl: `http://127.0.0.1:${address.port}/v1` }],
  });
  t.after(() => runtime.dispose());
  return { runtime, requests };
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('task updates reach the UI event stream while work is running and on completion', async (t) => {
  const { runtime } = await modelServer(t, [
    { tool: 'write_todos', args: { todos: [{ content: '准备选项', status: 'in_progress' }, { content: '展示结果', status: 'pending' }] } },
    { tool: 'write_todos', args: { todos: [{ content: '准备选项', status: 'completed' }, { content: '展示结果', status: 'completed' }] } },
    { text: '完成' },
  ]);
  const events = await collect(runtime.run('完成这两个任务'));
  const plans = events.filter((event): event is Extract<AgentEvent, { type: 'todo.updated' }> =>
    event.type === 'todo.updated' && event.todos.length > 0);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0]?.todos, [{ content: '准备选项', status: 'in_progress' }, { content: '展示结果', status: 'pending' }]);
  assert.deepEqual(plans[1]?.todos, [{ content: '准备选项', status: 'completed' }, { content: '展示结果', status: 'completed' }]);
  assert.ok(events.indexOf(plans[0]!) < events.findIndex((event) => event.type === 'run.completed'));
});

test('session tool approval still pauses for a multi-select question and resumes with the answer', async (t) => {
  const { runtime, requests } = await modelServer(t, [
    { tool: 'ask_user', args: { question: '选择喜欢的水果', options: [{ label: '苹果' }, { label: '香蕉' }, { label: '橙子' }], multiple: true } },
    { text: '已选择苹果和橙子' },
  ]);
  const events = await collect(runtime.run('弹窗几种水果让我选择一下，可以多选'));
  const question = events.find((event) => event.type === 'question.required');
  assert.ok(question && question.type === 'question.required');
  assert.equal(question.question.multiple, true);
  assert.deepEqual(question.question.options.map((option) => option.label), ['苹果', '香蕉', '橙子']);
  assert.equal(events.some((event) => event.type === 'run.completed'), false);
  const resumed = await collect(runtime.resume({ kind: 'question', interruptId: question.interruptId,
    answer: { selections: [{ index: 0, label: '苹果' }, { index: 2, label: '橙子' }] } }));
  assert.ok(resumed.some((event) => event.type === 'run.completed'));
  assert.ok(requests[1]?.messages.some((message) => message.role === 'tool' && String(message.content).includes('橙子')));
});
