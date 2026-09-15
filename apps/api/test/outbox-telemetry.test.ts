import assert from 'node:assert/strict';
import test from 'node:test';

import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { RunJob } from '@repo/contracts';
import type { AgentRepository, DispatchOutboxRecord } from '@repo/db';
import {
  createCoreMetrics,
  injectObservabilityContext,
  loadObservabilityConfig,
  startObservability,
  type ObservabilityRuntime,
} from '@repo/observability';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';

import { RunOutboxDispatcher } from '../src/outbox.js';

process.env.OBSERVABILITY_LOG_LEVEL = 'fatal';

const job: RunJob = {
  kind: 'start',
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  runId: '00000000-0000-4000-8000-000000000004',
  message: 'test',
  workspacePath: '/tmp/workspace',
  knowledgeBaseIds: [],
  attachments: [],
};

const logger = { error() {}, warn() {} } as unknown as FastifyBaseLogger;

function parseTraceParent(traceparent: string | undefined) {
  assert.ok(traceparent);
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    traceparent,
  );
  assert.ok(match, `invalid traceparent: ${traceparent}`);
  return { traceId: match![2], spanId: match![3] };
}

async function testRuntime(): Promise<{
  runtime: ObservabilityRuntime;
  spans: InMemorySpanExporter;
}> {
  const spans = new InMemorySpanExporter();
  const runtime = await startObservability(
    loadObservabilityConfig(
      { OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' },
      { serviceName: 'outbox-test', serviceVersion: 'test' },
    ),
    {
      spanExporter: spans,
      metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    },
  );
  return { runtime, spans };
}

test('dispatch creates a producer span and re-injects its context into the queued job', async () => {
  const { runtime, spans } = await testRuntime();
  try {
    // 模拟 API enqueue：producer span 注入到 Outbox payload。
    const enqueueSpan = runtime.tracer.startSpan('agent.run.enqueue', {
      kind: SpanKind.PRODUCER,
    });
    const enqueueCarrier = injectObservabilityContext(
      trace.setSpan(context.active(), enqueueSpan),
      'req-abc',
    );
    const enqueueIds = parseTraceParent(enqueueCarrier.traceparent);
    enqueueSpan.end();

    const dispatch: DispatchOutboxRecord = {
      id: '00000000-0000-4000-8000-000000000005',
      tenantId: job.tenantId,
      runId: job.runId,
      job: { ...job, observability: enqueueCarrier },
      attempts: 1,
    };

    let claimed = false;
    const repository = {
      async claimDispatches() {
        if (claimed) return [];
        claimed = true;
        return [dispatch];
      },
      async requeueStaleDispatches() {
        return 0;
      },
      async markDispatchPublished() {},
      async rescheduleDispatch() {
        assert.fail('dispatch should succeed');
      },
    } as unknown as AgentRepository;

    let queuedPayload: RunJob | undefined;
    const queue = {
      async add(_name: string, data: RunJob) {
        queuedPayload = data;
      },
    } as unknown as Queue;

    const dispatcher = new RunOutboxDispatcher({
      repository,
      queue,
      logger,
      telemetry: { tracer: runtime.tracer, metrics: createCoreMetrics(runtime.meter) },
      pollIntervalMs: 500,
      batchSize: 10,
      leaseMs: 30_000,
      reconcileIntervalMs: 5_000,
      staleAfterMs: 30_000,
    });

    await dispatcher.drainNow();
    await runtime.forceFlush();

    assert.ok(queuedPayload, 'job must be published');
    // dispatch 与 enqueue 同属一条 HTTP trace，但 span id 是新的 producer。
    const dispatchIds = parseTraceParent(queuedPayload!.observability?.traceparent);
    assert.equal(dispatchIds.traceId, enqueueIds.traceId);
    assert.notEqual(dispatchIds.spanId, enqueueIds.spanId);
    assert.equal(queuedPayload!.observability?.requestId, 'req-abc');

    const finished = spans.getFinishedSpans();
    const dispatchSpan = finished.find((span) => span.name === 'outbox.dispatch');
    assert.ok(dispatchSpan, 'outbox.dispatch span must be exported');
    assert.equal(dispatchSpan!.kind, SpanKind.PRODUCER);
    assert.equal(dispatchSpan!.spanContext().spanId, dispatchIds.spanId);
    assert.equal(dispatchSpan!.parentSpanContext?.spanId, enqueueIds.spanId);
    assert.equal(dispatchSpan!.attributes['messaging.system'], 'bullmq');
    assert.equal(dispatchSpan!.attributes['job.kind'], 'start');
    assert.equal(dispatchSpan!.attributes['messaging.message.id'], dispatch.id);
  } finally {
    await runtime.shutdown();
  }
});

test('dispatch failure marks the span errored and reschedules without throwing', async () => {
  const { runtime, spans } = await testRuntime();
  try {
    const dispatch: DispatchOutboxRecord = {
      id: '00000000-0000-4000-8000-000000000006',
      tenantId: job.tenantId,
      runId: job.runId,
      job,
      attempts: 1,
    };
    let claimed = false;
    const repository = {
      async claimDispatches() {
        if (claimed) return [];
        claimed = true;
        return [dispatch];
      },
      async requeueStaleDispatches() {
        return 0;
      },
      async markDispatchPublished() {
        assert.fail('failed dispatch must not be marked published');
      },
      async rescheduleDispatch() {},
    } as unknown as AgentRepository;
    const queue = {
      async add() {
        throw new Error('redis unavailable');
      },
    } as unknown as Queue;

    const dispatcher = new RunOutboxDispatcher({
      repository,
      queue,
      logger,
      telemetry: { tracer: runtime.tracer, metrics: createCoreMetrics(runtime.meter) },
      pollIntervalMs: 500,
      batchSize: 10,
      leaseMs: 30_000,
      reconcileIntervalMs: 5_000,
      staleAfterMs: 30_000,
    });

    await dispatcher.drainNow();
    await runtime.forceFlush();
    const span = spans
      .getFinishedSpans()
      .find((item) => item.name === 'outbox.dispatch');
    assert.ok(span);
    assert.equal(span!.status.code, SpanStatusCode.ERROR);
  } finally {
    await runtime.shutdown();
  }
});
