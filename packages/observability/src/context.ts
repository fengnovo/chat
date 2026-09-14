import { context, ROOT_CONTEXT, defaultTextMapGetter, defaultTextMapSetter, type Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export type ObservabilityContext = { traceparent?: string; tracestate?: string; requestId?: string };

const propagator = new W3CTraceContextPropagator();

/** Only W3C tracing fields cross this boundary; baggage is intentionally excluded. */
export function injectObservabilityContext(parent: Context = context.active(), requestId?: string): ObservabilityContext {
  const carrier: ObservabilityContext = {};
  propagator.inject(parent, carrier, defaultTextMapSetter);
  if (requestId !== undefined) carrier.requestId = requestId;
  return carrier;
}

export function extractObservabilityContext(carrier: ObservabilityContext, parent: Context = ROOT_CONTEXT): Context {
  return propagator.extract(parent, carrier, defaultTextMapGetter);
}
