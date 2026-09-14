import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  SpanStatusCode,
  SpanKind,
  context,
  trace,
  type Span,
} from '@opentelemetry/api';
import {
  createCoreMetrics,
  extractObservabilityContext,
  normalizeRoute,
  type CoreMetrics,
  type ObservabilityRuntime,
} from '@repo/observability';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ApiConfig } from './config.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type ExporterSummary = 'configured' | 'disabled';
type SseOperation = 'chat' | 'events' | 'other';
type SseFinishReason = 'client' | 'server' | 'error' | 'timeout' | 'other';

type RequestTelemetry = {
  startedAt: number;
  span?: Span;
};
const requests = new WeakMap<FastifyRequest, RequestTelemetry>();

export type ApiObservability = {
  runtime: ObservabilityRuntime;
  metrics: CoreMetrics;
  health: { enabled: boolean; exporter: ExporterSummary };
  markRequest(request: FastifyRequest, event: 'auth.failure' | 'rate_limit.rejected' | 'http.error'): void;
  startSse(operation: SseOperation): {
    firstByte(): void;
    finish(reason: SseFinishReason): void;
  };
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveRequestId(value: string | string[] | undefined): string {
  const candidate = headerValue(value);
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export function apiFastifyOptions(config: Pick<ApiConfig, 'TRUST_PROXY_CIDRS'>) {
  return {
    trustProxy: config.TRUST_PROXY_CIDRS,
    genReqId(request: IncomingMessage) {
      return resolveRequestId(request.headers['x-request-id']);
    },
  } as const;
}

function safely(operation: () => void): void {
  try {
    operation();
  } catch {
    // Observability is intentionally fail-open for every business request.
  }
}

export function createApiObservability(
  runtime: ObservabilityRuntime,
  options: { enabled: boolean; serviceVersion: string; exporter: ExporterSummary },
): ApiObservability {
  const metrics = createCoreMetrics(runtime.meter);
  const firstByteDuration = runtime.meter.createHistogram('sse.first_byte.duration', {
    unit: 'ms',
  });
  const requestEvents = runtime.meter.createCounter('http.server.events');
  return {
    runtime,
    metrics,
    health: { enabled: options.enabled, exporter: options.exporter },
    markRequest(request, event) {
      safely(() => requests.get(request)?.span?.addEvent(event));
      safely(() => requestEvents.add(1, { event, 'http.route': normalizeRoute(request.url, request.routeOptions.url) }));
    },
    startSse(operation) {
      const startedAt = performance.now();
      let finished = false;
      let firstByteRecorded = false;
      let span: Span | undefined;
      safely(() => {
        span = runtime.tracer.startSpan(`sse ${operation}`);
        span.setAttribute('sse.operation', operation);
      });
      safely(() => metrics.sseConnection({ operation, outcome: 'success', delta: 1 }));
      return {
        firstByte() {
          if (firstByteRecorded) return;
          firstByteRecorded = true;
          safely(() => firstByteDuration.record(performance.now() - startedAt, { operation }));
          safely(() => span?.addEvent('sse.first_byte'));
        },
        finish(reason) {
          if (finished) return;
          finished = true;
          const outcome = reason === 'server' ? 'success' : reason === 'client' ? 'cancelled' : 'failure';
          // Active series must use identical labels on increment and decrement.
          safely(() => metrics.sseConnection({ operation, outcome: 'success', delta: -1 }));
          safely(() => metrics.sseDisconnect({ operation, reason }));
          safely(() => {
            span?.setAttribute('sse.disconnect_reason', reason);
            span?.setStatus({ code: outcome === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK });
            span?.end();
          });
        },
      };
    },
  };
}

export function registerApiObservabilityHooks(
  app: FastifyInstance,
  observability: ApiObservability,
): void {
  app.addHook('onRequest', (request, reply, done) => {
    for (const name of Object.keys(request.headers)) {
      if (/^x-(?:internal-|telemetry-|observability-)/.test(name) || ['baggage', 'x-trace-id', 'x-span-id'].includes(name)) {
        delete request.headers[name];
      }
    }
    const startedAt = performance.now();
    let parent = context.active();
    safely(() => {
      const traceparent = headerValue(request.headers.traceparent);
      const tracestate = headerValue(request.headers.tracestate);
      parent = extractObservabilityContext({
        ...(traceparent ? { traceparent } : {}),
        ...(tracestate ? { tracestate } : {}),
        requestId: request.id,
      });
    });
    let span: Span | undefined;
    safely(() => {
      span = observability.runtime.tracer.startSpan(
        `${request.method} request`,
        { kind: SpanKind.SERVER, attributes: { 'http.request.method': request.method, request_id: request.id } },
        parent,
      );
    });
    const spanContext = span?.spanContext();
    request.log = request.log.child({
      request_id: request.id,
      ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
      ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
      client_ip: request.ip,
    });
    reply.header('x-request-id', request.id);
    requests.set(request, { startedAt, ...(span ? { span } : {}) });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        safely(() => span?.setAttribute('http.request.cancelled', true));
        safely(() => span?.end());
      }
    });
    const active = span ? trace.setSpan(parent, span) : parent;
    context.with(active, done);
  });

  app.addHook('onError', (request, _reply, _error, done) => {
    const span = requests.get(request)?.span;
    safely(() => {
      span?.addEvent('http.error');
      span?.setStatus({ code: SpanStatusCode.ERROR });
    });
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const state = requests.get(request);
    const route = normalizeRoute(request.url, request.routeOptions.url);
    const statusClass =
      reply.statusCode >= 100 && reply.statusCode < 600
        ? `${Math.floor(reply.statusCode / 100)}xx` as '1xx' | '2xx' | '3xx' | '4xx' | '5xx'
        : 'other';
    const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)
      ? request.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
      : 'OTHER';
    const outcome = reply.statusCode >= 500 ? 'failure' : 'success';
    if (reply.statusCode === 401 || reply.statusCode === 403) observability.markRequest(request, 'auth.failure');
    if (reply.statusCode === 429) observability.markRequest(request, 'rate_limit.rejected');
    if (reply.statusCode >= 500) observability.markRequest(request, 'http.error');
    request.log.info({ route, method, status_code: reply.statusCode }, 'request completed');
    safely(() => observability.metrics.httpServer({
      method,
      route,
      status: statusClass,
      outcome,
      durationMs: performance.now() - (state?.startedAt ?? performance.now()),
    }));
    safely(() => {
      state?.span?.updateName(`${method} ${route}`);
      state?.span?.setAttributes({
        'http.route': route,
        'http.response.status_code': reply.statusCode,
      });
      state?.span?.setStatus({
        code: outcome === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      state?.span?.end();
    });
    done();
  });
}
