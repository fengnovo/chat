import test from 'node:test';
import assert from 'node:assert/strict';
import { startConsumer } from '../src/consumer.js';

test('consumer catches claim/index failure, records metric, and worker remains usable', async () => {
  let handler: any; let failures = 0; let logged = 0;
  class FakeWorker { on() { return this; } constructor(_q: string, fn: any) { handler = fn; } async close() {} }
  const worker: any = startConsumer('knowledge-index', {}, { WorkerClass:FakeWorker, repository:{ claimIndexJob: async () => { throw new Error('db down') } }, metrics:{ indexFailure:() => failures++ }, logger:{ error:() => logged++ } });
  await assert.rejects(() => handler({ id:'j', data:{ tenantId:'t' } }), /db down/);
  assert.equal(failures, 1); assert.equal(logged, 1); assert.ok(worker);
});
