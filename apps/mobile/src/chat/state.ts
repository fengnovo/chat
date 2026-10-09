import type {
  StreamAgentEvent,
  HistoryResponse,
  ChatAttachment,
} from '../api/types';
import type {
  ApprovalRequest,
  QuestionRequest,
} from '../components/InterruptCards';
import { toolStartedItem, completeTool, type ActivityItem } from './activity';

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  attachments?: ChatAttachment[];
  run?: ActiveRun;
}

export interface ActiveRun {
  runId: string;
  assistantText: string;
  reasoning: string;
  activities: ActivityItem[];
  todos: { content: string; status: string }[];
  totalTokens: number;
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
  reconnecting: boolean;
  finished: boolean;
  outcome?: 'completed' | 'failed' | 'cancelled';
  lastSeq: number;
  connectionError: boolean;
}

export interface ChatState {
  items: ChatItem[];
  active: ActiveRun | null;
  loadingHistory: boolean;
  error: string | null;
  historyPage: { sessionId: string; cursor: string | null; beforeMessageId: string | null } | null;
}

export type ChatAction =
  | {
      type: 'history';
      items: ChatItem[];
      activeRunId: string | null;
      snapshot?: HistoryResponse;
      preserveOlder?: boolean;
    }
  | { type: 'history-page'; items: ChatItem[]; nextCursor?: string | null }
  | {
      type: 'run-started';
      runId: string;
      userText: string;
      attachments?: ChatAttachment[];
    }
  | { type: 'event'; event: StreamAgentEvent }
  | { type: 'reset' }
  | { type: 'finished'; runId: string }
  | { type: 'reconnecting'; runId: string; attempt: number }
  | { type: 'resumed'; runId: string }
  | { type: 'interrupt-responded'; runId: string; interruptId: string }
  | {
      type: 'send-failed';
      message: string;
      runId?: string;
      connectionError?: boolean;
    };

function emptyActive(runId: string): ActiveRun {
  return {
    runId,
    assistantText: '',
    reasoning: '',
    activities: [],
    todos: [],
    totalTokens: 0,
    approval: null,
    question: null,
    reconnecting: false,
    finished: false,
    lastSeq: 0,
    connectionError: false,
  };
}

function finalize(
  state: ChatState,
  failureMessage: string | null,
  outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
): ChatState {
  const active = state.active;
  if (!active || active.finished) return state;
  const completed = {
    ...active,
    finished: true,
    outcome,
    reconnecting: false,
    connectionError: false,
    approval: null,
    question: null,
  };
  return {
    ...state,
    items: [
      ...state.items.filter((item) => item.id !== `message-${active.runId}`),
      {
        id: `message-${active.runId}`,
        role: 'assistant',
        text: active.assistantText,
        run: completed,
      },
    ],
    active: completed,
    error: failureMessage,
  };
}

