import { context, trace } from '@opentelemetry/api';
import { redactTelemetryValue } from './redaction.js';
import type { ObservabilityRuntime } from './sdk.js';

export type ObservabilityLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type ObservabilityLoggerOptions = {
  service: string;
  environment: string;
  level?: ObservabilityLogLevel;
  destination?: { write(chunk: string): unknown };
  now?: () => Date;
};

export type ObservabilityLogBindings = Record<string, unknown>;

export type ObservabilityLogMethod = {
  (message: string): void;
  (bindings: ObservabilityLogBindings | Error, message?: string): void;
};

/** Structural subset used by Fastify/Pino integrations without a Pino runtime dependency. */
export type ObservabilityLogger = {
  level: ObservabilityLogLevel;
  trace: ObservabilityLogMethod;
  debug: ObservabilityLogMethod;
  info: ObservabilityLogMethod;
  warn: ObservabilityLogMethod;
  error: ObservabilityLogMethod;
  fatal: ObservabilityLogMethod;
  child(bindings: ObservabilityLogBindings): ObservabilityLogger;
  bindings(): ObservabilityLogBindings;
  isLevelEnabled(level: ObservabilityLogLevel): boolean;
};

const LEVELS: readonly ObservabilityLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const OPTIONAL_FIELDS = [
  'request_id', 'trace_id', 'span_id', 'run_id', 'job_id', 'operation', 'event',
  'outcome', 'component', 'duration_ms', 'status_code',
] as const;
const BINDING_FIELDS = [...OPTIONAL_FIELDS, 'error', 'err'] as const;

function safeString(value: unknown, maximum = 128): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const output = String(value);
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) return undefined;
  return output;
}

function stableError(error: unknown): { type: string; code?: string } | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const type = safeString(ownValue(error, 'type') ?? ownValue(error, 'name') ?? (error instanceof Error ? 'Error' : undefined));
  if (!type || !/^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/.test(type)) return undefined;
  const code = safeString(ownValue(error, 'code'));
  return { type, ...(code && /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? { code } : {}) };
}

function ownValue(object: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function asBindings(value: unknown): ObservabilityLogBindings {
  if (value instanceof Error) return { error: value };
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObservabilityLogBindings
    : {};
}

function selectBindings(...sources: ObservabilityLogBindings[]): ObservabilityLogBindings {
  const selected: ObservabilityLogBindings = {};
  for (const source of sources) {
    for (const field of BINDING_FIELDS) {
      const value = ownValue(source, field);
      if (value !== undefined) selected[field] = value;
    }
  }
  return selected;
}

export function createObservabilityLogger(
  runtime: ObservabilityRuntime,
  options: ObservabilityLoggerOptions,
): ObservabilityLogger {
  const threshold = LEVELS.indexOf(options.level ?? 'info');
  const destination = options.destination ?? process.stdout;
  const now = options.now ?? (() => new Date());

  const makeLogger = (parentBindings: ObservabilityLogBindings): ObservabilityLogger => {
    const write = (level: ObservabilityLogLevel, first: unknown, second?: string): void => {
      if (LEVELS.indexOf(level) < threshold) return;
      const supplied = typeof first === 'string' ? {} : asBindings(first);
      const bindings = selectBindings(parentBindings, supplied);
      const active = trace.getSpan(context.active())?.spanContext();
      const record: Record<string, unknown> = {
        timestamp: now().toISOString(),
        level,
        service: options.service,
        environment: options.environment,
      };
      for (const field of OPTIONAL_FIELDS) {
        const correlated = field === 'trace_id' ? active?.traceId : field === 'span_id' ? active?.spanId : undefined;
        const value = safeString(bindings[field] ?? correlated, field === 'trace_id' ? 32 : field === 'span_id' ? 16 : 128);
        if (value !== undefined) record[field] = value;
      }
      const error = stableError(bindings.error ?? bindings.err);
      if (error !== undefined) record.error = error;
      const rawMessage = typeof first === 'string' ? first : second;
      const message = safeString(redactTelemetryValue(rawMessage, { maxStringLength: 1_024 }), 1_024);
      if (message !== undefined) record.msg = message;
      try { destination.write(`${JSON.stringify(record)}\n`); } catch {}
    };
    const logger = {
      level: options.level ?? 'info',
      trace: (first: unknown, second?: string) => write('trace', first, second),
      debug: (first: unknown, second?: string) => write('debug', first, second),
      info: (first: unknown, second?: string) => write('info', first, second),
      warn: (first: unknown, second?: string) => write('warn', first, second),
      error: (first: unknown, second?: string) => write('error', first, second),
      fatal: (first: unknown, second?: string) => write('fatal', first, second),
      child: (bindings: ObservabilityLogBindings) => makeLogger(selectBindings(parentBindings, asBindings(bindings))),
      bindings: () => ({ ...parentBindings }),
      isLevelEnabled: (level: ObservabilityLogLevel) => LEVELS.indexOf(level) >= threshold,
    } satisfies ObservabilityLogger;
    return logger;
  };

  // The runtime parameter keeps logger creation coupled to an initialized server-only
  // observability boundary; trace correlation is read from that runtime's active context.
  void runtime.tracer;
  return makeLogger({});
}
