import type { RunStatus } from '@repo/contracts';

import type {
  AgentActivityState,
  AgentStatus,
  HistoryMessage,
  ResilientMessage,
  RunSummary,
  TaskFailure,
} from './types';

function messageText(message: ResilientMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function estimateTokens(text: string) {
  const length = text.trim().length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

function deriveAgentActivity(
  state: AgentActivityState,
  active: boolean,
  now: number,
): Omit<AgentStatus, 'tokens'> {
  const outstanding = new Set<string>();
  for (const entry of state.entries) {
    if (entry.phase === 'start') outstanding.add(entry.invocationId);
    else outstanding.delete(entry.invocationId);
  }
  const running =
    !active || outstanding.size === 0
      ? null
      : ([...state.entries]
          .reverse()
          .find(
            (entry) =>
              entry.phase === 'start' && outstanding.has(entry.invocationId),
          ) ?? null);

  return {
    entries: state.entries,
    runningTool: running?.tool ?? null,
    elapsedSeconds: state.startedAt
      ? Math.max(0, Math.floor((now - state.startedAt) / 1_000))
      : 0,
    idleSeconds: state.lastEventAt
      ? Math.max(0, Math.floor((now - state.lastEventAt) / 1_000))
      : 0,
  };
}

function messagesFromHistory(messages: HistoryMessage[]): ResilientMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    metadata: {
      createdAt: message.createdAt,
      runId: message.runId,
    },
    parts: [{ type: 'text', text: message.text }],
  }));
}

function isPendingStatus(status: RunStatus) {
  return !['completed', 'failed', 'cancelled'].includes(status);
}

function failureFromRun(run: RunSummary | null): TaskFailure | null {
  if (run?.status !== 'failed') return null;
  return {
    code: run.errorCode ?? 'run_failed',
    message: run.errorMessage ?? 'Agent 没有完成本次任务',
  };
}

function formatSessionTime(value: string) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1_000),
  );
  if (elapsedSeconds < 60) return '刚刚更新';
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)} 分钟前`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

export {
  deriveAgentActivity,
  estimateTokens,
  failureFromRun,
  formatDuration,
  formatSessionTime,
  isPendingStatus,
  messageText,
  messagesFromHistory,
};
