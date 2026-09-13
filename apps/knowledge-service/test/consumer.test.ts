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
test('consumer fails claimed job then remains usable for a succeeding job', async () => {
  let handler: any; let attempt = 0; let failed: any; let metrics = 0; let logs = 0;
  class FakeWorker { on() { return this; } constructor(_q: string, fn: any) { handler = fn; } async close() {} }
  const worker: any = startConsumer('knowledge-index', {}, { WorkerClass:FakeWorker, repository:{ claimIndexJob: async () => ({ leaseToken:'lease' }), failIndexJob: async (...args: any[]) => { failed = args; } }, pipeline:{ run: async () => { attempt++; if (attempt === 1) throw new Error('index failed'); } }, metrics:{ indexFailure:() => metrics++ }, logger:{ error:() => logs++ } });
  await assert.rejects(() => handler({ id:'j', data:{ tenantId:'t' } }), /index failed/);
  await handler({ id:'j2', data:{ tenantId:'t' } });
  assert.equal(failed[0], 't'); assert.equal(failed[2], 'lease'); assert.equal(metrics, 1); assert.equal(logs, 1); assert.ok(worker);
});
