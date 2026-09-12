import type { RunStatus } from '@repo/contracts';

import type {
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
  failureFromRun,
  formatSessionTime,
  isPendingStatus,
  messageText,
  messagesFromHistory,
};
