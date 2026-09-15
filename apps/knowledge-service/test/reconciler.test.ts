import test from 'node:test';
import assert from 'node:assert/strict';
import { SpanStatusCode } from '@opentelemetry/api';
import { reconcileQueuedJobs } from '../src/reconciler.js';
import { reconcileOnce } from '../src/index.js';

/** 记录 startSpan 调用与每条 span 的属性/状态，用于锁定 reconcileOnce 的遥测行为。 */
function fakeTelemetry() {
  const spans: Array<{
    name: string; startTime: number | undefined; attrs: Record<string, unknown>;
    status: { code: number } | undefined; exception: unknown; ended: boolean;
  }> = [];
  const operations: any[] = [];
  const telemetry = {
    tracer: {
      startSpan(name: string, options?: { startTime?: number }) {
        const span = {
          name, startTime: options?.startTime, attrs: {} as Record<string, unknown>,
          status: undefined as { code: number } | undefined, exception: undefined as unknown,
          ended: false,
          setStatus(s: { code: number }) { span.status = s; },
          setAttribute(k: string, v: unknown) { span.attrs[k] = v; },
          recordException(e: unknown) { span.exception = e; },
          end() { span.ended = true; },
        };
        spans.push(span);
        return span;
      },
    },
    metrics: { knowledgeOperation(m: any) { operations.push(m); } },
  };
  return { telemetry, spans, operations };
}
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

test('reconcileOnce empty scan records only a metric and emits no span', async () => {
  const { telemetry, spans, operations } = fakeTelemetry();
  const repo = { listQueuedOrStaleIndexJobs: async () => [] };
  const queue = { getJob: async () => ({ id: 'present' }), add: async () => {} };
  await reconcileOnce(repo as any, queue as any, telemetry as any);
  assert.equal(spans.length, 0, 'empty polling must not create a Langfuse trace');
  assert.equal(operations.length, 1);
  assert.deepEqual(
    { operation: operations[0].operation, outcome: operations[0].outcome },
    { operation: 'reconcile', outcome: 'success' },
  );
});

test('reconcileOnce emits one span covering the full attempt when jobs are requeued', async () => {
  const { telemetry, spans, operations } = fakeTelemetry();
  const added: Array<{ name: string; opts: { jobId: string } }> = [];
  const repo = { listQueuedOrStaleIndexJobs: async () => [{ id: 'j1', tenantId: 't' }] };
  const queue = {
    getJob: async () => null,
    add: async (name: string, _data: unknown, opts: { jobId: string }) => {
      added.push({ name, opts });
    },
  };
  const before = Date.now();
  await reconcileOnce(repo as any, queue as any, telemetry as any);
  assert.equal(spans.length, 1);
  const span = spans[0]!;
  assert.equal(span.name, 'knowledge.reconcile');
  assert.equal(typeof span.startTime, 'number');
  assert.ok(span.startTime! >= before - 1 && span.startTime! <= Date.now() + 1);
  assert.equal(span.attrs.requeued, 1);
  assert.equal(span.status, undefined);
  assert.equal(span.ended, true);
  assert.deepEqual(added.map((item) => item.opts.jobId), ['j1']);
  assert.equal(operations[0].outcome, 'success');
});

test('reconcileOnce failure emits an error span spanning the full attempt', async () => {
  const { telemetry, spans, operations } = fakeTelemetry();
  const error = new Error('database unavailable');
  const repo = { listQueuedOrStaleIndexJobs: async () => { throw error; } };
  const before = Date.now();
  await assert.rejects(
    () => reconcileOnce(repo as any, {} as any, telemetry as any),
    /database unavailable/,
  );
  assert.equal(spans.length, 1);
  const span = spans[0]!;
  assert.equal(span.name, 'knowledge.reconcile');
  assert.equal(typeof span.startTime, 'number');
  assert.ok(span.startTime! >= before - 1 && span.startTime! <= Date.now() + 1);
  assert.equal(span.status?.code, SpanStatusCode.ERROR);
  assert.equal(span.attrs['error.type'], 'Error');
  assert.equal(span.exception, error);
  assert.equal(span.ended, true);
  assert.equal(operations[0].outcome, 'failure');
});
