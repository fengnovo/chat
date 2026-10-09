import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createSseWriter } from '../src/sse-writer.js';

test('closing a paused stream releases its pending write and drain listeners', async () => {
  const raw = Object.assign(new EventEmitter(), { writableLength: 0, write: () => false });
  const writer = createSseWriter(raw as never);
  const writing = writer.write('data: x\n\n');
  assert.equal(raw.listenerCount('drain'), 1);
  writer.close();
  assert.equal(await writing, false);
  assert.equal(raw.listenerCount('drain'), 0);
  assert.equal(raw.listenerCount('close'), 0);
  assert.equal(raw.listenerCount('error'), 0);
});
test('a client that never drains times out and releases its listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const raw = Object.assign(new EventEmitter(), { writableLength: 0, write: () => false });
  const writer = createSseWriter(raw as never, { drainTimeoutMs: 100 });
  const writing = writer.write('data: x\n\n');
  const rejected = assert.rejects(writing, /sse_drain_timeout/);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(raw.listenerCount('drain'), 0);
  assert.equal(raw.listenerCount('close'), 0);
  assert.equal(writer.busy, false);
});
test('frame and outstanding socket bytes share a bounded budget', async () => {
  let writes = 0;
  const raw = Object.assign(new EventEmitter(), { writableLength: 7, write: () => { writes++; return true; } });
  const writer = createSseWriter(raw as never, { maxBufferedBytes: 10 });
  await assert.rejects(writer.write('1234'), /sse_buffer_limit/);
  assert.equal(writes, 0);
});
