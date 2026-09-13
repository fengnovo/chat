import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileQueuedJobs } from '../src/reconciler.js';
test('reconciler uses database job id and does not duplicate existing queue jobs', async () => {
  const now = new Date('2026-09-13T00:00:00Z'); const stale = new Date(now.getTime() - 1000);
  const selected: any[] = [{ id:'queued', tenantId:'tenant-a', status:'queued' }, { id:'stale', tenantId:'tenant-b', status:'running', leaseExpiresAt:stale }];
  const calls: any[] = []; const jobs = new Map<string, any>();
  const repo = { listQueuedOrStaleIndexJobs: async (at: Date, limit: number) => { calls.push([at, limit]); return selected; } };
  const queue = { getJob: async (id: string) => jobs.get(id), add: async (name: string, data: any, opts: any) => { const job = { name, data, id:opts.jobId }; jobs.set(opts.jobId, job); return job; } };
  assert.equal(await reconcileQueuedJobs(repo as any, queue as any, now, 10), 2);
  assert.equal(await reconcileQueuedJobs(repo as any, queue as any, now, 10), 0);
  assert.deepEqual(calls, [[now,10],[now,10]]); assert.deepEqual([...jobs.keys()].sort(), ['queued','stale']);
  assert.deepEqual([...jobs.values()].map((j) => j.data.tenantId).sort(), ['tenant-a','tenant-b']);
});
