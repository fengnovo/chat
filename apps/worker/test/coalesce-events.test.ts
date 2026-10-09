import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '@repo/contracts';
import { coalesceAgentEvents } from '../src/coalesce-events.js';

const base = {runId: '00000000-0000-4000-8000-000000000001', timestamp: '2026-10-08T00:00:00.000Z'};
async function collect(source: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

test('text batching is lossless and flushes before snapshot and terminal events', async () => {
  async function* source(): AsyncGenerator<AgentEvent> {
    for (const text of ['你', '好', '世界']) yield {...base, type: 'assistant.delta', text};
    yield {...base, type: 'assistant.snapshot', text: 'replaced'};
    yield {...base, type: 'assistant.delta', text: '!'};
    yield {...base, type: 'run.completed'};
  }
  const output = await collect(coalesceAgentEvents(source()));
  assert.deepEqual(output, [
    {...base, type: 'assistant.delta', text: '你好世界'}, {...base, type: 'assistant.snapshot', text: 'replaced'},
    {...base, type: 'assistant.delta', text: '!'}, {...base, type: 'run.completed'},
  ]);
});
test('a paused model flushes visible text at the latency deadline', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let release!: () => void;
  async function* source(): AsyncGenerator<AgentEvent> {
    yield {...base, type: 'assistant.delta', text: 'first'};
    await new Promise<void>((resolve) => {release = resolve;});
    yield {...base, type: 'run.completed'};
  }
  const output = coalesceAgentEvents(source(), {delayMs: 25});
  const first = output.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(25);
  assert.deepEqual((await first).value, {...base, type: 'assistant.delta', text: 'first'});
  release();
  assert.equal((await output.next()).value?.type, 'run.completed');
  assert.equal((await output.next()).done, true);
});
test('size limits and event type boundaries keep batching bounded', async () => {
  async function* source(): AsyncGenerator<AgentEvent> {
    yield {...base, type:'assistant.delta',text:'ab'};
    yield {...base, type:'assistant.delta',text:'cd'};
    yield {...base, type:'assistant.reasoning',text:'thinking'};
    yield {...base, type:'assistant.delta',text:'efgh'};
  }
  const output = await collect(coalesceAgentEvents(source(), {maxBytes: 3}));
  assert.deepEqual(output.map((event) => event.type), ['assistant.delta','assistant.delta','assistant.reasoning','assistant.delta']);
  assert.equal(output.filter((event) => event.type === 'assistant.delta').map((event) => event.text).join(''), 'abcdefgh');
});
test('a model IO error flushes its preceding text before propagating', async () => {
  async function* source(): AsyncGenerator<AgentEvent> {
    yield {...base,type:'assistant.delta',text:'last text'};
    throw new Error('model disconnected');
  }
  const events = coalesceAgentEvents(source());
  assert.equal((await events.next()).value?.type,'assistant.delta');
  await assert.rejects(events.next(),/model disconnected/);
});
