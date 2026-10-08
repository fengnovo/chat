import type { StreamAgentEvent } from '../api/types';
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
  lastSeq: number;
  connectionError: boolean;
}

export interface ChatState {
  items: ChatItem[];
  active: ActiveRun | null;
  loadingHistory: boolean;
  error: string | null;
}

export type ChatAction =
  | { type: 'history'; items: ChatItem[]; activeRunId: string | null }
  | { type: 'run-started'; runId: string; userText: string }
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

function finalize(state: ChatState, failureMessage: string | null): ChatState {
  const active = state.active;
  if (!active || active.finished) return state;
  const completed = {
    ...active,
    finished: true,
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
      return finalize(state, `运行失败：${event.message}`);
    case 'run.completed':
    case 'run.cancelled':
      return finalize(state, null);
    default:
      return state;
  }
}

export function reducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'history':
      return {
        ...state,
        error: null,
        loadingHistory: false,
        items: action.items,
        // 有活跃 run 时：历史里的用户消息保留，正文交给事件流按 seq 全量重放重建。
        active: action.activeRunId ? emptyActive(action.activeRunId) : null,
      };
    case 'run-started':
      return {
        ...state,
        items: [
          ...state.items,
          { id: `user-${action.runId}`, role: 'user', text: action.userText },
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
