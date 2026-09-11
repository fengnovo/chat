'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import { AIBoundary } from '@cognicatch/react';
import type { UIMessage } from 'ai';
import {
  type FormEvent,
  type ReactNode,
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
  model?: string;
  runId?: string;
};

type ResilientData = {
  pipeline: PipelineEvent;
  card: InsightCard | null;
  suggestions: string[];
};

type ResilientMessage = UIMessage<MessageMetadata, ResilientData>;

const starterPrompts = [
  {
    icon: 'shuffle' as const,
    label: '模型降级',
    description: '5 次重试后切换模型',
    prompt: '请演示模型降级和熔断',
  },
  {
    icon: 'braces' as const,
    label: 'JSON 修复',
    description: 'Catch → Teach → Fix',
    prompt: '请演示畸形 JSON 的 Reality Lock 修复',
  },
  {
    icon: 'triangle' as const,
    label: '错误恢复',
    description: 'undo 后重新生成',
    prompt: '请演示一次错误恢复',
  },
  {
    icon: 'panel' as const,
    label: '组件边界',
    description: '隔离生成式 UI 崩溃',
    prompt: '请演示组件渲染崩溃和 AIBoundary',
  },
];

const initialTrace: PipelineEvent[] = [
  {
    id: 'boot-transport',
    stage: 'transport',
    status: 'success',
    title: '可恢复传输已就绪',
    detail: '等待消息；断流后将从 offset 续传',
    timestamp: '--:--:--',
  },
  {
    id: 'boot-circuit',
    stage: 'circuit',
    status: 'success',
    title: '熔断器处于闭合状态',
    detail: '阈值 5 次失败 · 30 秒半开探测',
    timestamp: '--:--:--',
  },
  {
    id: 'boot-verify',
    stage: 'verify',
    status: 'success',
    title: 'Reality Lock 已加载',
    detail: 'ChatResponse schema 正在保护输出',
    timestamp: '--:--:--',
  },
];

type IconName =
  | 'arrow'
  | 'braces'
  | 'check'
  | 'chevron'
  | 'copy'
  | 'layers'
  | 'menu'
  | 'panel'
  | 'plus'
  | 'refresh'
  | 'shield'
  | 'shuffle'
  | 'square'
  | 'triangle'
  | 'user'
  | 'x';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="m5 12 7-7 7 7M12 5v14" />,
    braces: <path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2m8-16h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    copy: <><rect width="12" height="12" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    layers: <><path d="m12.83 2.18 8 4a1 1 0 0 1 0 1.79l-8 4a2 2 0 0 1-1.66 0l-8-4a1 1 0 0 1 0-1.79l8-4a2 2 0 0 1 1.66 0Z" /><path d="m22 12.5-9.17 4.59a2 2 0 0 1-1.66 0L2 12.5m20 5-9.17 4.59a2 2 0 0 1-1.66 0L2 17.5" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    panel: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M9 9h12" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 9a7 7 0 0 0-11.7-2.6L4 11m16 2-2.8 4.6A7 7 0 0 1 5.5 15" /></>,
    shield: <><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z" /><path d="m9 12 2 2 4-4" /></>,
    shuffle: <><path d="m18 14 4 4-4 4" /><path d="m18 2 4 4-4 4" /><path d="M2 18h1.4a8 8 0 0 0 6.7-3.6l3.8-5.8A8 8 0 0 1 20.6 5H22M2 6h1.9a8 8 0 0 1 6.7 3.6l.7 1" /></>,
    square: <rect width="12" height="12" x="6" y="6" rx="1" fill="currentColor" stroke="none" />,
    triangle: <><path d="M21.7 16 14 2.7a2.3 2.3 0 0 0-4 0L2.3 16A2.3 2.3 0 0 0 4.3 19h15.4a2.3 2.3 0 0 0 2-3Z" /><path d="M12 9v4m0 3h.01" /></>,
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
      <aside className="trace-panel skeleton-panel" />
    </main>
  );
}