function applyEvent(state: ChatState, event: StreamAgentEvent): ChatState {
  const previous = state.active;
  if (
    !previous ||
    previous.finished ||
    previous.runId !== event.runId ||
    event.seq <= previous.lastSeq
  )
    return state;
  const active = { ...previous, lastSeq: event.seq };
  state = { ...state, active };

  switch (event.type) {
    case 'run.started':
      return {
        ...state,
        active: { ...active, approval: null, question: null },
      };
    case 'assistant.delta':
      return {
        ...state,
        active: { ...active, assistantText: active.assistantText + event.text },
      };
    case 'assistant.snapshot':
      return { ...state, active: { ...active, assistantText: event.text } };
    case 'assistant.reasoning':
      return {
        ...state,
        active: { ...active, reasoning: active.reasoning + event.text },
      };
    case 'assistant.narration':
      return {
        ...state,
        active: {
          ...active,
          activities: [
            ...active.activities,
            { kind: 'note', summary: event.text },
          ],
        },
      };
    case 'tool.started':
      return {
        ...state,
        active: {
          ...active,
          activities: [
            ...active.activities.filter(
              (item) =>
                item.kind !== 'tool' ||
                item.invocationId !== event.invocationId,
            ),
            toolStartedItem(event.invocationId, event.tool, event.input),
          ],
        },
      };
    case 'tool.completed':
      return {
        ...state,
        active: {
          ...active,
          activities: completeTool(
            active.activities,
            event.invocationId,
            event.tool,
            event.output,
          ),
        },
      };
    case 'todo.updated':
      return { ...state, active: { ...active, todos: event.todos } };
    case 'usage.updated':
      return {
        ...state,
        active: {
          ...active,
          totalTokens: active.totalTokens + event.totalTokens,
        },
      };
    case 'approval.required':
      return {
        ...state,
        active: {
          ...active,
          question: null,
          approval: {
            runId: event.runId,
            interruptId: event.interruptId,
            actions: event.actions.map((action) => ({
              name: action.name,
              summary: action.summary,
            })),
          },
        },
      };
    case 'question.required':
      return {
        ...state,
        active: {
          ...active,
          approval: null,
          question: {
            runId: event.runId,
            interruptId: event.interruptId,
            question: event.question.question,
            options: event.question.options,
            multiple: event.question.multiple,
            allowCustom: event.question.allowCustom,
          },
        },
      };
    case 'model.retry':
      return {
        ...state,
        active: {
          ...active,
          activities: [
            ...active.activities,
            {
              kind: 'note',
              summary: `模型重试（${event.model} 第 ${event.attempt} 次）：${event.reason}`,
            },
          ],
        },
      };
    case 'model.fallback':
      return {
        ...state,
        active: {
          ...active,
          activities: [
            ...active.activities,
            { kind: 'note', summary: `模型降级：${event.from} → ${event.to}` },
          ],
        },
      };
    case 'context.compressing':
      return {
        ...state,
        active: {
          ...active,
          activities: [
            ...active.activities,
            { kind: 'note', summary: '正在压缩上下文…' },
          ],
        },
      };
    case 'run.failed':
      return finalize(state, `运行失败：${event.message}`, 'failed');
    case 'run.completed':
      return finalize(state, null);
    case 'run.cancelled':
      return finalize(state, null, 'cancelled');
    default:
      return state;
  }
}

export function reducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'history':
      if (action.snapshot) {
        const restored = restoreHistory(action.snapshot);
        if (!action.preserveOlder) return restored;
        const ids = new Set(restored.items.map((item) => item.id));
        const refreshedRuns = new Set(action.snapshot.messages.map((message) => message.runId));
        if (action.snapshot.latestRun) refreshedRuns.add(action.snapshot.latestRun.id);
        return { ...restored, items: [...state.items.filter((item) => !ids.has(item.id) &&
          !refreshedRuns.has(item.run?.runId ?? item.id.replace(/^(user|message)-/, ''))), ...restored.items] };
      }
      return {
        ...state,
        error: null,
        loadingHistory: false,
        items: action.items,
        // 有活跃 run 时：历史里的用户消息保留，正文交给事件流按 seq 全量重放重建。
        active: action.activeRunId ? emptyActive(action.activeRunId) : null,
      };
    case 'history-page': {
      const current = new Map(state.items.map((item) => [item.id, item]));
      const ids = new Set(action.items.map((item) => item.id));
      // Refreshed pages can leave a gap after already cached older messages.
      // Insert before the page boundary, retaining server order and live values.
      const found = state.items.findIndex((item) => item.id === state.historyPage?.beforeMessageId);
      const boundary = found >= 0 ? found : state.historyPage ? state.items.length : 0;
      return { ...state, items: [
        ...state.items.slice(0, boundary).filter((item) => !ids.has(item.id)),
        ...action.items.map((item) => {
          const live = state.active && !state.active.finished &&
            (item.id === `user-${state.active.runId}` || item.id === `message-${state.active.runId}`);
          return live ? current.get(item.id) ?? item : item;
        }),
        ...state.items.slice(boundary).filter((item) => !ids.has(item.id)),
      ], historyPage: state.historyPage ? { ...state.historyPage, cursor: action.nextCursor ?? null,
        beforeMessageId: action.items[0]?.id ?? state.historyPage.beforeMessageId } : null };
    }
    case 'run-started':
      if (state.active?.runId === action.runId) return state;
      return {
        ...state,
        items: [
          ...state.items,
          {
            id: `user-${action.runId}`,
            role: 'user',
            text: action.userText,
            attachments: action.attachments,
          },
        ],
        active: emptyActive(action.runId),
        error: null,
      };
    case 'event':
      return applyEvent(state, action.event);
    case 'finished': {
      const active = state.active;
      if (!active || active.finished || active.runId !== action.runId)
        return state;
      return finalize(state, null);
    }
    case 'reconnecting': {
      const active = state.active;
      if (!active || active.finished || active.runId !== action.runId)
        return state;
      return {
        ...state,
        active: { ...active, reconnecting: true, connectionError: false },
      };
    }
    case 'resumed': {
      const active = state.active;
      if (!active || active.finished || active.runId !== action.runId)
        return state;
      return {
        ...state,
        active: { ...active, reconnecting: false, connectionError: false },
        error: null,
      };
    }
    case 'interrupt-responded': {
      const active = state.active;
      if (!active || active.finished || active.runId !== action.runId)
        return state;
      if (
        (active.approval?.interruptId ?? active.question?.interruptId) !==
        action.interruptId
      )
        return state;
      return {
        ...state,
        error: null,
        active: { ...active, approval: null, question: null },
      };
    }
    case 'send-failed':
      if (action.runId && state.active?.runId !== action.runId) return state;
      return {
        ...state,
        loadingHistory: false,
        error: action.message,
        active:
          state.active && action.connectionError
            ? { ...state.active, reconnecting: false, connectionError: true }
            : state.active,
      };
    default:
      return state;
  }
}

