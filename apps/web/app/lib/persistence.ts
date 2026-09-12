import type { UIMessage } from 'ai';

const STORAGE_KEY = 'resilient-chat:last-run';
const SESSION_CACHE_KEY = 'resilient-chat:sessions';

export type PersistedRun = {
  chatId: string;
  runId: string;
  chunkIndex: number;
  messages: UIMessage[];
  pending: boolean;
};

export type SessionCache<T> = {
  data: T[];
  nextCursor: string | null;
};

export function readPersistedRun(): PersistedRun | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PersistedRun>;
    if (
      typeof parsed.chatId !== 'string' ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.chunkIndex !== 'number' ||
      !Array.isArray(parsed.messages) ||
      typeof parsed.pending !== 'boolean'
    ) {
      return null;
    }
    return parsed as PersistedRun;
  } catch {
    return null;
  }
}

export function writePersistedRun(run: PersistedRun) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
}

export function updatePersistedCursor(runId: string, chunkIndex: number) {
  const current = readPersistedRun();
  if (!current || current.runId !== runId) return;
  writePersistedRun({ ...current, chunkIndex });
}

export function clearPersistedRun() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function readSessionCache<T>(): SessionCache<T> | null {
  try {
    const value = window.sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as {
      data?: unknown;
      nextCursor?: unknown;
    };
    if (!Array.isArray(parsed.data)) return null;
    return {
      data: parsed.data as T[],
      nextCursor:
        typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
    };
  } catch {
    return null;
  }
}

export function writeSessionCache(cache: SessionCache<unknown>) {
  try {
    window.sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式或超出配额时忽略，下次挂载重新拉取即可
  }
}
