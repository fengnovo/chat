const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const NETWORK_MESSAGE_PATTERNS = [
  /connection error/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /timed?\s*out/i,
  /temporary failure in name resolution/i,
];

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const value = asErrorLike(error)?.message;
  return typeof value === 'string' && value ? value : String(error);
}

/** 判断是否为稍后重试可能恢复的网络、限流或服务端错误。 */
export function isRecoverableNetworkError(error: unknown): boolean {
  const visited = new Set<unknown>();

  function visit(value: unknown): boolean {
    if (visited.has(value)) return false;
    visited.add(value);

    if (value instanceof AggregateError && value.errors.some(visit)) return true;

    const candidate = asErrorLike(value);
    if (!candidate) return false;

    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    if (NETWORK_ERROR_CODES.has(code)) return true;

    const status = typeof candidate.status === 'number' ? candidate.status : 0;
    if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
      return true;
    }

    const name = typeof candidate.name === 'string' ? candidate.name : '';
    if (/APIConnectionError|APITimeoutError/i.test(name)) return true;

    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) return true;

    return candidate.cause !== undefined && visit(candidate.cause);
  }

  return visit(error);
}
