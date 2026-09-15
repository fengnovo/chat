import assert from 'node:assert/strict';
import test from 'node:test';

import { context, trace, SpanKind } from '@opentelemetry/api';
import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { RunJob } from '@repo/contracts';
import {
  injectObservabilityContext,
  loadObservabilityConfig,
  startObservability,
} from '@repo/observability';
import type { Job } from 'bullmq';

import { createWorkerObservability } from '../src/observability.js';
import { createRunProcessor } from '../src/processor.js';

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

test('consumer root span links the producer and records queue wait/completion metrics', async () => {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = await startObservability(
    loadObservabilityConfig(
      { OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' },
      { serviceName: 'worker-test', serviceVersion: 'test' },
    ),
    { spanExporter, metricExporter },
  );
  const observability = createWorkerObservability(runtime, { serviceVersion: 'test' });

  // 模拟 outbox.dispatch producer 注入的 traceparent。
  const producerSpan = runtime.tracer.startSpan('outbox.dispatch', {
    kind: SpanKind.PRODUCER,
  });
  const producerContext = producerSpan.spanContext();
  const carrier = injectObservabilityContext(
    trace.setSpan(context.active(), producerSpan),
    'req-xyz',
  );
  producerSpan.end();

  const services = {
    repository: {
      async markDispatchConsumed() {},
      async getRunForWorker() {
        return { status: 'completed' };
      },
    },
    redis: {
      async set() {
        return 'OK';
      },
      async eval() {
        return 1;
      },
    },
    controllers: new Map<string, unknown>(),
  } as never;

  const processor = createRunProcessor(services, observability);
  const bullJob = {
    id: '00000000-0000-4000-8000-000000000005',
    data: { ...job, observability: carrier },
    timestamp: 1_000,
    processedOn: 1_500,
  } as unknown as Job;

  await processor(bullJob);
  await runtime.forceFlush();

  const spans = spanExporter.getFinishedSpans();
  const consumer = spans.find((span) => span.name === 'worker.job.execute');
  assert.ok(consumer, 'consumer span must be exported');
  assert.equal(consumer!.kind, SpanKind.CONSUMER);
  assert.equal(consumer!.attributes['run_id'], job.runId);
  assert.equal(consumer!.attributes['job.kind'], 'start');
  assert.equal(consumer!.attributes['messaging.message.id'], bullJob.id);
  assert.equal(consumer!.attributes['queue.wait.ms'], 500);
  // Consumer 是独立 root trace，不是 producer 的子 span。
  assert.notEqual(consumer!.spanContext().traceId, producerContext.traceId);
  assert.equal(consumer!.parentSpanContext, undefined);
  // 但通过 link 精确关联到 outbox.dispatch producer。
  assert.equal(consumer!.links.length, 1);
  const link = consumer!.links[0]!;
  assert.equal(link.context.traceId, producerContext.traceId);
  assert.equal(link.context.spanId, producerContext.spanId);

  const exportedMetrics = metricExporter.getMetrics();
  const metricNames = exportedMetrics.flatMap((resource) =>
    resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)),
  );
  assert.ok(metricNames.includes('queue.wait.duration'));
  assert.ok(metricNames.includes('queue.jobs.completed'));
  assert.ok(!metricNames.includes('queue.jobs.started'), 'worker must not double-count enqueues');

  await runtime.shutdown();
});

test('consumer works without observability context on legacy jobs', async () => {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = await startObservability(
    loadObservabilityConfig(
      { OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' },
      { serviceName: 'worker-legacy-test', serviceVersion: 'test' },
    ),
    { spanExporter, metricExporter },
  );
  const observability = createWorkerObservability(runtime, { serviceVersion: 'test' });

  const services = {
    repository: {
      async markDispatchConsumed() {},
      async getRunForWorker() {
        return { status: 'completed' };
      },
    },
    redis: {
      async set() {
        return 'OK';
      },
      async eval() {
        return 1;
      },
    },
    controllers: new Map<string, unknown>(),
  } as never;

  const processor = createRunProcessor(services, observability);
  const bullJob = {
    id: 'legacy-id',
    data: job,
    timestamp: 2_000,
    processedOn: 2_100,
  } as unknown as Job;

  await assert.doesNotReject(processor(bullJob));
  await runtime.forceFlush();
  const consumer = spanExporter
    .getFinishedSpans()
    .find((span) => span.name === 'worker.job.execute');
  assert.ok(consumer);
  assert.equal(consumer!.links.length, 0);

  await runtime.shutdown();
});
