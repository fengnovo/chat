import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileQueuedJobs } from '../src/reconciler.js';
test('reconciler uses database job id and does not duplicate existing queue jobs', async () => {
  const now = new Date('2026-09-13T00:00:00Z'); const stale = new Date(now.getTime() - 1000);
  const state: any[] = [
    { id:'queued', tenantId:'tenant-a', status:'queued' }, { id:'stale', tenantId:'tenant-b', status:'running', leaseExpiresAt:stale },
    { id:'queued-2', tenantId:'tenant-d', status:'queued' }, { id:'stale-2', tenantId:'tenant-e', status:'running', leaseExpiresAt:stale },
    { id:'fresh', tenantId:'tenant-c', status:'running', leaseExpiresAt:new Date(now.getTime()+10000) },
    { id:'failed', tenantId:'tenant-f', status:'failed' }, { id:'completed', tenantId:'tenant-g', status:'completed' },
  ];
  const calls: any[] = []; const jobs = new Map<string, any>();
  const repo = { listQueuedOrStaleIndexJobs: async (at: Date, limit: number) => { calls.push([at, limit]); return state.filter((j) => j.status === 'queued' || (j.status === 'running' && j.leaseExpiresAt < at)).slice(0, limit); } };
  const queue = { getJob: async (id: string) => jobs.get(id), add: async (name: string, data: any, opts: any) => { const job = { name, data, id:opts.jobId }; jobs.set(opts.jobId, job); return job; } };
  assert.equal(await reconcileQueuedJobs(repo as any, queue as any, now, 2), 2);
  assert.equal(await reconcileQueuedJobs(repo as any, queue as any, now, 2), 0);
  assert.deepEqual(calls, [[now,2],[now,2]]); assert.deepEqual([...jobs.keys()].sort(), ['queued','stale']);
  assert.deepEqual([...jobs.values()].map((j) => j.data.tenantId).sort(), ['tenant-a','tenant-b']);
});
