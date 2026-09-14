import assert from 'node:assert/strict';
import test from 'node:test';
import type { Meter } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createCoreMetrics } from '../src/metrics.js';
import { normalizeRoute } from '../src/redaction.js';

test('creates the complete core instrument set', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  const metrics = createCoreMetrics(provider.getMeter('core-instruments'));

  metrics.httpServer({ method: 'GET', route: normalizeRoute('/health/live'), status: '2xx', outcome: 'success', durationMs: 5 });
  metrics.sseConnection({ operation: 'chat', outcome: 'success', delta: 1 });
  metrics.sseDisconnect({ operation: 'chat', reason: 'client' });
  metrics.queueJob({ queue: 'agent-runs', job: 'run', outcome: 'started' });
  metrics.queueJob({ queue: 'agent-runs', job: 'run', outcome: 'completed', durationMs: 10 });
  metrics.queueJob({ queue: 'agent-runs', job: 'run', outcome: 'failed', durationMs: 11 });
  metrics.modelCall({ provider: 'openai', model: 'gpt', operation: 'chat', outcome: 'success', durationMs: 12, inputTokens: 3, outputTokens: 4, retries: 1, fallbacks: 1 });
  metrics.toolCall({ tool: 'sandbox', operation: 'execute', outcome: 'success' });
  metrics.knowledgeRetrieval({ operation: 'retrieve', outcome: 'success', durationMs: 13 });
  metrics.telemetryExportFailure({ signal: 'metrics' });

  await provider.forceFlush();
  const names = exporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics.map(metric => metric.descriptor.name)));
  assert.deepEqual(new Set(names), new Set([
    'http.server.duration', 'http.server.requests', 'sse.connection.active', 'sse.disconnects.total',
    'queue.jobs.started', 'queue.jobs.completed', 'queue.jobs.failed', 'queue.job.duration',
    'model.calls.total', 'model.call.duration', 'model.tokens.input', 'model.tokens.output',
    'model.retries.total', 'model.fallbacks.total', 'tool.calls.total',
    'knowledge.retrieval.duration', 'telemetry.export.failures',
  ]));
  await provider.shutdown();
});

test('one hundred distinct IDs collapse to fixed low-cardinality HTTP series', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  const metrics = createCoreMetrics(provider.getMeter('cardinality'));

  for (let index = 0; index < 100; index++) {
    const id = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
    metrics.httpServer({
      method: 'GET',
      route: normalizeRoute(`/users/${id}?request_id=${id}`),
      status: '2xx',
      outcome: 'success',
      durationMs: index + 1,
    });
  }

  await provider.forceFlush();
  const exported = exporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
  const http = exported.filter(metric => metric.descriptor.name.startsWith('http.server.'));
  assert.equal(http.length, 2);
  for (const metric of http) {
    assert.equal(metric.dataPoints.length, 1, `${metric.descriptor.name} must have one fixed series`);
    assert.deepEqual(metric.dataPoints[0]?.attributes, {
      'http.request.method': 'GET',
      'http.route': '/users/:id',
      'http.response.status_class': '2xx',
      outcome: 'success',
    });
    assert.equal(JSON.stringify(metric.dataPoints).includes('00000000-0000'), false);
  }
  await provider.shutdown();
});

test('runtime-invalid label values collapse to other instead of creating arbitrary series', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  const metrics = createCoreMetrics(provider.getMeter('runtime-guard'));

  for (let index = 0; index < 100; index++) {
    metrics.queueJob({ queue: `queue-${index}`, job: `job-${index}`, outcome: 'started' } as never);
  }
  await provider.forceFlush();
  const started = exporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
    .find(metric => metric.descriptor.name === 'queue.jobs.started');
  assert.equal(started?.dataPoints.length, 1);
  assert.deepEqual(started?.dataPoints[0]?.attributes, { queue: 'other', 'job.kind': 'other' });
  await provider.shutdown();
});

test('runtime callers cannot bypass route normalization to create ID series', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  const metrics = createCoreMetrics(provider.getMeter('runtime-route-guard'));

  for (let index = 0; index < 100; index++) {
    metrics.httpServer({
      method: 'GET', route: `/users/user-${index}`, status: '2xx', outcome: 'success', durationMs: 1,
    } as never);
  }
  await provider.forceFlush();
  const httpRequests = exporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
    .find(metric => metric.descriptor.name === 'http.server.requests');
  assert.equal(httpRequests?.dataPoints.length, 1);
  assert.equal(httpRequests?.dataPoints[0]?.attributes['http.route'], '/users/:id');
  await provider.shutdown();
});

test('alphabetic request IDs collapse to a fixed request route series', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  const metrics = createCoreMetrics(provider.getMeter('request-route-cardinality'));

  for (let index = 0; index < 100; index++) {
    const suffix = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    metrics.httpServer({
      method: 'GET',
      route: normalizeRoute(`/requests/requesta-${suffix}`),
      status: '2xx',
      outcome: 'success',
      durationMs: 1,
    });
  }
  await provider.forceFlush();
  const httpRequests = exporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
    .find(metric => metric.descriptor.name === 'http.server.requests');
  assert.equal(httpRequests?.dataPoints.length, 1);
  assert.equal(httpRequests?.dataPoints[0]?.attributes['http.route'], '/requests/:id');
  assert.equal(JSON.stringify(httpRequests?.dataPoints).includes('requesta-'), false);
  await provider.shutdown();
});

test('throwing instruments cannot make any metric helper fail business execution', () => {
  const throwingInstrument = {
    add() { throw new Error('instrument add failed'); },
    record() { throw new Error('instrument record failed'); },
  };
  const meter = {
    createCounter: () => throwingInstrument,
    createHistogram: () => throwingInstrument,
    createUpDownCounter: () => throwingInstrument,
  } as unknown as Meter;
  const metrics = createCoreMetrics(meter);

  for (const invoke of [
    () => metrics.httpServer({ method: 'GET', route: normalizeRoute('/health/live'), status: '2xx', outcome: 'success', durationMs: 1 }),
    () => metrics.sseConnection({ operation: 'chat', outcome: 'success', delta: 1 }),
    () => metrics.sseDisconnect({ operation: 'chat', reason: 'client' }),
    () => metrics.queueJob({ queue: 'agent-runs', job: 'run', outcome: 'started' }),
    () => metrics.queueJob({ queue: 'agent-runs', job: 'run', outcome: 'completed', durationMs: 1 }),
    () => metrics.queueJob({ queue: 'agent-runs', job: 'run', outcome: 'failed', durationMs: 1 }),
    () => metrics.modelCall({ provider: 'openai', model: 'gpt', operation: 'chat', outcome: 'success', durationMs: 1, inputTokens: 1, outputTokens: 1, retries: 1, fallbacks: 1 }),
    () => metrics.toolCall({ tool: 'sandbox', operation: 'execute', outcome: 'success' }),
    () => metrics.knowledgeRetrieval({ operation: 'retrieve', outcome: 'success', durationMs: 1 }),
    () => metrics.telemetryExportFailure({ signal: 'metrics' }),
  ]) {
    assert.doesNotThrow(invoke);
  }
});
