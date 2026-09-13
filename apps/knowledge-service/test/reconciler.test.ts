import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileQueuedJobs } from '../src/reconciler.js';
test('reconciler uses database job id and does not duplicate existing queue jobs', async () => {
  const adds: any[] = [];
  const queue = { add: async (...args: any[]) => { adds.push(args); } };
  const repo = { listQueuedOrStaleIndexJobs: async () => [{ id:'job-1', tenantId:'t' }, { id:'job-2', tenantId:'t' }] };
  const result = await reconcileQueuedJobs(repo as any, queue as any, new Date(), 10);
  assert.equal(result, 2);
  assert.deepEqual(adds.map((x) => x[2].jobId), ['job-1','job-2']);
});
