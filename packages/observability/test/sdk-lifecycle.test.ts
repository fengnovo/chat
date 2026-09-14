import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { context, trace } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryMetricExporter, AggregationTemporality, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { loadObservabilityConfig } from '../src/config.js';
import { startObservability } from '../src/sdk.js';
import { extractObservabilityContext } from '../src/context.js';

const config = loadObservabilityConfig({ OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' }, { serviceName: 'test', serviceVersion: '1' });

test('disabled runtime remains no-op even while an enabled provider exists', async () => {
  const exporter = new InMemorySpanExporter();
  const active = await startObservability(config, { spanExporter: exporter, metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE) });
  try {
    const disabled = await startObservability({ ...config, enabled: false });
    const span = disabled.tracer.startSpan('ignored');
    assert.equal(span.isRecording(), false);
    span.end();
    disabled.meter.createCounter('ignored').add(1);
    await disabled.forceFlush();
    await disabled.shutdown();
    await active.forceFlush();
    assert.equal(exporter.getFinishedSpans().length, 0);
  } finally { await active.shutdown(); }
});

test('flush exports spans and metrics with async parent context; shutdown flushes once', async () => {
  const exporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = await startObservability(config, { spanExporter: exporter, metricExporter });
  try {
    await runtime.tracer.startActiveSpan('parent', async parent => {
      await Promise.resolve();
      assert.equal(trace.getSpan(context.active()), parent);
      runtime.tracer.startSpan('child').end();
      parent.end();
    });
    runtime.meter.createCounter('requests').add(3);
    await runtime.forceFlush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.equal(spans[0]?.parentSpanContext?.spanId, spans[1]?.spanContext().spanId);
    assert.equal(metricExporter.getMetrics()[0]?.scopeMetrics[0]?.metrics[0]?.dataPoints[0]?.value, 3);
    // Capture the export before the real in-memory exporter's shutdown clears it.
    let shutdownSpans: string[] = [];
    const originalShutdown = exporter.shutdown.bind(exporter);
    exporter.shutdown = async () => { shutdownSpans = exporter.getFinishedSpans().map(span => span.name); await originalShutdown(); };
    runtime.tracer.startSpan('last').end();
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    assert.deepEqual(shutdownSpans, ['child', 'parent', 'last']);
    await runtime.forceFlush();
  } finally { await runtime.shutdown(); }
});

test('failing and hanging exporters cannot reject or exceed the shutdown deadline', async t => {
  for (const hangs of [false, true]) {
    const warnings: unknown[][] = [];
    const warning = t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const exporter: SpanExporter = {
      export() { if (!hangs) throw new Error('Authorization=secret-token'); },
      shutdown() { return hangs ? new Promise<void>(() => {}) : Promise.reject(new Error('secret-token')); },
    };
    const runtime = await startObservability(config, { spanExporter: exporter, metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE) });
    runtime.tracer.startSpan('failure').end();
    const before = performance.now();
    await assert.doesNotReject(runtime.shutdown(25));
    assert.ok(performance.now() - before < 500);
    await runtime.shutdown();
    assert.equal(warnings.length, 1);
    assert.ok(!JSON.stringify(warnings).includes('secret-token'));
    warning.mock.restore();
  }
});

test('remote parent sampling is respected independently of root sample ratio', async () => {
  const exporter = new InMemorySpanExporter();
  const runtime = await startObservability({ ...config, tracesSampleRatio: 0 }, { spanExporter: exporter, metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE) });
  try {
    runtime.tracer.startSpan('unsampled-root').end();
    const sampledParent = extractObservabilityContext({ traceparent: '00-12345678901234567890123456789012-1234567890123456-01' });
    runtime.tracer.startSpan('sampled-child', {}, sampledParent).end();
    const unsampledParent = extractObservabilityContext({ traceparent: '00-12345678901234567890123456789012-1234567890123456-00' });
    runtime.tracer.startSpan('unsampled-child', {}, unsampledParent).end();
    await runtime.forceFlush();
    assert.deepEqual(exporter.getFinishedSpans().map(span => span.name), ['sampled-child']);
  } finally { await runtime.shutdown(); }
});

test('metric exporter throws, callback failures, and hangs stay bounded and sanitized', async t => {
  for (const failure of ['throw', 'callback', 'hang']) {
    const warnings: unknown[][] = [];
    const warning = t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const metricExporter: PushMetricExporter = {
      export(_metrics, callback) {
        if (failure === 'throw') throw new Error('Bearer secret');
        if (failure === 'callback') callback({ code: ExportResultCode.FAILED, error: new Error('Bearer secret') });
      },
      forceFlush() { return failure === 'hang' ? new Promise<void>(() => {}) : Promise.reject(new Error('Bearer secret')); },
      shutdown() { return Promise.reject(new Error('Bearer secret')); },
    };
    const runtime = await startObservability({ ...config, shutdownTimeoutMs: 30 }, { spanExporter: new InMemorySpanExporter(), metricExporter });
    runtime.meter.createCounter('requests').add(1);
    const before = performance.now();
    await assert.doesNotReject(runtime.forceFlush(40));
    await assert.doesNotReject(runtime.shutdown(40));
    assert.ok(performance.now() - before < 500);
    assert.equal(warnings.length, 1);
    assert.ok(!JSON.stringify(warnings).includes('secret'));
    warning.mock.restore();
  }
});

for (const operation of ['forceFlush', 'shutdown'] as const) {
  for (const explicitBudget of [undefined, 60000]) {
    test(`${operation} caps ${explicitBudget === undefined ? 'direct config' : 'caller'} deadlines at five seconds`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      let elapsed = 0;
      t.mock.method(performance, 'now', () => elapsed);
      t.mock.method(console, 'warn', () => {});
      // Isolate the outer lifecycle budget from the independent 1s exporter timeout.
      // A stalled provider can otherwise be hidden by the bounded exporter adapter.
      t.mock.method(BasicTracerProvider.prototype, 'forceFlush', () => new Promise<void>(() => {}));
      const runtime = await startObservability({ ...config, shutdownTimeoutMs: 60000 }, {
        spanExporter: { export() {}, shutdown: () => new Promise<void>(() => {}) },
        metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      });
      let completed = false;
      const pending = runtime[operation](explicitBudget).then(() => { completed = true; });
      await setImmediate();
      elapsed = 4999;
      t.mock.timers.tick(4999);
      await setImmediate();
      assert.equal(completed, false, 'a stalled lifecycle remains pending before its deadline');
      elapsed = 5000;
      t.mock.timers.tick(1);
      await setImmediate();
      try {
        assert.equal(completed, true, 'the public lifecycle must settle by 5000ms');
        await pending;
      } finally {
        // Complete cleanup under the virtual clock, including on regression failure.
        const cleanup = runtime.shutdown(1);
        for (let step = 0; step < 3; step++) {
          elapsed += 60000;
          t.mock.timers.tick(60000);
          await setImmediate();
        }
        await cleanup;
      }
    });
  }
}
