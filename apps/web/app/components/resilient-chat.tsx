'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import { AIBoundary } from '@cognicatch/react';
import type { AgentEvent, RunStatus } from '@repo/contracts';
import type { UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  clearPersistedRun,
  type PersistedRun,
  readPersistedRun,
  updatePersistedCursor,
  writePersistedRun,
} from '@/app/lib/persistence';
import { ResilientSession } from '@/app/lib/session';

type PipelineEvent = {
  id: string;
  stage:
    | 'request'
    | 'retry'
    | 'circuit'
    | 'fallback'
    | 'verify'
    | 'transport'
    | 'done';
  status: 'running' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
  timestamp: string;
};

type InsightCard = {
  kind: 'reliability-summary' | 'unsupported-widget';
  eyebrow: string;
  title: string;
  body: string;
  metric: string;
  metric_label: string;
};

type MessageMetadata = {
  createdAt?: string;
  model?: string;
  runId?: string;
};

type ResilientData = {
  agent: AgentEvent;
  pipeline: PipelineEvent;
  card: InsightCard | null;
  suggestions: string[];
};

type ResilientMessage = UIMessage<MessageMetadata, ResilientData>;
type PendingInterrupt = Extract<
  AgentEvent,
  { type: 'approval.required' | 'question.required' }
>;
type AgentTodo = Extract<AgentEvent, { type: 'todo.updated' }>['todos'][number];
type QuestionAnswer = {
  selections: Array<{ index: number; label: string }>;
  customText?: string;
};

type SessionSummary = {
  id: string;
  title: string;
  externalKey: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

type WebSessionSummary = SessionSummary & { externalKey: string };

type ProjectSummary = {
  id: string;
  name: string;
  sourceType: 'empty' | 'git' | 'upload';
  sourceRef: string | null;
  sourceRevision: string | null;
  createdAt: string;
  updatedAt: string;
};

type SessionPage = {
  data: WebSessionSummary[];
  nextCursor: string | null;
};

type HistoryMessage = {
  id: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};

type SessionHistory = {
  session: SessionSummary;
  messages: HistoryMessage[];
  latestRun: {
    id: string;
    status: RunStatus;
  } | null;
};

type ConversationSeed = {
  chatId: string;
  messages: ResilientMessage[];
  projectId: string | null;
  resumeRun: PersistedRun | null;
};

type SessionDialog =
  | { kind: 'rename'; session: WebSessionSummary }
  | { kind: 'delete'; session: WebSessionSummary };

const projectUploadMaxBytes = 20_000_000;

const starterPrompts = [
  {
    icon: 'panel' as const,
    label: '检查项目',
    description: '理解结构并找出风险',
    prompt: '请检查这个项目的结构，说明主要模块并找出最值得优先处理的问题。',
  },
  {
    icon: 'braces' as const,
    label: '实现功能',
    description: '规划、编码并验证',
    prompt: '请先阅读 README 和项目代码，然后选择一个明确的未完成功能，制定计划并实现它。',
  },
  {
    icon: 'triangle' as const,
    label: '诊断错误',
    description: '复现并定位根因',
    prompt: '请运行项目的检查和测试，定位当前错误的根因并提出修复方案。',
  },
  {
    icon: 'check' as const,
    label: '运行验证',
    description: '类型、测试与构建',
    prompt: '请检查现有改动，并运行适合这个项目的类型检查、测试和构建。',
  },
];

const initialTrace: PipelineEvent[] = [
  {
    id: 'boot-transport',
    stage: 'transport',
    status: 'success',
    title: '持久化事件流已就绪',
    detail: 'SSE 断流后将从数据库 cursor 续传',
    timestamp: '--:--:--',
  },
  {
    id: 'boot-circuit',
    stage: 'circuit',
    status: 'success',
    title: '共享熔断器已连接',
    detail: 'Redis 在 Worker 之间共享模型健康状态',
    timestamp: '--:--:--',
  },
  {
    id: 'boot-verify',
    stage: 'verify',
    status: 'success',
    title: '租户与工作区隔离已加载',
    detail: 'API 鉴权、队列和独立 workspace 正在保护运行',
    timestamp: '--:--:--',
  },
];

type IconName =
  | 'arrow'
  | 'braces'
  | 'check'
  | 'chevron'
  | 'copy'
  | 'edit'
  | 'folder'
  | 'git'
  | 'layers'
  | 'menu'
  | 'more'
  | 'panel'
  | 'plus'
  | 'refresh'
  | 'shield'
  | 'shuffle'
  | 'square'
  | 'trash'
  | 'triangle'
  | 'upload'
  | 'user'
  | 'x';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="m5 12 7-7 7 7M12 5v14" />,
    braces: <path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2m8-16h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    copy: <><rect width="12" height="12" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    git: <><circle cx="6" cy="4" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 7c5 0 4-1 8-1" /></>,
    layers: <><path d="m12.83 2.18 8 4a1 1 0 0 1 0 1.79l-8 4a2 2 0 0 1-1.66 0l-8-4a1 1 0 0 1 0-1.79l8-4a2 2 0 0 1 1.66 0Z" /><path d="m22 12.5-9.17 4.59a2 2 0 0 1-1.66 0L2 12.5m20 5-9.17 4.59a2 2 0 0 1-1.66 0L2 17.5" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
    panel: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M9 9h12" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 9a7 7 0 0 0-11.7-2.6L4 11m16 2-2.8 4.6A7 7 0 0 1 5.5 15" /></>,
    shield: <><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z" /><path d="m9 12 2 2 4-4" /></>,
    shuffle: <><path d="m18 14 4 4-4 4" /><path d="m18 2 4 4-4 4" /><path d="M2 18h1.4a8 8 0 0 0 6.7-3.6l3.8-5.8A8 8 0 0 1 20.6 5H22M2 6h1.9a8 8 0 0 1 6.7 3.6l.7 1" /></>,
    square: <rect width="12" height="12" x="6" y="6" rx="1" fill="currentColor" stroke="none" />,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7" /></>,
    triangle: <><path d="M21.7 16 14 2.7a2.3 2.3 0 0 0-4 0L2.3 16A2.3 2.3 0 0 0 4.3 19h15.4a2.3 2.3 0 0 0 2-3Z" /><path d="M12 9v4m0 3h.01" /></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    x: <path d="m6 6 12 12M18 6 6 18" />,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {paths[name]}
    </svg>
  );
}

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

async function fetchSessionPage(cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/agent/sessions?${query}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data: SessionSummary[];
    nextCursor: string | null;
  };
  return {
    data: payload.data.filter(
      (session): session is WebSessionSummary =>
        typeof session.externalKey === 'string' && session.externalKey.length > 0,
    ),
    nextCursor: payload.nextCursor,
  } satisfies SessionPage;
}

