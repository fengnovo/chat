import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'node:http';

import { SpanStatusCode, trace, type Context, type Meter, type Span, type Tracer } from '@opentelemetry/api';
import Fastify from 'fastify';
import { loadObservabilityConfig, startObservability } from '@repo/observability';

import {
  apiFastifyOptions,
  createApiObservability,
  registerApiObservabilityHooks,
} from '../src/observability.js';
import { loadConfig } from '../src/config.js';
import { streamAgentEvents } from '../src/sse.js';
import { streamWorkflowRun } from '../src/chat-stream.js';

type Measurement = { name: string; value: number; attributes?: Record<string, unknown> | undefined };

function recordingRuntime(options: { throwOnSpanStart?: boolean; throwOnMeasure?: boolean } = {}) {
  const measurements: Measurement[] = [];
  const parents: Array<string | undefined> = [];
  const spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    status?: { code: SpanStatusCode; message?: string };
    ended: boolean;
  }> = [];
  const instrument = (name: string) => ({
    add(value: number, attributes?: Record<string, unknown>) {
      if (options.throwOnMeasure) throw new Error('collector unavailable: token=secret');
      measurements.push({ name, value, attributes });
    },
    record(value: number, attributes?: Record<string, unknown>) {
      if (options.throwOnMeasure) throw new Error('collector unavailable: token=secret');
      measurements.push({ name, value, attributes });
    },
  });
  const meter = {
    createCounter: (name: string) => instrument(name),
    createUpDownCounter: (name: string) => instrument(name),
    createHistogram: (name: string) => instrument(name),
  } as unknown as Meter;
  const tracer = {
    startSpan(name: string, _options: unknown, parent?: Context) {
      parents.push(parent ? trace.getSpanContext(parent)?.traceId : undefined);
      if (options.throwOnSpanStart) throw new Error('exporter unavailable');
      const recorded = { name, attributes: {}, ended: false } as (typeof spans)[number];
      spans.push(recorded);
      return {
        spanContext: () => ({
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          traceFlags: 1,
        }),
        setAttribute(key: string, value: unknown) {
          recorded.attributes[key] = value;
          return this;
        },
        setAttributes(attributes: Record<string, unknown>) {
          Object.assign(recorded.attributes, attributes);
          return this;
        },
        addEvent() { return this; },
        addLink() { return this; },
        addLinks() { return this; },
        setStatus(status: { code: SpanStatusCode; message?: string }) {
          recorded.status = status;
          return this;
        },
        updateName(next: string) {
          recorded.name = next;
          return this;
        },
        end() { recorded.ended = true; },
        isRecording: () => true,
        recordException() {},
      } as unknown as Span;
    },
  } as unknown as Tracer;
  return {
    runtime: { tracer, meter, async shutdown() {}, async forceFlush() {} },
    measurements,
    spans,
    parents,
  };
}

