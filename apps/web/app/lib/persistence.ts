import type { UIMessage } from 'ai';

const STORAGE_KEY = 'resilient-chat:last-run';

export type PersistedRun = {
  chatId: string;
  runId: string;
  chunkIndex: number;
  messages: UIMessage[];
  pending: boolean;
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