function ChatRuntime({ initialRun }: { initialRun: PersistedRun | null }) {
  const [input, setInput] = useState('');
  const [trace, setTrace] = useState<PipelineEvent[]>(initialTrace);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [dismissedCards, setDismissedCards] = useState<Set<string>>(
    () => new Set(),
  );
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [mobileTraceOpen, setMobileTraceOpen] = useState(false);
  const [sessionStats, setSessionStats] = useState({
    revision: 0,
    messages: 0,
    canUndo: false,
  });
  const sessionRef = useRef(new ResilientSession());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(() => {
    return new WorkflowChatTransport<ResilientMessage>({
        api: '/api/chat',
        fetch: createTrackedFetch(),
        maxConsecutiveErrors: 3,
        initialStartIndex: initialRun?.chunkIndex ?? 0,
        prepareSendMessagesRequest: ({ id, messages, trigger }) => ({
          body: { messages, chat_id: id, trigger },
          headers: { 'Content-Type': 'application/json' },
        }),
        prepareReconnectToStreamRequest: ({ api }) => {
          const pendingRun =
            initialRun?.pending &&
            api.endsWith(`/${encodeURIComponent(initialRun.chatId)}/stream`)
              ? initialRun
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
        },
        onChatEnd: ({ chunkIndex }) => {
          const current = readPersistedRun();
          if (!current) return;
          writePersistedRun({ ...current, chunkIndex });
        },
      });
  }, [initialRun]);

  const {
    clearError,
    error,
    messages,
    regenerate: reload,
    sendMessage,
    setMessages,
    status,
    stop,
  } = useChat<ResilientMessage>({
    id: initialRun?.chatId,
    messages: (initialRun?.messages ?? []) as ResilientMessage[],
    resume: Boolean(initialRun?.pending && initialRun.runId),
    throttle: 24,
    transport,
    onData: (part) => {
      if (part.type === 'data-pipeline') {
        setTrace((current) => [...current.slice(-9), part.data]);
      }
      if (part.type === 'data-suggestions') {
        setSuggestions(part.data);
      }
    },
    onError: (caught) => {
      const rolledBack = sessionRef.current.rollbackAssistant();
      setSessionStats(sessionRef.current.stats);
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
        setSessionStats(sessionRef.current.stats);
      }
      if (isError) return;

      const persisted = readPersistedRun();
      const runId = message.metadata?.runId ?? persisted?.runId ?? '';
      if (runId) {
        writePersistedRun({
          chatId: initialRun?.chatId ?? persisted?.chatId ?? '',
          runId,
          chunkIndex: persisted?.chunkIndex ?? 0,
          messages: finishedMessages,
          pending: false,
        });
      }
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
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');

  useEffect(() => {
    if (status !== 'streaming' || !lastAssistant) return;
    sessionRef.current.stageAssistant(messageText(lastAssistant));
  }, [lastAssistant, status]);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    messagesEndRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [messages, error]);

  async function submitText(value: string) {
    const trimmed = value.trim();
    if (!trimmed || isBusy || error) return;
    setInput('');
    setSuggestions([]);
    sessionRef.current.addUserMessage(trimmed);
    setSessionStats(sessionRef.current.stats);
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

  function handleNewChat() {
    void stop();
    clearError();
    clearPersistedRun();
    setMessages([]);
    setInput('');
    setSuggestions([]);
    setTrace(initialTrace);
    setDismissedCards(new Set());
    sessionRef.current = new ResilientSession();
    setSessionStats(sessionRef.current.stats);
  }

  async function copyMessage(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedMessage(id);
    window.setTimeout(() => setCopiedMessage(null), 1400);
  }

  const persisted = typeof window === 'undefined' ? null : readPersistedRun();

  return (
    <main className="app-shell">
      <Sidebar
        active={hasConversation}
        onNewChat={handleNewChat}
        sessionStats={sessionStats}
      />

      <section className="chat-column">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="mobile-icon-button"
              type="button"
              aria-label="打开可靠性轨迹"
              aria-expanded={mobileTraceOpen}
              onClick={() => setMobileTraceOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <div>
              <div className="title-line">
                <h1>AI Support Copilot</h1>
                <span className="local-badge">LOCAL DEMO</span>
              </div>
              <p>Resilient streaming workspace</p>
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
              aria-label="新建对话"
              onClick={handleNewChat}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        <div className="conversation" aria-live="polite">
          {!hasConversation ? (
            <Welcome onPrompt={submitText} />
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
              {status === 'submitted' && <ThinkingRow />}
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
          onStop={() => void stop()}
          onSubmit={handleSubmit}
          onSuggestion={submitText}
          suggestions={suggestions}
        />

        <div className="persistence-strip">
          <span>
            <Icon name="shield" size={14} />
            会话已由 Conversationalist 保护
          </span>
          <code>
            {persisted?.runId
              ? `run ${persisted.runId.slice(0, 8)} · offset ${persisted.chunkIndex}`
              : '等待首个 workflow run'}
          </code>
        </div>
      </section>

      <TracePanel
        mobileOpen={mobileTraceOpen}
        onClose={() => setMobileTraceOpen(false)}
        trace={trace}
      />
    </main>
  );
}

function Sidebar({
  active,
  onNewChat,
  sessionStats,
}: {
  active: boolean;
  onNewChat: () => void;
  sessionStats: { revision: number; messages: number; canUndo: boolean };
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="layers" size={20} />
        </span>
        <span>
          <strong>Resilient</strong>
          <small>AI RELIABILITY LAB</small>
        </span>
      </div>

      <button className="new-chat-button" type="button" onClick={onNewChat}>
        <Icon name="plus" size={17} />
        <span>新建对话</span>
      </button>

      <nav aria-label="对话列表" className="session-nav">
        <span className="nav-label">工作区</span>
        <button
          className={active ? 'session-item is-active' : 'session-item'}
          type="button"
        >
          <span className="session-icon">
            <Icon name="shield" size={16} />
          </span>
          <span>
            <strong>{active ? '当前可靠会话' : '等待第一条消息'}</strong>
            <small>{active ? '刚刚更新' : '本地演示'}</small>
          </span>
          <Icon name="chevron" size={15} />
        </button>
      </nav>

      <div className="sidebar-spacer" />

      <div className="session-stats">
        <div>
          <span>STATE REVISION</span>
          <strong>{String(sessionStats.revision).padStart(2, '0')}</strong>
        </div>
        <div>
          <span>SAFE MESSAGES</span>
          <strong>{String(sessionStats.messages).padStart(2, '0')}</strong>
        </div>
      </div>

      <div className="system-card">
        <div className="system-card-head">
          <span className="status-dot" />
          <strong>Protection active</strong>
        </div>
        <p>6 个可靠性保护层已连接</p>
        <div className="protection-meter">
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function Welcome({ onPrompt }: { onPrompt: (prompt: string) => Promise<void> }) {
  return (
    <section className="welcome">
      <div className="welcome-symbol">
        <span className="symbol-ring ring-one" />
        <span className="symbol-ring ring-two" />
        <span className="symbol-core">
          <Icon name="shield" size={31} />
        </span>
      </div>
      <span className="eyebrow">FAULT-TOLERANT BY DESIGN</span>
      <h2>故障不会打断对话</h2>
      <p>
        这不是一张静态架构图。发送任意消息，右侧会实时展示重试、熔断、
        模型降级、结构校验与断点续传的实际执行轨迹。
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
          <strong>{isUser ? '你' : 'Resilient Copilot'}</strong>
          {!isUser && message.metadata?.model && (
            <span>{message.metadata.model}</span>
          )}
        </div>
        <div className="message-copy">{text || <StreamingDots />}</div>

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
    throw new Error('Unsupported generative UI widget');
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
          <strong>Resilient Copilot</strong>
          <span>正在执行保护管线</span>
        </div>
        <StreamingDots />
      </div>
    </article>
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
          placeholder={disabled ? '请先重新生成失败的响应' : '输入消息，或选择上方的故障演练…'}
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
      <p>Enter 发送 · Shift + Enter 换行 · 所有模型调用均为本地模拟</p>
    </div>
  );
}

function TracePanel({
  mobileOpen,
  onClose,
  trace,
}: {
  mobileOpen: boolean;
  onClose: () => void;
  trace: PipelineEvent[];
}) {
  return (
    <>
      {mobileOpen && (
        <button
          className="trace-scrim"
          type="button"
          aria-label="关闭可靠性轨迹"
          onClick={onClose}
        />
      )}
      <aside className={`trace-panel ${mobileOpen ? 'is-open' : ''}`}>
        <div className="trace-head">
          <div>
            <span className="eyebrow">LIVE OBSERVABILITY</span>
            <h2>可靠性轨迹</h2>
          </div>
          <button
            className="mobile-icon-button"
            type="button"
            aria-label="关闭可靠性轨迹"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="trace-summary">
          <div>
            <span>传输</span>
            <strong>RESUMABLE</strong>
          </div>
          <div>
            <span>输出锁</span>
            <strong>ENFORCED</strong>
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
          <span className="nav-label">降级模型链</span>
          {['gpt-4o', 'claude-sonnet-4', 'gpt-4o-mini', 'claude-3-5-haiku'].map(
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
