import { context, ROOT_CONTEXT, defaultTextMapGetter, defaultTextMapSetter, type Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export type ObservabilityContext = {
  traceparent?: string | undefined;
  tracestate?: string | undefined;
  requestId?: string | undefined;
};

const propagator = new W3CTraceContextPropagator();

/** 只有 W3C 跟踪字段可以跨越此边界；baggage 会有意排除。 */
export function injectObservabilityContext(parent: Context = context.active(), requestId?: string): ObservabilityContext {
  const carrier: ObservabilityContext = {};
  propagator.inject(parent, carrier, defaultTextMapSetter);
  if (requestId !== undefined) carrier.requestId = requestId;
  return carrier;
}

export function extractObservabilityContext(carrier: ObservabilityContext, parent: Context = ROOT_CONTEXT): Context {
  return propagator.extract(parent, carrier, defaultTextMapGetter);
}
