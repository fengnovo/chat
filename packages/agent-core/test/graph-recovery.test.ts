import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { chooseRecoveryInput, canonicalAssistantText, createRecoveryResumeCommand } from '../src/graph-recovery.js';

test('crash recovery resumes the pending node without reappending the initial message', async () => {
  // 与生产环境栅栏 Postgres saver 使用相同的元数据约定。
  class ExecutionSaver extends MemorySaver {
    override put(...args: Parameters<MemorySaver['put']>) {
      args[2] = { ...args[0].metadata, ...args[2] };
      return super.put(...args);
    }
  }
  const saver = new ExecutionSaver();
  let planningCalls = 0;
  let fail = true;
  const makeGraph = () => new StateGraph(MessagesAnnotation)
    .addNode('plan', () => { planningCalls += 1; return { messages: [new AIMessage('plan')] }; })
    .addNode('finish', () => { if (fail) throw new Error('simulated crash'); return { messages: [new AIMessage('done')] }; })
    .addEdge('__start__', 'plan').addEdge('plan', 'finish').addEdge('finish', '__end__')
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'conversation' }, metadata: { business_run_id: 'run-1' }, durability: 'sync' as const };
  const initial = { messages: [new HumanMessage({ content: 'task', id: 'user-run-1' })] };
  await assert.rejects(makeGraph().invoke(initial, config), /simulated crash/);
  fail = false;
  const recovered = makeGraph();
  const snapshot = await recovered.getState(config);
  const result = await recovered.invoke(chooseRecoveryInput(snapshot, 'run-1', initial) as typeof initial | null, config);
  assert.equal(planningCalls, 1);
  assert.equal(result.messages.filter((message) => message.id === 'user-run-1').length, 1);
  assert.equal(result.messages.at(-1)?.content, 'done');
});

test('new run initializes from its input instead of resuming the prior conversation run', () => {
  const input = { messages: ['new task'] };
  assert.equal(chooseRecoveryInput({ metadata: { business_run_id: 'older' } }, 'new', input), input);
  assert.equal(chooseRecoveryInput({}, 'new', input), input);
});

test('only a saved unanswered interrupt replays its approval command', () => {
  const command = { resume: 'approved' };
  const paused = { metadata: { business_run_id: 'r' }, tasks: [{ interrupts: [{ value: 'request' }] }] };
  assert.equal(chooseRecoveryInput(paused, 'r', undefined, command), command);
  assert.equal(chooseRecoveryInput({ metadata: { business_run_id: 'r' }, tasks: [] }, 'r', undefined, command), null);
  assert.throws(() => chooseRecoveryInput({}, 'r', undefined, command), /checkpoint/i);
});

test('canonical text excludes incomplete streamed tokens and tool narration from other runs', () => {
  const messages = [new HumanMessage('old'), new AIMessage('old answer'),
    new HumanMessage({ content: 'task', id: 'user-r' }),
    new AIMessage({ content: 'tool narration', tool_calls: [{ name: 'x', args: {}, id: 'call-x' }] }),
    new AIMessage('result')];
  assert.equal(canonicalAssistantText(messages, 'r'), 'result');
});

test('saved recovery decisions target the current retry and preserve multi-action approval identity', () => {
  const snapshot = { metadata: { business_run_id: 'run' }, tasks: [{ interrupts: [{ id: 'native-id', value: {
    durableApprovalId: 'tool-execution-2', actionRequests: [{ name: 'a', args: {} }, { name: 'b', args: {} }],
  } }] }] };
  assert.equal(createRecoveryResumeCommand(snapshot, { kind: 'approval', interruptId: 'tool-execution-1', decision: 'approve' }), undefined);
  assert.deepEqual(createRecoveryResumeCommand(snapshot, { kind: 'approval', interruptId: 'tool-execution-2', decision: 'reject', message: 'stop' })?.resume, {
    durableApprovalId: 'tool-execution-2', decisions: [{ type: 'reject', message: 'stop' }, { type: 'reject', message: 'stop' }],
  });
});
