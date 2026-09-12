import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  clearPersistedRun,
  type PersistedRun,
  readPersistedRun,
  writePersistedRun,
} from '@/app/lib/persistence';
import { ResilientSession } from '@/app/lib/session';

import { fetchSessionPage, responseError } from './api';
import { Composer } from './composer';
import { initialTrace } from './constants';
import { agentEventToTrace, createTrackedFetch, localEvent } from './events';
import { TaskFailureNotice, friendlyError } from './failure-notice';
import { Icon } from './icon';
import { AgentTodoList, Message, ThinkingRow } from './message';
import { PendingInteraction } from './pending-interaction';
import { SessionActionDialog } from './session-dialog';
import { Sidebar } from './sidebar';
import { TracePanel } from './trace-panel';
import type {
  AgentTodo,
  ConversationSeed,
  PendingInterrupt,
  PipelineEvent,
  QuestionAnswer,
  ResilientMessage,
  SessionDialog,
  SessionHistory,
  TaskFailure,
  WebSessionSummary,
} from './types';
import {
  failureFromRun,
  isPendingStatus,
  messageText,
  messagesFromHistory,
} from './utils';
import { Welcome } from './welcome';

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

function ChatRuntime({
  initialFailure,
  initialRun,
}: {
  initialFailure: TaskFailure | null;
  initialRun: PersistedRun | null;
}) {
  const [conversation, setConversation] = useState<ConversationSeed>(() => ({
    chatId: initialRun?.chatId ?? crypto.randomUUID(),
    messages: (initialRun?.messages ?? []) as ResilientMessage[],
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
  const [runFailure, setRunFailure] = useState<TaskFailure | null>(initialFailure);
  const [sessions, setSessions] = useState<WebSessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
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
            trigger,
          },
          headers: { 'Content-Type': 'application/json' },
        }),
        prepareReconnectToStreamRequest: ({ api }) => {
          const persistedRun = readPersistedRun();
          const pendingRun =
            persistedRun?.pending && persistedRun.chatId === conversation.chatId
              ? persistedRun
              : conversation.resumeRun?.pending
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
    conversation.resumeRun,
    refreshSessions,
  ]);

  const {
    clearError,
    error,
    messages,
    regenerate: reload,
    resumeStream,
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
        if (event.type === 'run.failed') {
          setRunFailure({ code: event.code, message: event.message });
        }
        if (event.type === 'run.completed' || event.type === 'run.cancelled') {
          setRunFailure(null);
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
      if (caught.message.includes('404')) {
        clearPersistedRun();
        setConversation((current) => ({ ...current, resumeRun: null }));
      }
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
    onFinish: ({
      finishReason,
      message,
      messages: finishedMessages,
      isAbort,
      isError,
    }) => {
      const text = messageText(message);
      const taskFailed = finishReason === 'error';
      if (!isError && !taskFailed && text) {
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
    if (sessionDialog || !dialogReturnFocusRef.current) {
      return;
    }
    const returnTarget = dialogReturnFocusRef.current;
    dialogReturnFocusRef.current = null;
    window.requestAnimationFrame(() => returnTarget.focus());
  }, [sessionDialog]);

  useEffect(() => {
    if (!sessionDialog && !sessionMenuId && !sidebarOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (sessionDialogBusy) return;
      setSessionDialog(null);
      setSessionMenuId(null);
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [
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
  }, [messages, error, pendingInterrupt, runFailure]);

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
        resumeRun: persistedRun?.pending ? persistedRun : null,
      });
      setInput('');
      setSuggestions([]);
      setTrace(initialTrace);
      setDismissedCards(new Set());
      setPendingInterrupt(null);
      setAgentTodos([]);
      setInteractionError(null);
      setRunFailure(failureFromRun(latestRun));
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
    setRunFailure(null);
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

  async function handleConnectionRecovery() {
    const persistedRun = readPersistedRun();
    const canResume =
      persistedRun?.pending && persistedRun.chatId === conversation.chatId;
    setTrace((current) => [
      ...current.slice(-9),
      localEvent(
        'retry',
        'running',
        canResume ? '正在重新连接' : '正在重新提交',
        canResume
          ? '将从已持久化的事件 cursor 继续接收，不会创建重复任务'
          : '原运行记录已失效，将重新提交上一条消息',
      ),
    ]);
    clearError();
    if (canResume) {
      await resumeStream();
      return;
    }
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

  function resetConversation(chatId: string) {
    clearError();
    clearPersistedRun();
    setConversation({
      chatId,
      messages: [],
      resumeRun: null,
    });
    setInput('');
    setSuggestions([]);
    setTrace(initialTrace);
    setDismissedCards(new Set());
    setPendingInterrupt(null);
    setAgentTodos([]);
    setInteractionError(null);
    setRunFailure(null);
    sessionRef.current = new ResilientSession();
  }

  async function handleNewChat() {
    if (creatingSession) return;
    setSessionMenuId(null);
    setCreatingSession(true);
    setSessionsError(null);
    const externalKey = crypto.randomUUID();
    try {
      const response = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalKey,
          title: '新会话',
        }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, '新建会话失败'));
      }
      await stopCurrentConversation();
      resetConversation(externalKey);
      setNotice('已创建空白工作区');
      await refreshSessions();
    } catch (caught) {
      setSessionsError(
        caught instanceof Error ? caught.message : '新建会话失败',
      );
    } finally {
      setCreatingSession(false);
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
        resetConversation(crypto.randomUUID());
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
    body:
      | {
          decision: 'approve' | 'reject';
          scope?: 'once' | 'session';
          message?: string;
        }
      | QuestionAnswer,
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
      const sessionApprovalGranted =
        'decision' in body &&
        body.decision === 'approve' &&
        body.scope === 'session';
      if (sessionApprovalGranted) {
        setNotice('本会话后续操作将自动执行');
      }
      setTrace((current) => [
        ...current.slice(-11),
        localEvent(
          'request',
          'running',
          sessionApprovalGranted ? '已开启本会话自动批准' : '已提交人工响应',
          sessionApprovalGranted
            ? '当前会话后续工具操作将自动执行'
            : '任务已重新进入 Worker 队列',
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

  const persistedForRecovery = error ? readPersistedRun() : null;
  const canResumeConnection = Boolean(
    persistedForRecovery?.pending &&
      persistedForRecovery.chatId === conversation.chatId,
  );

  return (
    <main
      className={`app-shell ${traceOpen ? 'is-trace-open' : ''} ${sidebarOpen ? 'is-sidebar-open' : ''}`}
    >
      <Sidebar
        activeChatId={conversation.chatId}
        busy={isBusy || creatingSession}
        creating={creatingSession}
        error={sessionsError}
        loaded={sessionsLoaded}
        hasMore={Boolean(sessionsNextCursor)}
        loadingMore={loadingMoreSessions}
        menuSessionId={sessionMenuId}
        inactive={Boolean(sessionDialog)}
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
          void handleNewChat();
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
          sidebarOpen || Boolean(sessionDialog)
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
                    ? '连接中断'
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
              disabled={creatingSession}
              type="button"
              aria-label={creatingSession ? '正在新建对话' : '新建对话'}
              onClick={() => void handleNewChat()}
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
              {status === 'submitted' && !hasAssistantPlaceholder && <ThinkingRow />}
              {agentTodos.length > 0 && <AgentTodoList todos={agentTodos} />}
              {pendingInterrupt && (
                <PendingInteraction
                  key={pendingInterrupt.interruptId}
                  busy={interactionBusy}
                  error={interactionError}
                  interrupt={pendingInterrupt}
                  onApproval={(decision, scope) =>
                    respondToInterrupt(pendingInterrupt, { decision, scope })
                  }
                  onQuestion={(answer) =>
                    respondToInterrupt(pendingInterrupt, answer)
                  }
                />
              )}
              {runFailure && (
                <TaskFailureNotice
                  failure={runFailure}
                  onDismiss={() => setRunFailure(null)}
                />
              )}
              {error && (
                <div className="error-banner" role="alert">
                  <div className="error-icon">
                    <Icon name="triangle" size={19} />
                  </div>
                  <div>
                    <strong>与 Agent 的连接暂时中断</strong>
                    <p>{friendlyError(error)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleConnectionRecovery()}
                  >
                    <Icon name="refresh" size={16} />
                    {canResumeConnection ? '重新连接' : '重新提交'}
                  </button>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <Composer
          activity={
            interactionBusy
              ? '正在提交审批结果…'
              : pendingInterrupt?.type === 'approval.required'
                ? '等待你的审批后继续'
                : pendingInterrupt?.type === 'question.required'
                  ? '等待你的回答后继续'
                  : status === 'submitted'
                    ? '正在连接 Agent…'
                    : status === 'streaming'
                      ? 'Agent 正在处理请求…'
                      : null
          }
          disabled={Boolean(error) || Boolean(pendingInterrupt)}
          disabledPlaceholder={
            pendingInterrupt
              ? '请先处理上方待办'
              : '请先恢复与 Agent 的连接'
          }
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
        inactive={sidebarOpen || Boolean(sessionDialog)}
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        trace={trace}
      />

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

export { AppSkeleton, ChatRuntime };
