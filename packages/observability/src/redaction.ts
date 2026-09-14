const DEFAULT_REPLACEMENT = '[REDACTED]';
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING_LENGTH = 1_024;
const MAX_ROUTE_LENGTH = 128;

export const PINO_REDACT_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'token',
  'secret',
  'apiKey',
  'prompt',
  'completion',
  'toolArgs',
  'documentContent',
] as const);

export type TelemetryRedactionPolicy = {
  allowKeys?: readonly string[];
  replacement?: string;
  maxDepth?: number;
  maxStringLength?: number;
};

const DEFAULT_ALLOWED_KEYS = new Set([
  'timestamp', 'level', 'service', 'environment', 'version', 'instance_id',
  'request_id', 'trace_id', 'span_id', 'run_id', 'job_id', 'operation', 'event',
  'outcome', 'msg', 'error', 'type', 'code', 'stack', 'method', 'route',
  'status_code', 'status_class', 'duration_ms', 'queue', 'job', 'provider',
  'model', 'tool', 'component', 'reason', 'signal', 'req', 'headers', 'body',
  'x-request-id', 'input_tokens', 'output_tokens', 'retry_count', 'fallback_count',
]);

const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'password', 'token', 'secret', 'apikey',
  'prompt', 'completion', 'toolargs', 'documentcontent',
]);

const SENSITIVE_TEXT_LABEL = String.raw`(?:authorization|cookie|set[-_ ]?cookie|password|token|secret|api[-_ ]?key|prompt|completion|tool[-_ ]?(?:args?|arguments?)|document[-_ ]?contents?)`;
const SENSITIVE_TEXT_MARKER_SOURCE = String.raw`(["']?)\b(${SENSITIVE_TEXT_LABEL})\b\1\s*[:=]\s*`;
const ESCAPED_SENSITIVE_TEXT_MARKER = new RegExp(
  String.raw`\\+["']\s*\b${SENSITIVE_TEXT_LABEL}\b\s*\\+["']\s*[:=]`,
  'i',
);

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

function quotedValueEnd(input: string, start: number, quote: string): number {
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === '\\') index++;
    else if (input[index] === quote) return index + 1;
  }
  return input.length;
}

function structuredValueEnd(input: string, start: number): number {
  const closing: string[] = [];
  for (let index = start; index < input.length; index++) {
    const character = input[index];
    if (character === '"' || character === "'") {
      index = quotedValueEnd(input, index, character) - 1;
      continue;
    }
    if (character === '{') closing.push('}');
    else if (character === '[') closing.push(']');
    else if (character === closing.at(-1)) {
      closing.pop();
      if (closing.length === 0) return index + 1;
    }
  }
  return input.length;
}

function unquotedValueEnd(input: string, start: number): number {
  const candidates = [input.length];
  const nextMarker = new RegExp(SENSITIVE_TEXT_MARKER_SOURCE, 'gi');
  nextMarker.lastIndex = start;
  const marker = nextMarker.exec(input);
  if (marker) candidates.push(marker.index);
  const stackBoundary = /\r?\n\s+(?:at\b|Caused by\b)/gi;
  stackBoundary.lastIndex = start;
  const stack = stackBoundary.exec(input);
  if (stack) candidates.push(stack.index);
  const jsonBoundary = /[,}\]]\s*(?=(?:["'][^"']+["']\s*:|[}\]]|$))/g;
  jsonBoundary.lastIndex = start;
  const json = jsonBoundary.exec(input);
  if (json) candidates.push(json.index);
  return Math.min(...candidates);
}

function redactSensitiveTextValues(input: string, replacement: string): string {
  const marker = new RegExp(SENSITIVE_TEXT_MARKER_SOURCE, 'gi');
  let cursor = 0;
  let output = '';
  for (let match = marker.exec(input); match; match = marker.exec(input)) {
    if (match.index < cursor) continue;
    const valueStart = marker.lastIndex;
    const first = input[valueStart];
    let valueEnd: number;
    let redacted = replacement;
    if (first === '"' || first === "'") {
      valueEnd = quotedValueEnd(input, valueStart, first);
      redacted = `${first}${replacement}${first}`;
    } else if (first === '{' || first === '[') {
      valueEnd = structuredValueEnd(input, valueStart);
    } else {
      valueEnd = unquotedValueEnd(input, valueStart);
    }
    output += input.slice(cursor, valueStart) + redacted;
    cursor = valueEnd;
    marker.lastIndex = valueEnd;
  }
  return output + input.slice(cursor);
}