export const initialState: ChatState = {
  items: [],
  active: null,
  loadingHistory: true,
  error: null,
  historyPage: null,
};

/** One stable assistant row owns both the live response and its completed process. */
export function selectChatItems(state: ChatState): ChatItem[] {
  const active = state.active;
  return active && !active.finished
    ? [
        ...state.items,
        {
          id: `message-${active.runId}`,
          role: 'assistant',
          text: active.assistantText,
          run: active,
        },
      ]
    : state.items;
}

export function isRunActive(status: string): boolean {
  return ['queued', 'running', 'waiting_approval', 'waiting_question'].includes(
    status,
  );
}

/** Rebuild the latest turn from persisted events, then reconcile with authoritative run status. */
export function restoreHistory(history: HistoryResponse): ChatState {
  const latest = history.latestRun;
  const replay = latest && history.latestRunEvents !== undefined;
  let state: ChatState = {
    historyPage: { sessionId: history.session.id, cursor: history.hasMore ? history.nextCursor ?? null : null,
      beforeMessageId: history.messages[0]?.id ?? null },
    items: history.messages
      .filter(
        (message) =>
          !(
            latest &&
            (replay || isRunActive(latest.status)) &&
            message.runId === latest.id &&
            message.role === 'assistant'
          ),
      )
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        reasoning: message.reasoning,
        attachments: message.attachments,
      })),
    active:
      latest && (replay || isRunActive(latest.status))
        ? emptyActive(latest.id)
        : null,
    loadingHistory: false,
    error: null,
  };
  if (!latest || !replay) return state;
  const projection = history.latestRunProjection;
  if (projection && state.active) {
    state = { ...state, active: { ...state.active, assistantText: projection.text, reasoning: projection.reasoning } };
  }
  for (const event of history.latestRunEvents!) {
    // Text at/before the projection cursor is already materialized; replay control cards.
    if (projection && event.seq <= projection.lastSeq &&
      ['assistant.delta', 'assistant.snapshot', 'assistant.reasoning'].includes(event.type)) continue;
    state = applyEvent(state, event);
  }
  if (projection && state.active) state = { ...state, active: { ...state.active, lastSeq: Math.max(state.active.lastSeq, projection.lastSeq) } };
  if (!isRunActive(latest.status)) {
    state = finalize(
      state,
      latest.status === 'failed'
        ? `运行失败：${latest.errorMessage ?? '任务未完成'}`
        : null,
      latest.status === 'failed'
        ? 'failed'
        : latest.status === 'cancelled'
          ? 'cancelled'
          : 'completed',
    );
  } else if (state.active) {
    state = {
      ...state,
      active: {
        ...state.active,
        approval:
          latest.status === 'waiting_approval' ? state.active.approval : null,
        question:
          latest.status === 'waiting_question' ? state.active.question : null,
      },
    };
  }
  return state;
}