test('request context returns a constrained ID and records the route template', async () => {
  const recording = recordingRuntime();
  const config = loadConfig({ NODE_ENV: 'test' });
  const observability = createApiObservability(recording.runtime, {
    enabled: true,
    serviceVersion: '1.2.3',
    exporter: 'configured',
  });
  const app = Fastify({ ...apiFastifyOptions(config), logger: { level: 'silent' } });
  registerApiObservabilityHooks(app, observability);
  app.get('/things/:thingId', async (request) => ({ bindings: (request.log as typeof request.log & { bindings(): unknown }).bindings() }));

  const response = await app.inject({
    method: 'GET',
    url: '/things/123e4567-e89b-42d3-a456-426614174000?token=not-a-label',
    headers: {
      'x-request-id': 'edge-request-42',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-request-id'], 'edge-request-42');
  assert.equal(response.json().bindings.request_id, 'edge-request-42');
  assert.equal(
    response.json().bindings.trace_id,
    '0123456789abcdef0123456789abcdef',
  );
  assert.equal(response.json().bindings.span_id, '0123456789abcdef');
  assert.equal(response.json().bindings.client_ip, '127.0.0.1');
  assert.equal(recording.spans.length, 1);
  assert.equal(recording.parents[0], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(recording.spans[0]?.name, 'GET /things/:thingId');
  assert.equal(recording.spans[0]?.ended, true);
  const duration = recording.measurements.find(
    (measurement) => measurement.name === 'http.server.duration',
  );
  assert.equal(duration?.attributes?.['http.route'], '/things/:thingId');
  assert.equal(JSON.stringify(recording.measurements).includes('123e4567'), false);
  assert.equal(JSON.stringify(recording.measurements).includes('not-a-label'), false);
  await app.close();
});

test('untrusted or malformed request IDs are replaced', async () => {
  const recording = recordingRuntime();
  const config = loadConfig({ NODE_ENV: 'test' });
  const app = Fastify({ ...apiFastifyOptions(config), logger: false });
  registerApiObservabilityHooks(
    app,
    createApiObservability(recording.runtime, {
      enabled: false,
      serviceVersion: '1.2.3',
      exporter: 'disabled',
    }),
  );
  app.get('/request-id', async (request) => ({ requestId: request.id }));

  for (const requestId of [`unsafe\nvalue`, 'x'.repeat(129), 'contains spaces']) {
    const response = await app.inject({
      method: 'GET',
      url: '/request-id',
      headers: { 'x-request-id': requestId },
    });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.headers['x-request-id'], requestId);
    assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  }
  await app.close();
});

test('telemetry failures never change the HTTP business response', async () => {
  const recording = recordingRuntime({ throwOnSpanStart: true, throwOnMeasure: true });
  const config = loadConfig({ NODE_ENV: 'test' });
  const app = Fastify({ ...apiFastifyOptions(config), logger: false });
  registerApiObservabilityHooks(
    app,
    createApiObservability(recording.runtime, {
      enabled: true,
      serviceVersion: '1.2.3',
      exporter: 'configured',
    }),
  );
  app.get('/business-result', async () => ({ value: 42 }));

  const response = await app.inject({ method: 'GET', url: '/business-result' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { value: 42 });
  await app.close();
});

test('SSE client disconnect releases the active gauge exactly once', () => {
  const recording = recordingRuntime();
  const observability = createApiObservability(recording.runtime, {
    enabled: true,
    serviceVersion: '1.2.3',
    exporter: 'configured',
  });

  const connection = observability.startSse('chat');
  connection.firstByte();
  connection.finish('client');
  connection.finish('server');

  const active = recording.measurements.filter(
    (measurement) => measurement.name === 'sse.connection.active',
  );
  assert.deepEqual(active.map((measurement) => measurement.value), [1, -1]);
  assert.deepEqual(active[0]?.attributes, active[1]?.attributes);
  assert.equal(
    recording.measurements.filter(
      (measurement) => measurement.name === 'sse.first_byte.duration',
    ).length,
    1,
  );
  assert.equal(
    recording.measurements.filter(
      (measurement) => measurement.name === 'sse.disconnects.total',
    )[0]?.attributes?.reason,
    'client',
  );
});

test('forged internal telemetry headers are removed and status events are counted', async () => {
  const recording = recordingRuntime();
  const app = Fastify({ ...apiFastifyOptions(loadConfig({ NODE_ENV: 'test' })), logger: false });
  registerApiObservabilityHooks(app, createApiObservability(recording.runtime, {
    enabled: true, serviceVersion: '1', exporter: 'configured',
  }));
  app.get('/headers', async (request) => request.headers);
  for (const code of [401, 403, 429, 500]) app.get(`/status/${code}`, async (_request, reply) => reply.code(code).send({ ok: false }));
  const response = await app.inject({ url: '/headers', headers: {
    'x-internal-telemetry': 'forged', 'x-observability-context': 'forged',
    'x-trace-id': 'forged', 'x-span-id': 'forged', baggage: 'user=secret',
  } });
  assert.equal(response.body.includes('forged'), false);
  assert.equal(response.body.includes('user=secret'), false);
  for (const code of [401, 403, 429, 500]) await app.inject(`/status/${code}`);
  assert.deepEqual(recording.measurements.filter(item => item.name === 'http.server.events').map(item => item.attributes?.event), [
    'auth.failure', 'auth.failure', 'rate_limit.rejected', 'http.error',
  ]);
  await app.close();
});

test('W3C context survives asynchronous handlers and a failed SDK exporter stays fail-open', async () => {
  const exported: Array<{ name: string; parent?: string; spanId: string }> = [];
  const runtime = await startObservability(loadObservabilityConfig({ OTEL_ENABLED: 'true', OTEL_TRACES_SAMPLER_ARG: '1' }, {
    serviceName: 'api-test', serviceVersion: '1',
  }), {
    spanExporter: {
      export(spans, done) {
        exported.push(...spans.map(span => ({ name: span.name, ...(span.parentSpanContext ? { parent: span.parentSpanContext.spanId } : {}), spanId: span.spanContext().spanId })));
        done({ code: 1, error: new Error('exporter unavailable') });
      },
      async shutdown() {},
    },
    metricExporter: { export(_metrics, done) { done({ code: 0 }); }, async forceFlush() {}, async shutdown() {} },
  });
  const app = Fastify({ ...apiFastifyOptions(loadConfig({ NODE_ENV: 'test' })), logger: false });
  try {
    registerApiObservabilityHooks(app, createApiObservability(runtime, { enabled: true, serviceVersion: '1', exporter: 'configured' }));
    app.get('/business', async () => {
      await Promise.resolve();
      runtime.tracer.startSpan('business child').end();
      return { value: 42 };
    });
    const response = await app.inject({ url: '/business', headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { value: 42 });
    await runtime.forceFlush();
    const http = exported.find(span => span.name === 'GET /business');
    assert.equal(http?.parent, 'bbbbbbbbbbbbbbbb');
    assert.equal(exported.find(span => span.name === 'business child')?.parent, http?.spanId);
  } finally {
    await app.close();
    await runtime.shutdown();
  }
});

for (const [operation, stream] of [['events', streamAgentEvents], ['chat', streamWorkflowRun]] as const) {
  for (const reason of ['client', 'server', 'error'] as const) {
    test(`${operation} SSE ${reason} termination cleans up the real HTTP connection`, { timeout: 5000 }, async (t) => {
      const recording = recordingRuntime();
      const app = Fastify({ ...apiFastifyOptions(loadConfig({ NODE_ENV: 'test' })), logger: false });
      t.after(() => app.close());
      const observability = createApiObservability(recording.runtime, { enabled: true, serviceVersion: '1', exporter: 'configured' });
      registerApiObservabilityHooks(app, observability);
      let unsubscribeCount = 0;
      let listCalls = 0;
      const services = {
        observability,
        repository: {
          getRun: async () => ({ status: reason === 'server' ? 'completed' : 'running' }),
          listEvents: async () => {
            listCalls++;
            if (reason === 'error' && (operation === 'events' || listCalls > 1)) throw new Error('secret database failure');
            return reason === 'server' ? [{ type: 'run.completed', runId: 'test-run', seq: 1 }] : [];
          },
        },
        streamSubscriptions: { subscribe: async () => () => { unsubscribeCount++; } },
      };
      app.get('/stream', async (request, reply) => stream(request, reply, services as never, 'test-run'));
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => {
        const req = get(`${address}/stream`, { headers: { 'x-request-id': 'sse-request' } }, (res) => {
          assert.equal(res.headers['x-request-id'], 'sse-request');
          if (reason === 'client') {
            res.destroy();
            resolve();
          } else {
            res.resume();
            res.once('end', resolve);
          }
        });
        req.once('error', reject);
      });
      // Server socket cleanup arrives after the client's close callback.
      for (let attempt = 0; attempt < 50 && unsubscribeCount === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(unsubscribeCount, 1);
      const active = recording.measurements.filter(item => item.name === 'sse.connection.active');
      assert.deepEqual(active.map(item => item.value), [1, -1]);
      assert.deepEqual(active[0]?.attributes, active[1]?.attributes);
      assert.equal(recording.measurements.find(item => item.name === 'sse.disconnects.total')?.attributes?.reason, reason);
      assert.equal(recording.spans.find(item => item.name === `sse ${operation}`)?.ended, true);
      const firstDataMeasurements = recording.measurements.filter(
        item => item.name === 'sse.first_byte.duration',
      );
      assert.equal(
        firstDataMeasurements.length,
        reason === 'server' ? 1 : 0,
        'SSE first-byte timing must start at the first event frame, not headers',
      );
      assert.equal(JSON.stringify(recording.measurements).includes('secret'), false);
    });
  }
}