function sanitizeString(input: string, replacement: string, maxLength: number): string {
  const boundedInput = input.slice(0, maxLength + 4_096);
  // Multiply serialized content has no reliable index mapping back to the source.
  // Prefer dropping the bounded free-form value over risking partial disclosure.
  if (ESCAPED_SENSITIVE_TEXT_MARKER.test(boundedInput)) return replacement.slice(0, maxLength);
  return redactSensitiveTextValues(boundedInput, replacement)
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${replacement}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${replacement}@`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement)
    .slice(0, maxLength);
}

function stableErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const code = String(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? code : undefined;
}

function redactError(error: Error & { code?: unknown }, replacement: string, maxStringLength: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: /^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/.test(error.name) ? error.name : 'Error',
  };
  const code = stableErrorCode(error.code);
  if (code !== undefined) result.code = code;
  if (error.stack) result.stack = sanitizeString(error.stack, replacement, maxStringLength);
  return result;
}

/**
 * Redacts sensitive keys at every depth and serializes unknown objects through an
 * explicit allow-list. Error messages and causes are intentionally excluded.
 */
export function redactTelemetryValue(value: unknown, policy: TelemetryRedactionPolicy = {}): unknown {
  const replacement = policy.replacement ?? DEFAULT_REPLACEMENT;
  const maxDepth = boundedInteger(policy.maxDepth, DEFAULT_MAX_DEPTH, 32);
  const maxStringLength = boundedInteger(policy.maxStringLength, DEFAULT_MAX_STRING_LENGTH, 16_384);
  const allowedKeys = new Set([...DEFAULT_ALLOWED_KEYS, ...(policy.allowKeys ?? [])]);
  const visited = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'string') return sanitizeString(current, replacement, maxStringLength);
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'undefined' || typeof current === 'symbol' || typeof current === 'function') return undefined;
    if (current instanceof Error) return redactError(current, replacement, maxStringLength);
    if (current instanceof Date) return Number.isNaN(current.valueOf()) ? undefined : current.toISOString();
    if (depth >= maxDepth || visited.has(current)) return replacement;
    visited.add(current);
    if (Array.isArray(current)) {
      return current.slice(0, 100).map(item => visit(item, depth + 1)).filter(item => item !== undefined);
    }
    const output: Record<string, unknown> = {};
    let keys: string[];
    try { keys = Object.keys(current); } catch { return replacement; }
    for (const key of keys) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        output[key] = replacement;
        continue;
      }
      if (!allowedKeys.has(key)) continue;
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(current, key); } catch { continue; }
      if (!descriptor || !('value' in descriptor)) continue;
      const redacted = visit(descriptor.value, depth + 1);
      if (redacted !== undefined) output[key] = redacted;
    }
    return output;
  };

  return visit(value, 0);
}

export function createPinoRedactPaths(additional: readonly string[] = []): string[] {
  return [...new Set<string>([...PINO_REDACT_PATHS, ...additional])];
}

declare const normalizedRouteBrand: unique symbol;
export type NormalizedRoute = string & { readonly [normalizedRouteBrand]: true };

const IDENTIFIER_PARENT_SEGMENTS = new Set([
  'users', 'user', 'tenants', 'tenant', 'sessions', 'session', 'runs', 'run',
  'requests', 'request', 'jobs', 'job', 'documents', 'document', 'files', 'file', 'messages', 'message',
  'invocations', 'invocation', 'knowledge-bases', 'knowledge-base',
]);

function looksLikeIdentifier(segment: string, previous: string | undefined): boolean {
  if (/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) return false;
  if (previous && IDENTIFIER_PARENT_SEGMENTS.has(previous.toLowerCase())) return true;
  if (/^v\d+$/i.test(segment) || segment === '.well-known') return false;
  if (/^[0-9]+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$/.test(segment)) return true;
  if (/\.[A-Za-z0-9]{1,12}$/.test(segment)) return true;
  if (segment.includes('@') || segment.length > 32) return true;
  return false;
}

function pathnameOf(value: string): string {
  try { return new URL(value, 'http://observability.invalid').pathname; }
  catch { return '/unknown'; }
}

/** Produces a bounded route label, preferring the framework route template. */
export function normalizeRoute(url: string, route?: string): NormalizedRoute {
  const pathname = pathnameOf(route?.trim() || url);
  const segments = pathname.split('/').filter(Boolean).slice(0, 16);
  const normalized: string[] = [];
  for (const segment of segments) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    normalized.push(looksLikeIdentifier(decoded, normalized.at(-1)) ? ':id' : decoded.slice(0, 48));
  }
  const value = (`/${normalized.join('/')}` || '/').slice(0, MAX_ROUTE_LENGTH);
  return value as NormalizedRoute;
}
