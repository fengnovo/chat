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
    if (entry.kind !== 'tool') continue;
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
              entry.kind === 'tool' &&
              entry.phase === 'start' &&
              outstanding.has(entry.invocationId),
          ) ?? null);

  return {
    entries: state.entries,
    runningTool: running?.kind === 'tool' ? running.tool : null,
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 执行日志里主行显示的摘要：命令直接给 `$ cmd`，
 * 文件类工具给路径，读文件给行范围，其余退化为紧凑 JSON。
 */
function toolCallSummary(tool: string, input: unknown): string {
  const args = asRecord(input);
  if (typeof input === 'string') return input;
  if (tool === 'execute') return `$ ${String(args.command ?? '')}`.trim();
  if (tool === 'write_file' || tool === 'edit_file') {
    const filePath = String(args.file_path ?? args.path ?? '');
    const content = args.content;
    return typeof content === 'string'
      ? `${filePath} · ${content.length} 字符`
      : filePath;
  }
  if (tool === 'read_file') {
    const filePath = String(args.file_path ?? args.path ?? '');
    const start = args.start_line ?? args.offset;
    const end = args.end_line ?? args.limit;
    return start || end ? `${filePath} · 行 ${start ?? ''}-${end ?? ''}` : filePath;
  }
  if (tool === 'delete') return String(args.file_path ?? args.path ?? '');
  if (tool === 'write_todos') return `${(args.todos as unknown[] | undefined)?.length ?? 0} 项`;
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const compact = asText(input).replace(/\s+/g, ' ');
  return compact.length > 140 ? `${compact.slice(0, 140)}…` : compact;
}

/** 执行日志里展开的详细内容：参数与结果原文，供打印输出展示。 */
function toolDetailText(value: unknown): string {
  return asText(value);
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
  failureFromRun,
  formatDuration,
  formatSessionTime,
  isPendingStatus,
  messageText,
  messagesFromHistory,
  toolCallSummary,
  toolDetailText,
};