async function fetchProjects(signal?: AbortSignal) {
  const response = await fetch('/api/agent/projects', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { data: ProjectSummary[] };
  return payload.data;
}

async function responseError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  const knownErrors: Record<string, string> = {
    project_upload_too_large: '上传内容不能超过 20 MB',
    project_not_found: '所选项目不存在或已不可用',
    session_has_active_run: '这条会话仍在运行，请先停止任务再删除',
    session_not_found: '这条会话不存在或已被删除',
  };
  return payload?.error ? knownErrors[payload.error] ?? fallback : fallback;
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function localEvent(
  stage: PipelineEvent['stage'],
  status: PipelineEvent['status'],
  title: string,
  detail: string,
): PipelineEvent {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    stage,
    status,
    title,
    detail,
    timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
}

function agentEventToTrace(event: AgentEvent): PipelineEvent | null {
  const base = {
    id: `${event.runId}-${event.timestamp}-${event.type}`,
    timestamp: new Date(event.timestamp).toLocaleTimeString('zh-CN', {
      hour12: false,
    }),
  };

  switch (event.type) {
    case 'assistant.delta':
      return null;
    case 'run.started':
      return {
        ...base,
        stage: 'request',
        status: 'running',
        title: 'Worker 已接管运行',
        detail: '队列任务已启动，正在隔离工作区中执行',
      };
    case 'model.retry':
      return {
        ...base,
        stage: 'retry',
        status: 'warning',
        title: `${event.model} 正在重试`,
        detail: `第 ${event.attempt} 次尝试将在 ${event.delayMs}ms 后执行 · ${event.reason}`,
      };
    case 'model.fallback':
      return {
        ...base,
        stage: 'fallback',
        status: 'warning',
        title: `模型已切换至 ${event.to}`,
        detail: `${event.from} 暂不可用 · ${event.reason}`,
      };
    case 'tool.started':
      return {
        ...base,
        stage: 'request',
        status: 'running',
        title: `正在调用 ${event.tool}`,
        detail: `tool invocation ${event.invocationId.slice(0, 8)}`,
      };
    case 'tool.completed':
      return {
        ...base,
        stage: 'verify',
        status: 'success',
        title: `${event.tool} 已完成`,
        detail: `tool invocation ${event.invocationId.slice(0, 8)}`,
      };
    case 'todo.updated': {
      const completed = event.todos.filter((todo) => todo.status === 'completed').length;
      return {
        ...base,
        stage: 'request',
        status: 'running',
        title: '任务计划已更新',
        detail: `${completed}/${event.todos.length} 项已完成`,
      };
    }
    case 'approval.required':
      return {
        ...base,
        stage: 'verify',
        status: 'warning',
        title: '等待人工审批',
        detail: `${event.actions.length} 个高风险操作需要确认`,
      };
    case 'question.required':
      return {
        ...base,
        stage: 'verify',
        status: 'warning',
        title: 'Agent 正在等待你的选择',
        detail: event.question.question,
      };
    case 'artifact.created':
      return {
        ...base,
        stage: 'verify',
        status: 'success',
        title: `已保存产物 ${event.name}`,
        detail: event.contentType,
      };
    case 'run.completed':
      return {
        ...base,
        stage: 'done',
        status: 'success',
        title: '运行已完成',
        detail: '事件、检查点和最终状态已持久化',
      };
    case 'run.cancelled':
      return {
        ...base,
        stage: 'done',
        status: 'warning',
        title: '运行已取消',
        detail: 'Worker 已收到取消信号并释放资源',
      };
    case 'run.failed':
      return {
        ...base,
        stage: 'done',
        status: 'error',
        title: `运行失败 · ${event.code}`,
        detail: event.message,
      };
  }
}

function countSseFrames(text: string) {
  return text
    .split('\n\n')
    .slice(0, -1)
    .filter((frame) => frame.trimStart().startsWith('data:')).length;
}

function createTrackedFetch(): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok || !response.body) return response;

    const runId = response.headers.get('x-workflow-run-id');
    if (!runId) return response;

    const requestUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(requestUrl, window.location.origin);
    const headers = new Headers(init?.headers);
    const isPageResume = headers.get('x-page-resume') === '1';
    let cursor = isPageResume
      ? 0
      : Number(url.searchParams.get('startIndex') ?? '0');
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    const decoder = new TextDecoder();
    let pending = '';
    const observed = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          pending += decoder.decode(chunk, { stream: true });
          const boundary = pending.lastIndexOf('\n\n');
          if (boundary === -1) return;
          const complete = pending.slice(0, boundary + 2);
          pending = pending.slice(boundary + 2);
          cursor += countSseFrames(complete);
          updatePersistedCursor(runId, cursor);
        },
      }),
    );

    return new Response(observed, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

export function ResilientChat() {
  const isClient = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  if (!isClient) {
    return <AppSkeleton />;
  }

  return <ChatRuntime initialRun={readPersistedRun()} />;
}

function AppSkeleton() {
  return (
    <main className="app-shell is-loading" aria-label="正在加载可靠聊天">
      <aside className="sidebar skeleton-panel" />
      <section className="chat-column">
        <div className="topbar skeleton-line" />
        <div className="skeleton-center">
          <div className="skeleton-orb" />
          <div className="skeleton-copy" />
          <div className="skeleton-copy short" />
        </div>
      </section>
    </main>
  );
}

function ChatRuntime({ initialRun }: { initialRun: PersistedRun | null }) {
  const [conversation, setConversation] = useState<ConversationSeed>(() => ({
    chatId: initialRun?.chatId ?? crypto.randomUUID(),
    messages: (initialRun?.messages ?? []) as ResilientMessage[],
    projectId: null,
    resumeRun: initialRun?.pending ? initialRun : null,
  }));
  const [input, setInput] = useState('');
  const [trace, setTrace] = useState<PipelineEvent[]>(initialTrace);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [dismissedCards, setDismissedCards] = useState<Set<string>>(
    () => new Set(),
  );
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [pendingInterrupt, setPendingInterrupt] =
    useState<PendingInterrupt | null>(null);
  const [agentTodos, setAgentTodos] = useState<AgentTodo[]>([]);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WebSessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectDialogBusy, setProjectDialogBusy] = useState(false);
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const [sessionDialog, setSessionDialog] = useState<SessionDialog | null>(null);
  const [sessionDialogBusy, setSessionDialogBusy] = useState(false);
  const [sessionDialogError, setSessionDialogError] = useState<string | null>(null);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef(new ResilientSession());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarWasOpenRef = useRef(false);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const page = await fetchSessionPage();
      setSessions(page.data);
      setSessionsNextCursor(page.nextCursor);
      setSessionsError(null);
    } catch {
      setSessionsError('历史记录加载失败');
    } finally {
      setSessionsLoaded(true);
    }
  }, []);

  const transport = useMemo(() => {
    return new WorkflowChatTransport<ResilientMessage>({
        api: '/api/chat',
        fetch: createTrackedFetch(),
        maxConsecutiveErrors: 3,
        initialStartIndex: conversation.resumeRun?.chunkIndex ?? 0,
        prepareSendMessagesRequest: ({ id, messages, trigger }) => ({
          body: {
            messages,
            chat_id: id,
            project_id: conversation.projectId ?? undefined,
            trigger,
          },
          headers: { 'Content-Type': 'application/json' },
        }),
        prepareReconnectToStreamRequest: ({ api }) => {
          const pendingRun =
            conversation.resumeRun?.pending &&
            api.endsWith(`/${encodeURIComponent(conversation.chatId)}/stream`)
              ? conversation.resumeRun
              : null;
          if (!pendingRun) return { api };
          return {
            api: `/api/chat/${encodeURIComponent(pendingRun.runId)}/stream`,
            headers: { 'x-page-resume': '1' },
          };
        },
        onChatSendMessage: (response, options) => {
          const runId = response.headers.get('x-workflow-run-id');
          if (!runId) return;
          writePersistedRun({
            chatId: options.chatId,
            runId,
            chunkIndex: 0,
            messages: options.messages,
            pending: true,
          });
          void refreshSessions();
        },
        onChatEnd: ({ chunkIndex }) => {
          const current = readPersistedRun();
          if (!current) return;
          writePersistedRun({ ...current, chunkIndex });
        },
      });
  }, [
    conversation.chatId,
    conversation.projectId,
    conversation.resumeRun,
    refreshSessions,
  ]);

  const {
    clearError,
    error,
    messages,
    regenerate: reload,
    sendMessage,
    status,
    stop,
  } = useChat<ResilientMessage>({
    id: conversation.chatId,
    messages: conversation.messages,
    resume: Boolean(conversation.resumeRun?.pending && conversation.resumeRun.runId),
    throttle: 24,
    transport,
    onData: (part) => {
      if (part.type === 'data-agent') {
        const event = part.data;
        const mapped = agentEventToTrace(event);
        if (mapped) {
          setTrace((current) =>
            current.some((item) => item.id === mapped.id)
              ? current
              : [...current.slice(-11), mapped],
          );
        }
        if (event.type === 'todo.updated') setAgentTodos(event.todos);
        if (
          event.type === 'approval.required' ||
          event.type === 'question.required'
        ) {
          setPendingInterrupt(event);
          setInteractionError(null);
        }
        if (
          event.type === 'run.completed' ||
          event.type === 'run.cancelled' ||
          event.type === 'run.failed'
        ) {
          setPendingInterrupt(null);
        }
      }
      if (part.type === 'data-pipeline') {
        setTrace((current) => [...current.slice(-9), part.data]);
      }
      if (part.type === 'data-suggestions') {
        setSuggestions(part.data);
      }
    },
    onError: (caught) => {
      const rolledBack = sessionRef.current.rollbackAssistant();
      setTrace((current) => [
        ...current.slice(-9),
        localEvent(
          'request',
          'error',
          '本轮请求已安全回退',
          rolledBack
            ? 'Conversationalist undo() 已移除半截 assistant 状态'
            : '请求在写入 assistant 历史前失败，可直接重新生成',
        ),
      ]);
      console.warn('[Recoverable Chat Error]', caught.message);
    },
    onFinish: ({ message, messages: finishedMessages, isAbort, isError }) => {
      const text = messageText(message);
      if (!isError && text) {
        sessionRef.current.commitAssistant(text);
      }
      if (isError) return;

      const persisted = readPersistedRun();
      const runId = message.metadata?.runId ?? persisted?.runId ?? '';
      if (runId) {
        writePersistedRun({
          chatId: conversation.chatId,
          runId,
          chunkIndex: persisted?.chunkIndex ?? 0,
          messages: finishedMessages,
          pending: false,
        });
      }
      void refreshSessions();
      setConversation((current) =>
        current.chatId === conversation.chatId
          ? { ...current, resumeRun: null }
          : current,
      );
      if (isAbort) {
        setTrace((current) => [
          ...current.slice(-9),
          localEvent('transport', 'warning', '生成已由用户停止', '已保留当前可见内容'),
        ]);
      }
    },
  });

  const isBusy = status === 'submitted' || status === 'streaming';
  const hasConversation = messages.length > 0;
  const hasAssistantPlaceholder =
    messages.at(-1)?.role === 'assistant' && !messageText(messages.at(-1) as ResilientMessage);
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const currentProject = conversation.projectId
    ? projects.find((project) => project.id === conversation.projectId) ?? null
    : null;

  useEffect(() => {
    if (status !== 'streaming' || !lastAssistant) return;
    sessionRef.current.stageAssistant(messageText(lastAssistant));
  }, [lastAssistant, status]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchSessionPage(undefined, controller.signal)
      .then((page) => {
        if (!active) return;
        setSessions(page.data);
        setSessionsNextCursor(page.nextCursor);
        setSessionsError(null);
      })
      .catch((caught: unknown) => {
        if (
          !active ||
          (caught instanceof DOMException && caught.name === 'AbortError')
        ) {
          return;
        }
        setSessionsError('历史记录加载失败');
      })
      .finally(() => {
        if (active) setSessionsLoaded(true);
      });
    fetchProjects(controller.signal)
      .then((loadedProjects) => {
        if (active) setProjects(loadedProjects);
      })
      .catch((caught: unknown) => {
        if (
          !active ||
          (caught instanceof DOMException && caught.name === 'AbortError')
        ) {
          return;
        }
        setProjectDialogError('项目列表加载失败，可稍后重试');
      })
      .finally(() => {
        if (active) setProjectsLoaded(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (sidebarWasOpenRef.current && !sidebarOpen) {
      mobileMenuButtonRef.current?.focus();
    }
    sidebarWasOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  useEffect(() => {
    if (projectDialogOpen || sessionDialog || !dialogReturnFocusRef.current) {
      return;
    }
    const returnTarget = dialogReturnFocusRef.current;
    dialogReturnFocusRef.current = null;
    window.requestAnimationFrame(() => returnTarget.focus());
  }, [projectDialogOpen, sessionDialog]);

  useEffect(() => {
    if (!projectDialogOpen && !sessionDialog && !sessionMenuId && !sidebarOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (sessionDialogBusy || projectDialogBusy) return;
      setProjectDialogOpen(false);
      setSessionDialog(null);
      setSessionMenuId(null);
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [
    projectDialogBusy,
    projectDialogOpen,
    sessionDialog,
    sessionDialogBusy,
    sessionMenuId,
    sidebarOpen,
  ]);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    messagesEndRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [messages, error, pendingInterrupt]);

  async function selectSession(session: WebSessionSummary) {
    if (isBusy || session.externalKey === conversation.chatId) return;
    setSwitchingSessionId(session.id);
    setSessionsError(null);
    try {
      const response = await fetch(
        `/api/agent/sessions/${encodeURIComponent(session.id)}/history`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const history = (await response.json()) as SessionHistory;
      const restoredMessages = messagesFromHistory(history.messages);
      const latestRun = history.latestRun;
      const persistedRun = latestRun
        ? {
            chatId: session.externalKey,
            runId: latestRun.id,
            chunkIndex: 0,
            messages: restoredMessages,
            pending: isPendingStatus(latestRun.status),
          }
        : null;

      await stop();
      clearError();
      if (persistedRun) writePersistedRun(persistedRun);
      else clearPersistedRun();
      setConversation({
        chatId: session.externalKey,
        messages: restoredMessages,
        projectId: history.session.projectId,
        resumeRun: persistedRun?.pending ? persistedRun : null,
      });
      setInput('');
      setSuggestions([]);
      setTrace(initialTrace);
      setDismissedCards(new Set());
      setPendingInterrupt(null);
      setAgentTodos([]);
      setInteractionError(null);
      sessionRef.current = new ResilientSession();
    } catch {
      setSessionsError('无法打开这条历史记录');
    } finally {
      setSwitchingSessionId(null);
    }
  }

  async function submitText(value: string) {
    const trimmed = value.trim();
    if (!trimmed || isBusy || error) return;
    setInput('');
    setSuggestions([]);
    sessionRef.current.addUserMessage(trimmed);
    setTrace([
      localEvent('request', 'running', '正在提交新消息', 'useChat 已锁定输入并创建请求'),
    ]);
    await sendMessage({ text: trimmed });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitText(input);
  }

  async function handleRetry() {
    setTrace((current) => [
      ...current.slice(-9),
      localEvent('retry', 'running', '重新生成已启动', '从干净的会话检查点再次执行'),
    ]);
    await reload();
  }

  async function stopCurrentConversation() {
    const currentRun = readPersistedRun();
    if (currentRun?.pending) {
      await fetch(
        `/api/agent/runs/${encodeURIComponent(currentRun.runId)}/cancel`,
        { method: 'POST' },
      ).catch(() => null);
    }
    await stop();
  }

  function resetConversation(chatId: string, projectId: string | null) {
    clearError();
    clearPersistedRun();
    setConversation({
      chatId,
      messages: [],
      projectId,
      resumeRun: null,
    });
    setInput('');
    setSuggestions([]);
    setTrace(initialTrace);
    setDismissedCards(new Set());
    setPendingInterrupt(null);
    setAgentTodos([]);
    setInteractionError(null);
    sessionRef.current = new ResilientSession();
  }

  function handleNewChat() {
    dialogReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setSessionMenuId(null);
    setProjectDialogError(null);
    setProjectDialogOpen(true);
  }

  async function createSession(projectId: string | null) {
    setProjectDialogBusy(true);
    setProjectDialogError(null);
    const externalKey = crypto.randomUUID();
    try {
      const response = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalKey,
          projectId: projectId ?? undefined,
          title: '新会话',
        }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, '新建会话失败'));
      }
      await stopCurrentConversation();
      resetConversation(externalKey, projectId);
      setProjectDialogOpen(false);
      setNotice('已创建全新的隔离会话');
      await refreshSessions();
    } catch (caught) {
      setProjectDialogError(
        caught instanceof Error ? caught.message : '新建会话失败',
      );
    } finally {
      setProjectDialogBusy(false);
    }
  }

  async function createGitProject(input: {
    name: string;
    repositoryUrl: string;
    ref?: string;
  }) {
    setProjectDialogBusy(true);
    setProjectDialogError(null);
    try {
      const response = await fetch('/api/agent/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          source: {
            type: 'git',
            url: input.repositoryUrl,
            ref: input.ref || undefined,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, '创建仓库项目失败'));
      }
      const project = (await response.json()) as ProjectSummary;
      setProjects((current) => [project, ...current]);
      setProjectDialogBusy(false);
      await createSession(project.id);
    } catch (caught) {
      setProjectDialogError(
        caught instanceof Error ? caught.message : '创建仓库项目失败',
      );
      setProjectDialogBusy(false);
    }
  }

  async function createUploadProject(name: string, files: File[]) {
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > projectUploadMaxBytes) {
      setProjectDialogError('上传内容不能超过 20 MB');
      return;
    }
    setProjectDialogBusy(true);
    setProjectDialogError(null);
    try {
      const relativePaths = files.map((file) => file.webkitRelativePath || file.name);
      const rootDirectory = relativePaths[0]?.split('/')[0];
      const stripRoot = Boolean(
        rootDirectory &&
          relativePaths.every((path) => path.startsWith(`${rootDirectory}/`)),
      );
      const encodedFiles = await Promise.all(
        files.map(async (file, index) => ({
          path: stripRoot
            ? relativePaths[index]!.slice(rootDirectory!.length + 1)
            : relativePaths[index]!,
          contentBase64: await fileToBase64(file),
        })),
      );
      const response = await fetch('/api/agent/projects/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, files: encodedFiles }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, '上传项目失败'));
      }
      const project = (await response.json()) as ProjectSummary;
      setProjects((current) => [project, ...current]);
      setProjectDialogBusy(false);
      await createSession(project.id);
    } catch (caught) {
      setProjectDialogError(
        caught instanceof Error ? caught.message : '上传项目失败',
      );
      setProjectDialogBusy(false);
    }
  }

  async function loadMoreSessions() {
    if (!sessionsNextCursor || loadingMoreSessions) return;
    setLoadingMoreSessions(true);
    try {
      const page = await fetchSessionPage(sessionsNextCursor);
      setSessions((current) => {
        const known = new Set(current.map((session) => session.id));
        return [
          ...current,
          ...page.data.filter((session) => !known.has(session.id)),
        ];
      });
      setSessionsNextCursor(page.nextCursor);
      setSessionsError(null);
    } catch {
      setSessionsError('更多历史记录加载失败');
    } finally {
      setLoadingMoreSessions(false);
    }
  }

  async function renameSession(title: string) {
    if (!sessionDialog || sessionDialog.kind !== 'rename') return;
    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      const response = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sessionDialog.session.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response, '重命名失败'));
      }
      const updated = (await response.json()) as WebSessionSummary;
      setSessions((current) =>
        current.map((session) => (session.id === updated.id ? updated : session)),
      );
      setSessionDialog(null);
      setNotice('会话名称已更新');
    } catch (caught) {
      setSessionDialogError(
        caught instanceof Error ? caught.message : '重命名失败',
      );
    } finally {
      setSessionDialogBusy(false);
    }
  }

  async function deleteSession() {
    if (!sessionDialog || sessionDialog.kind !== 'delete') return;
    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      const response = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sessionDialog.session.id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(
            response,
            response.status === 409 ? '运行中的会话不能删除' : '删除失败',
          ),
        );
      }
      const deleted = sessionDialog.session;
      setSessions((current) =>
        current.filter((session) => session.id !== deleted.id),
      );
      if (deleted.externalKey === conversation.chatId) {
        await stopCurrentConversation();
        resetConversation(crypto.randomUUID(), null);
      }
      setSessionDialog(null);
      setNotice('会话已删除');
    } catch (caught) {
      setSessionDialogError(
        caught instanceof Error ? caught.message : '删除失败',
      );
    } finally {
      setSessionDialogBusy(false);
    }
  }

  async function respondToInterrupt(
    interrupt: PendingInterrupt,
    body: { decision: 'approve' | 'reject'; message?: string } | QuestionAnswer,
  ) {
    setInteractionBusy(true);
    setInteractionError(null);
    const segment =
      interrupt.type === 'approval.required' ? 'approvals' : 'questions';
    try {
      const response = await fetch(
        `/api/agent/runs/${encodeURIComponent(interrupt.runId)}/${segment}/${encodeURIComponent(interrupt.interruptId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      setPendingInterrupt(null);
      setTrace((current) => [
        ...current.slice(-11),
        localEvent(
          'request',
          'running',
          '已提交人工响应',
          '任务已重新进入 Worker 队列',
        ),
      ]);
    } catch (caught) {
      setInteractionError(
        caught instanceof Error ? caught.message : '提交失败，请稍后重试',
      );
    } finally {
      setInteractionBusy(false);
    }
  }

  async function handleStop() {
    const currentRun = readPersistedRun();
    if (!currentRun?.runId) {
      await stop();
      return;
    }
    try {
      const response = await fetch(
        `/api/agent/runs/${encodeURIComponent(currentRun.runId)}/cancel`,
        { method: 'POST' },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
      }
      setTrace((current) => [
        ...current.slice(-11),
        localEvent('transport', 'warning', '正在取消运行', '取消信号已发送至 Worker'),
      ]);
      if (response.status === 404) await stop();
    } catch {
      await stop();
    }
  }

  async function copyMessage(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedMessage(id);
    window.setTimeout(() => setCopiedMessage(null), 1400);
  }

  return (
    <main
      className={`app-shell ${traceOpen ? 'is-trace-open' : ''} ${sidebarOpen ? 'is-sidebar-open' : ''}`}
    >
      <Sidebar
        activeChatId={conversation.chatId}
        busy={isBusy}
        error={sessionsError}
        loaded={sessionsLoaded}
        hasMore={Boolean(sessionsNextCursor)}
        loadingMore={loadingMoreSessions}
        menuSessionId={sessionMenuId}
        inactive={projectDialogOpen || Boolean(sessionDialog)}
        onDelete={(session) => {
          dialogReturnFocusRef.current = document.activeElement
            ?.closest('.session-item')
            ?.querySelector<HTMLElement>('.session-more') ?? null;
          setSessionMenuId(null);
          setSessionDialogError(null);
          setSessionDialog({ kind: 'delete', session });
        }}
        onLoadMore={() => void loadMoreSessions()}
        onMenu={setSessionMenuId}
        onClose={() => setSidebarOpen(false)}
        onNewChat={() => {
          setSidebarOpen(false);
          handleNewChat();
        }}
        onRename={(session) => {
          dialogReturnFocusRef.current = document.activeElement
            ?.closest('.session-item')
            ?.querySelector<HTMLElement>('.session-more') ?? null;
          setSessionMenuId(null);
          setSessionDialogError(null);
          setSessionDialog({ kind: 'rename', session });
        }}
        onRefresh={() => void refreshSessions()}
        onSelect={(session) => {
          setSidebarOpen(false);
          void selectSession(session);
        }}
        sessions={sessions}
        open={sidebarOpen}
        switchingSessionId={switchingSessionId}
      />

      {sidebarOpen && (
        <button
          aria-label="关闭历史对话"
          className="sidebar-scrim"
          type="button"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <section
        className="chat-column"
        inert={
          sidebarOpen || projectDialogOpen || Boolean(sessionDialog)
            ? true
            : undefined
        }
      >
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="mobile-icon-button"
              ref={mobileMenuButtonRef}
              type="button"
              aria-label="打开历史对话"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <div>
              <div className="title-line">
                <h1>AI Coding Agent</h1>
                <span className="local-badge">NODE AGENT</span>
              </div>
            </div>
          </div>
          <div className="topbar-actions">
            <span className={`connection-pill ${isBusy ? 'is-busy' : ''}`}>
              <span className="status-dot" />
              {status === 'streaming'
                ? '正在流式生成'
                : status === 'submitted'
                  ? '正在建立连接'
                  : error
                    ? '等待恢复'
                    : '全部系统正常'}
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label={traceOpen ? '隐藏 Agent 运行轨迹' : '显示 Agent 运行轨迹'}
              aria-expanded={traceOpen}
              onClick={() => setTraceOpen((current) => !current)}
            >
              <Icon name="panel" />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="新建对话"
              onClick={handleNewChat}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        <div className="conversation" aria-live="polite">
          {!hasConversation ? (
            <Welcome project={currentProject} onPrompt={submitText} />
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <Message
                  copied={copiedMessage === message.id}
                  dismissedCards={dismissedCards}
                  key={message.id}
                  message={message}
                  onBoundaryError={() => {
                    setTrace((current) => [
                      ...current.slice(-9),
                      localEvent(
                        'verify',
                        'warning',
                        'AIBoundary 已隔离组件崩溃',
                        '聊天主体保持可用，错误载荷已进入脱敏流程',
                      ),
                    ]);
                  }}
                  onCopy={copyMessage}
                  onDismissCard={(messageId) => {
                    setDismissedCards((current) =>
                      new Set(current).add(messageId),
                    );
                  }}
                />
              ))}
              {status === 'submitted' && !hasAssistantPlaceholder && <ThinkingRow />}
              {agentTodos.length > 0 && <AgentTodoList todos={agentTodos} />}
              {pendingInterrupt && (
                <PendingInteraction
                  key={pendingInterrupt.interruptId}
                  busy={interactionBusy}
                  error={interactionError}
                  interrupt={pendingInterrupt}
                  onApproval={(decision) =>
                    respondToInterrupt(pendingInterrupt, { decision })
                  }
                  onQuestion={(answer) =>
                    respondToInterrupt(pendingInterrupt, answer)
                  }
                />
              )}
              {error && (
                <div className="error-banner" role="alert">
                  <div className="error-icon">
                    <Icon name="triangle" size={19} />
                  </div>
                  <div>
                    <strong>响应中断，历史已回退</strong>
                    <p>{friendlyError(error)}</p>
                  </div>
                  <button type="button" onClick={() => void handleRetry()}>
                    <Icon name="refresh" size={16} />
                    重新生成
                  </button>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <Composer
          disabled={Boolean(error)}
          input={input}
          isBusy={isBusy}
          onChange={setInput}
          onStop={() => void handleStop()}
          onSubmit={handleSubmit}
          onSuggestion={submitText}
          suggestions={suggestions}
        />

      </section>

      <TracePanel
        inactive={sidebarOpen || projectDialogOpen || Boolean(sessionDialog)}
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        trace={trace}
      />

      {projectDialogOpen && (
        <ProjectDialog
          busy={projectDialogBusy}
          error={projectDialogError}
          loaded={projectsLoaded}
          projects={projects}
          onBlank={() => void createSession(null)}
          onClose={() => {
            if (!projectDialogBusy) setProjectDialogOpen(false);
          }}
          onGit={(input) => void createGitProject(input)}
          onSelect={(project) => void createSession(project.id)}
          onUpload={(name, files) => void createUploadProject(name, files)}
        />
      )}

      {sessionDialog && (
        <SessionActionDialog
          busy={sessionDialogBusy}
          dialog={sessionDialog}
          error={sessionDialogError}
          onClose={() => {
            if (!sessionDialogBusy) setSessionDialog(null);
          }}
          onDelete={() => void deleteSession()}
          onRename={(title) => void renameSession(title)}
        />
      )}

      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {notice}
        </div>
      )}
    </main>
  );
}

function Sidebar({
  activeChatId,
  busy,
  error,
  hasMore,
  inactive,
  loaded,
  loadingMore,
  menuSessionId,
  onDelete,
  onClose,
  onLoadMore,
  onMenu,
  onNewChat,
  onRename,
  onRefresh,
  onSelect,
  open,
  sessions,
  switchingSessionId,
}: {
  activeChatId: string;
  busy: boolean;
  error: string | null;
  hasMore: boolean;
  inactive: boolean;
  loaded: boolean;
  loadingMore: boolean;
  menuSessionId: string | null;
  onDelete: (session: WebSessionSummary) => void;
  onClose: () => void;
  onLoadMore: () => void;
  onMenu: (sessionId: string | null) => void;
  onNewChat: () => void;
  onRename: (session: WebSessionSummary) => void;
  onRefresh: () => void;
  onSelect: (session: WebSessionSummary) => void;
  open: boolean;
  sessions: WebSessionSummary[];
  switchingSessionId: string | null;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  return (
    <aside className="sidebar" inert={inactive || undefined}>
      <div className="brand">
        <span className="brand-mark">
          <Icon name="layers" size={20} />
        </span>
        <span>
          <strong>Keen Agent</strong>
        </span>
        <button
          aria-label="关闭历史对话"
          className="sidebar-close"
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
        >
          <Icon name="x" size={18} />
        </button>
      </div>

      <button
        aria-label="新建对话"
        className="new-chat-button"
        type="button"
        onClick={onNewChat}
      >
        <Icon name="plus" size={17} />
        <span>新建对话</span>
      </button>

      <nav aria-label="历史对话" className="session-nav">
        {!loaded && <p className="session-list-status">正在加载历史记录…</p>}
        {loaded && error && (
          <button className="session-list-retry" type="button" onClick={onRefresh}>
            {error}，重新加载
          </button>
        )}
        {loaded && !error && sessions.length === 0 && (
          <p className="session-list-status">还没有历史对话</p>
        )}
        {sessions.map((session) => {
          const active = session.externalKey === activeChatId;
          const switching = switchingSessionId === session.id;
          const menuOpen = menuSessionId === session.id;
          return (
            <div
              className={active ? 'session-item is-active' : 'session-item'}
              key={session.id}
            >
              <button
                aria-current={active ? 'page' : undefined}
                aria-label={`打开对话：${session.title}`}
                className="session-main"
                disabled={busy || switchingSessionId !== null}
                type="button"
                onClick={() => onSelect(session)}
              >
                <span className="session-icon">
                  <Icon name="shield" size={16} />
                </span>
                <span className="session-copy">
                  <strong>{session.title}</strong>
                  <small>
                    {switching
                      ? '正在载入…'
                      : formatSessionTime(session.updatedAt)}
                  </small>
                </span>
              </button>
              <button
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={`管理对话：${session.title}`}
                className="session-more"
                type="button"
                onClick={() => onMenu(menuOpen ? null : session.id)}
              >
                <Icon name="more" size={17} />
              </button>
              {menuOpen && (
                <div className="session-menu" role="menu">
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => onRename(session)}
                  >
                    <Icon name="edit" size={15} />
                    重命名
                  </button>
                  <button
                    className="is-danger"
                    role="menuitem"
                    type="button"
                    onClick={() => onDelete(session)}
                  >
                    <Icon name="trash" size={15} />
                    删除
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {loaded && !error && hasMore && (
          <button
            className="load-more-button"
            disabled={loadingMore}
            type="button"
            onClick={onLoadMore}
          >
            {loadingMore ? '正在加载…' : '加载更多'}
          </button>
        )}
      </nav>

      <div className="system-card">
        <div className="system-card-head">
          <span className="status-dot" />
          <strong>Services connected</strong>
        </div>
        <p>API · Queue · Worker · Storage</p>
        <div className="protection-meter">
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function Welcome({
  onPrompt,
  project,
}: {
  onPrompt: (prompt: string) => Promise<void>;
  project: ProjectSummary | null;
}) {
  return (
    <section className="welcome">
      <div className="welcome-symbol">
        <span className="symbol-ring ring-one" />
        <span className="symbol-ring ring-two" />
        <span className="symbol-core">
          <Icon name="shield" size={31} />
        </span>
      </div>
      <span className="project-context">
        <Icon name={project?.sourceType === 'git' ? 'git' : 'folder'} size={14} />
        {project?.name ?? '空白工作区'}
      </span>
      <h2>让 Agent 在你的项目里工作</h2>
      <p>
        Web 通过 Node API 创建持久化运行，Worker 在隔离工作区中调用 coding
        agent。执行命令或改文件前，会在这里等待你的审批。
      </p>

      <div className="prompt-grid">
        {starterPrompts.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => void onPrompt(item.prompt)}
          >
            <span className="prompt-icon">
              <Icon name={item.icon} />
            </span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        ))}
      </div>
    </section>
  );
}

function ProjectDialog({
  busy,
  error,
  loaded,
  onBlank,
  onClose,
  onGit,
  onSelect,
  onUpload,
  projects,
}: {
  busy: boolean;
  error: string | null;
  loaded: boolean;
  onBlank: () => void;
  onClose: () => void;
  onGit: (input: {
    name: string;
    repositoryUrl: string;
    ref?: string;
  }) => void;
  onSelect: (project: ProjectSummary) => void;
  onUpload: (name: string, files: File[]) => void;
  projects: ProjectSummary[];
}) {
  const [mode, setMode] = useState<'existing' | 'git' | 'upload'>('existing');
  const [projectName, setProjectName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [repositoryRef, setRepositoryRef] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);

  return (
    <div className="modal-layer">
      <button
        aria-label="关闭新建对话窗口"
        className="modal-scrim"
        disabled={busy}
        type="button"
        onClick={onClose}
      />
      <section
        aria-labelledby="project-dialog-title"
        aria-modal="true"
        className="modal-card project-dialog"
        role="dialog"
      >
        <header className="modal-head">
          <div>
            <span>NEW SESSION</span>
            <h2 id="project-dialog-title">选择这次对话使用的项目</h2>
            <p>每条会话都会获得独立的 workspace，项目内容会由 Worker 安全载入。</p>
          </div>
          <button
            aria-label="关闭"
            autoFocus={mode === 'existing'}
            className="modal-close"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="dialog-tabs" role="tablist" aria-label="项目来源">
          {([
            ['existing', '已有项目'],
            ['git', 'Git 仓库'],
            ['upload', '本地上传'],
          ] as const).map(([value, label]) => (
            <button
              aria-selected={mode === value}
              className={mode === value ? 'is-active' : ''}
              disabled={busy}
              key={value}
              role="tab"
              type="button"
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'existing' && (
          <div className="project-list" role="tabpanel">
            <button
              className="project-option"
              disabled={busy}
              type="button"
              onClick={onBlank}
            >
              <span className="project-option-icon"><Icon name="folder" /></span>
              <span><strong>空白工作区</strong><small>从一个干净目录开始</small></span>
              <Icon name="chevron" size={16} />
            </button>
            {!loaded && <p className="dialog-status">正在加载项目…</p>}
            {loaded && projects.length === 0 && (
              <p className="dialog-status">还没有保存的项目，可从 Git 或本地创建。</p>
            )}
            {projects.map((project) => (
              <button
                className="project-option"
                disabled={busy}
                key={project.id}
                type="button"
                onClick={() => onSelect(project)}
              >
                <span className="project-option-icon">
                  <Icon name={project.sourceType === 'git' ? 'git' : 'upload'} />
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>
                    {project.sourceType === 'git'
                      ? project.sourceRef
                      : project.sourceType === 'upload'
                        ? '已上传的项目快照'
                        : '空白项目'}
                  </small>
                </span>
                <Icon name="chevron" size={16} />
              </button>
            ))}
          </div>
        )}

        {mode === 'git' && (
          <form
            className="dialog-form"
            role="tabpanel"
            onSubmit={(event) => {
              event.preventDefault();
              onGit({
                name: projectName.trim(),
                repositoryUrl: repositoryUrl.trim(),
                ref: repositoryRef.trim() || undefined,
              });
            }}
          >
            <label>
              项目名称
              <input
                autoFocus
                disabled={busy}
                maxLength={120}
                placeholder="例如：官网前端"
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            <label>
              HTTPS 仓库地址
              <input
                disabled={busy}
                inputMode="url"
                placeholder="https://github.com/org/repository.git"
                required
                type="url"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
              />
            </label>
            <label>
              分支或 Tag <span>可选</span>
              <input
                disabled={busy}
                placeholder="main"
                value={repositoryRef}
                onChange={(event) => setRepositoryRef(event.target.value)}
              />
            </label>
            <p className="form-help">首次运行时由 Worker 浅克隆公开仓库，不接受地址中的账号或密码。</p>
            <button className="primary-action dialog-submit" disabled={busy} type="submit">
              {busy ? '正在创建…' : '创建项目并开始对话'}
            </button>
          </form>
        )}

        {mode === 'upload' && (
          <form
            className="dialog-form"
            role="tabpanel"
            onSubmit={(event) => {
              event.preventDefault();
              onUpload(projectName.trim(), uploadFiles);
            }}
          >
            <label>
              项目名称
              <input
                autoFocus
                disabled={busy}
                maxLength={120}
                placeholder="例如：本地演示项目"
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            <label className="upload-field">
              选择项目文件夹
              <input
                disabled={busy}
                multiple
                required
                type="file"
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={(event) =>
                  setUploadFiles(Array.from(event.target.files ?? []))
                }
              />
              <span>
                <Icon name="upload" size={19} />
                {uploadFiles.length > 0
                  ? `已选择 ${uploadFiles.length} 个文件`
                  : '选择一个不超过 20 MB 的目录'}
              </span>
            </label>
            <p className="form-help">文件将保存为项目快照，并在会话的隔离 workspace 中恢复。</p>
            <button
              className="primary-action dialog-submit"
              disabled={busy || uploadFiles.length === 0}
              type="submit"
            >
              {busy ? '正在上传…' : '上传并开始对话'}
            </button>
          </form>
        )}

        {error && <p className="dialog-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function SessionActionDialog({
  busy,
  dialog,
  error,
  onClose,
  onDelete,
  onRename,
}: {
  busy: boolean;
  dialog: SessionDialog;
  error: string | null;
  onClose: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [title, setTitle] = useState(dialog.session.title);
  const deleting = dialog.kind === 'delete';

  return (
    <div className="modal-layer">
      <button
        aria-label="关闭会话操作窗口"
        className="modal-scrim"
        disabled={busy}
        type="button"
        onClick={onClose}
      />
      <section
        aria-labelledby="session-dialog-title"
        aria-modal="true"
        className="modal-card session-dialog"
        role="dialog"
      >
        <header className="modal-head">
          <div>
            <span>{deleting ? 'DELETE SESSION' : 'RENAME SESSION'}</span>
            <h2 id="session-dialog-title">
              {deleting ? '删除这条会话？' : '重命名会话'}
            </h2>
          </div>
          <button
            aria-label="关闭"
            autoFocus={deleting}
            className="modal-close"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        {deleting ? (
          <p className="delete-copy">
            “{dialog.session.title}” 将从历史记录中移除。正在运行的会话需要先停止，避免丢失进行中的结果。
          </p>
        ) : (
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              onRename(title.trim());
            }}
          >
            <label>
              会话名称
              <input
                autoFocus
                disabled={busy}
                maxLength={120}
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button className="secondary-action" disabled={busy} type="button" onClick={onClose}>
                取消
              </button>
              <button className="primary-action" disabled={busy || !title.trim()} type="submit">
                {busy ? '正在保存…' : '保存'}
              </button>
            </div>
          </form>
        )}

        {deleting && (
          <div className="dialog-actions">
            <button className="secondary-action" disabled={busy} type="button" onClick={onClose}>
              取消
            </button>
            <button className="danger-action" disabled={busy} type="button" onClick={onDelete}>
              {busy ? '正在删除…' : '确认删除'}
            </button>
          </div>
        )}
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function Message({
  copied,
  dismissedCards,
  message,
  onBoundaryError,
  onCopy,
  onDismissCard,
}: {
  copied: boolean;
  dismissedCards: Set<string>;
  message: ResilientMessage;
  onBoundaryError: () => void;
  onCopy: (id: string, text: string) => Promise<void>;
  onDismissCard: (id: string) => void;
}) {
  const text = messageText(message);
  const cards = message.parts.filter((part) => part.type === 'data-card');
  const isUser = message.role === 'user';

  return (
    <article className={`message-row ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="avatar">
        <Icon name={isUser ? 'user' : 'shield'} size={17} />
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{isUser ? '你' : 'Coding Agent'}</strong>
          {!isUser && message.metadata?.model && (
            <span>{message.metadata.model}</span>
          )}
        </div>
        <div className={`message-copy ${isUser ? '' : 'markdown-content'}`}>
          {text ? (
            isUser ? (
              text
            ) : (
              <MarkdownContent content={text} />
            )
          ) : (
            <StreamingDots />
          )}
        </div>

        {!isUser && !dismissedCards.has(message.id) &&
          cards.map((part, index) =>
            part.data ? (
              <AIBoundary
                key={`${message.id}-card-${index}`}
                mode="manual"
                title="AI 组件渲染失败"
                description="模型返回了无效的组件结构，已安全降级；聊天内容不受影响。"
                rawPayload={part.data}
                showRawData={false}
                onError={onBoundaryError}
                onReset={() => onDismissCard(message.id)}
              >
                <GeneratedInsightCard data={part.data} />
              </AIBoundary>
            ) : null,
          )}

        {!isUser && text && (
          <div className="message-actions">
            <button
              type="button"
              onClick={() => void onCopy(message.id, text)}
            >
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function GeneratedInsightCard({ data }: { data: InsightCard }) {
  if (data.kind !== 'reliability-summary') {
    return null;
  }

  return (
    <section className="insight-card" aria-label={data.title}>
      <div>
        <span>{data.eyebrow}</span>
        <h3>{data.title}</h3>
        <p>{data.body}</p>
      </div>
      <div className="insight-metric">
        <strong>{data.metric}</strong>
        <small>{data.metric_label}</small>
      </div>
    </section>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} rel="noreferrer" target="_blank">
            {children}
          </a>
        ),
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function StreamingDots() {
  return (
    <span className="streaming-dots" aria-label="正在生成">
      <i />
      <i />
      <i />
    </span>
  );
}

function ThinkingRow() {
  return (
    <article className="message-row is-assistant thinking-row">
      <div className="avatar">
        <Icon name="shield" size={17} />
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>Coding Agent</strong>
          <span>正在等待 Worker 启动</span>
        </div>
        <StreamingDots />
      </div>
    </article>
  );
}

function AgentTodoList({ todos }: { todos: AgentTodo[] }) {
  return (
    <section className="agent-todos" aria-label="Agent 任务计划">
      <div className="agent-panel-head">
        <span className="eyebrow">TASK PLAN</span>
        <strong>
          {todos.filter((todo) => todo.status === 'completed').length}/
          {todos.length}
        </strong>
      </div>
      <ol>
        {todos.map((todo, index) => (
          <li className={`is-${todo.status}`} key={`${index}-${todo.content}`}>
            <span>
              {todo.status === 'completed' ? (
                <Icon name="check" size={12} />
              ) : todo.status === 'in_progress' ? (
                <span className="pulse-dot" />
              ) : (
                index + 1
              )}
            </span>
            {todo.content}
          </li>
        ))}
      </ol>
    </section>
  );
}

function PendingInteraction({
  busy,
  error,
  interrupt,
  onApproval,
  onQuestion,
}: {
  busy: boolean;
  error: string | null;
  interrupt: PendingInterrupt;
  onApproval: (decision: 'approve' | 'reject') => Promise<void>;
  onQuestion: (answer: QuestionAnswer) => Promise<void>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [customText, setCustomText] = useState('');

  if (interrupt.type === 'approval.required') {
    return (
      <section className="agent-interrupt" aria-label="等待操作审批">
        <div className="agent-panel-head">
          <span className="eyebrow">APPROVAL REQUIRED</span>
          <strong>{interrupt.actions.length} 项</strong>
        </div>
        <h3>Agent 准备执行以下操作</h3>
        <ul>
          {interrupt.actions.map((action, index) => (
            <li key={`${index}-${action.name}`}>
              <code>{action.name}</code>
              <span>{action.summary}</span>
            </li>
          ))}
        </ul>
        {error && <p className="interaction-error">{error}</p>}
        <div className="interaction-actions">
          <button
            className="secondary-action"
            disabled={busy}
            type="button"
            onClick={() => void onApproval('reject')}
          >
            拒绝
          </button>
          <button
            className="primary-action"
            disabled={busy}
            type="button"
            onClick={() => void onApproval('approve')}
          >
            {busy ? '正在提交…' : '批准并继续'}
          </button>
        </div>
      </section>
    );
  }

  const canSubmit = selected.length > 0 || customText.trim().length > 0;

  return (
    <section className="agent-interrupt" aria-label="等待问题回答">
      <div className="agent-panel-head">
        <span className="eyebrow">INPUT REQUIRED</span>
        <strong>{interrupt.question.multiple ? '可多选' : '单选'}</strong>
      </div>
      <h3>{interrupt.question.question}</h3>
      <div className="question-options">
        {interrupt.question.options.map((option, index) => {
          const active = selected.includes(index);
          return (
            <button
              aria-pressed={active}
              className={active ? 'is-selected' : ''}
              disabled={busy}
              key={`${index}-${option.label}`}
              type="button"
              onClick={() => {
                setSelected((current) =>
                  interrupt.question.multiple
                    ? current.includes(index)
                      ? current.filter((item) => item !== index)
                      : [...current, index]
                    : [index],
                );
              }}
            >
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </button>
          );
        })}
      </div>
      {interrupt.question.allowCustom && (
        <input
          className="custom-answer"
          disabled={busy}
          placeholder="或者输入自定义答案"
          value={customText}
          onChange={(event) => setCustomText(event.target.value)}
        />
      )}
      {error && <p className="interaction-error">{error}</p>}
      <div className="interaction-actions">
        <button
          className="primary-action"
          disabled={busy || !canSubmit}
          type="button"
          onClick={() => {
            const answer: QuestionAnswer = {
              selections: selected.map((index) => ({
                index,
                label: interrupt.question.options[index]?.label ?? '',
              })),
              ...(customText.trim() ? { customText: customText.trim() } : {}),
            };
            void onQuestion(answer);
          }}
        >
          {busy ? '正在提交…' : '提交并继续'}
        </button>
      </div>
    </section>
  );
}

function Composer({
  disabled,
  input,
  isBusy,
  onChange,
  onStop,
  onSubmit,
  onSuggestion,
  suggestions,
}: {
  disabled: boolean;
  input: string;
  isBusy: boolean;
  onChange: (value: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSuggestion: (suggestion: string) => Promise<void>;
  suggestions: string[];
}) {
  return (
    <div className="composer-wrap">
      {suggestions.length > 0 && !isBusy && !disabled && (
        <div className="suggestions" aria-label="推荐问题">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="chat-input">
          输入消息
        </label>
        <textarea
          id="chat-input"
          rows={1}
          value={input}
          disabled={disabled || isBusy}
          placeholder={disabled ? '请先重新生成失败的响应' : '描述要在项目中完成的任务…'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {isBusy ? (
          <button
            className="send-button is-stop"
            type="button"
            aria-label="停止生成"
            onClick={onStop}
          >
            <Icon name="square" size={17} />
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            aria-label="发送消息"
            disabled={disabled || !input.trim()}
          >
            <Icon name="arrow" size={18} />
          </button>
        )}
      </form>
    </div>
  );
}

function TracePanel({
  inactive,
  open,
  onClose,
  trace,
}: {
  inactive: boolean;
  open: boolean;
  onClose: () => void;
  trace: PipelineEvent[];
}) {
  return (
    <>
      {open && !inactive && (
        <button
          className="trace-scrim"
          type="button"
          aria-label="关闭可靠性轨迹"
          onClick={onClose}
        />
      )}
      <aside
        aria-hidden={!open}
        className={`trace-panel ${open ? 'is-open' : ''}`}
        inert={!open || inactive}
      >
        <div className="trace-head">
          <div>
            <span className="eyebrow">LIVE OBSERVABILITY</span>
            <h2>Agent 运行轨迹</h2>
          </div>
          <button
            className="icon-button trace-close-button"
            type="button"
            aria-label="关闭可靠性轨迹"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="trace-summary">
          <div>
            <span>事件流</span>
            <strong>DURABLE SSE</strong>
          </div>
          <div>
            <span>任务执行</span>
            <strong>QUEUED</strong>
          </div>
        </div>

        <ol className="trace-list">
          {trace.map((item, index) => (
            <li className={`trace-item is-${item.status}`} key={item.id}>
              <div className="trace-line">
                <span className="trace-node">
                  {item.status === 'success' ? (
                    <Icon name="check" size={12} />
                  ) : item.status === 'error' || item.status === 'warning' ? (
                    <Icon name="triangle" size={12} />
                  ) : (
                    <span className="pulse-dot" />
                  )}
                </span>
                {index < trace.length - 1 && <span className="trace-rail" />}
              </div>
              <div>
                <div className="trace-title">
                  <strong>{item.title}</strong>
                  <time>{item.timestamp}</time>
                </div>
                <p>{item.detail}</p>
                <code>{item.stage.toUpperCase()}</code>
              </div>
            </li>
          ))}
        </ol>

        <div className="model-chain">
          <span className="nav-label">模型降级链</span>
          {['primary model', 'fallback 1', 'fallback 2', 'fallback 3'].map(
            (model, index) => (
              <div key={model}>
                <span>{index + 1}</span>
                <code>{model}</code>
                {index === 0 && <small>PRIMARY</small>}
              </div>
            ),
          )}
        </div>
      </aside>
    </>
  );
}

function friendlyError(error: Error) {
  if (error.message.includes('503')) {
    return '上游服务暂时不可用。半截输出未写入历史，请点击“重新生成”继续。';
  }
  if (error.message.includes('404')) {
    return '上次的本地运行记录已过期，请新建对话后重试。';
  }
  return '连接未能安全完成。当前输入已锁定，可重新生成恢复。';
}
