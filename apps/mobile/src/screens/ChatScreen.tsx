import * as Clipboard from 'expo-clipboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ListRenderItemInfo } from 'react-native';

import type { RootStackParamList } from '../App';
import { api } from '../api/client';
import { subscribeRunStream, type RunStreamHandle } from '../api/sse';
import type { StreamAgentEvent } from '../api/types';
import ActivityPanel, {
  toolStartedItem,
  type ActivityItem,
} from '../components/ActivityPanel';
import { AssistantMessage, UserMessage } from '../components/MessageBubble';
import ReasoningBlock from '../components/ReasoningBlock';
import {
  ApprovalCard,
  QuestionCard,
  type ApprovalRequest,
  type QuestionRequest,
} from '../components/InterruptCards';
import { colors, inputStyle, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface ActiveRun {
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
}

interface ChatState {
  items: ChatItem[];
  active: ActiveRun | null;
  loadingHistory: boolean;
  error: string | null;
}

type ChatAction =
  | { type: 'history'; items: ChatItem[]; activeRunId: string | null }
  | { type: 'run-started'; runId: string; userText: string }
  | { type: 'event'; event: StreamAgentEvent }
  | { type: 'finished' }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'resumed' }
  | { type: 'interrupt-responded' }
  | { type: 'send-failed'; message: string };

const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);

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
  };
}

function finalize(state: ChatState, failureMessage: string | null): ChatState {
  const active = state.active;
  if (!active || active.finished) return state;
  const items = [...state.items];
  if (active.assistantText.trim()) {
    items.push({
      id: `message-${active.runId}`,
      role: 'assistant',
      text: active.assistantText,
    });
  }
  return {
    ...state,
    items,
    active: { ...active, finished: true, approval: null, question: null },
    error: failureMessage,
  };
}

function applyEvent(state: ChatState, event: StreamAgentEvent): ChatState {
  const active = state.active;
  if (!active || active.runId !== event.runId) return state;

  switch (event.type) {
    case 'assistant.delta':
      return { ...state, active: { ...active, assistantText: active.assistantText + event.text } };
    case 'assistant.snapshot':
      return { ...state, active: { ...active, assistantText: event.text } };
    case 'assistant.reasoning':
      return { ...state, active: { ...active, reasoning: active.reasoning + event.text } };
    case 'assistant.narration':
      return {
        ...state,
        active: {
          ...active,
          activities: [...active.activities, { kind: 'note', summary: event.text }],
        },
      };
    case 'tool.started':
      return {
        ...state,
        active: {
          ...active,
          activities: [
            ...active.activities,
            toolStartedItem(event.invocationId, event.tool, event.input),
          ],
        },
      };
    case 'tool.completed':
      return {
        ...state,
        active: {
          ...active,
          activities: active.activities.map((item) =>
            item.kind === 'tool' && item.invocationId === event.invocationId
              ? { ...item, running: false }
              : item,
          ),
        },
      };
    case 'todo.updated':
      return { ...state, active: { ...active, todos: event.todos } };
    case 'usage.updated':
      return { ...state, active: { ...active, totalTokens: active.totalTokens + event.totalTokens } };
    case 'approval.required':
      return {
        ...state,
        active: {
          ...active,
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
          activities: [...active.activities, { kind: 'note', summary: '正在压缩上下文…' }],
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

function reducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history':
      return {
        ...state,
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
      if (!active || active.finished) return state;
      return finalize(state, null);
    }
    case 'reconnecting': {
      const active = state.active;
      if (!active || active.finished) return state;
      return { ...state, active: { ...active, reconnecting: true } };
    }
    case 'resumed': {
      const active = state.active;
      if (!active) return state;
      return { ...state, active: { ...active, reconnecting: false } };
    }
    case 'interrupt-responded': {
      const active = state.active;
      if (!active) return state;
      return { ...state, active: { ...active, approval: null, question: null } };
    }
    case 'send-failed':
      return { ...state, error: action.message, active: null };
    default:
      return state;
  }
}

const initialState: ChatState = {
  items: [],
  active: null,
  loadingHistory: true,
  error: null,
};

export default function ChatScreen({ route }: Props) {
  const { sessionId } = route.params;
  const navigation = useNavigation();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const streamRef = useRef<RunStreamHandle | null>(null);
  const listRef = useRef<FlatList<ChatItem> | null>(null);

  const active = state.active;
  const runInProgress = active !== null && !active.finished;

  // 建立/复用事件流订阅：发送新 run 或恢复活跃 run 都走这里。
  const subscribe = useCallback(
    (runId: string) => {
      streamRef.current?.close();
      const token = api.bearerToken;
      if (!token) return;
      streamRef.current = subscribeRunStream(api.baseUrl, token, runId, {
        onEvent: (event) => dispatch({ type: 'event', event }),
        onFinished: () => dispatch({ type: 'finished' }),
        onReconnecting: (attempt) => dispatch({ type: 'reconnecting', attempt }),
        onResumed: () => dispatch({ type: 'resumed' }),
      });
    },
    [],
  );

  // 加载历史；若最新 run 未结束则直接续订事件流（服务端按 seq 重放）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await api.history(sessionId);
        if (cancelled) return;
        const latest = history.latestRun;
        const activeRunId =
          latest && ['queued', 'running', 'waiting_approval', 'waiting_question'].includes(latest.status)
            ? latest.id
            : null;
        // 活跃 run 的 assistant 半成品正文不进历史列表，由事件重放重建，避免重复。
        const items: ChatItem[] = history.messages
          .filter((message) => !(activeRunId && message.runId === activeRunId && message.role === 'assistant'))
          .map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
          }));
        dispatch({ type: 'history', items, activeRunId });
        if (activeRunId) subscribe(activeRunId);
      } catch (err) {
        if (!cancelled) {
          dispatch({
            type: 'send-failed',
            message: `加载历史失败：${err instanceof Error ? err.message : '未知错误'}`,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, subscribe]);

  // 卸载时断开事件流。
  useEffect(() => {
    return () => {
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, []);

  // 会话标题跟随最新内容更新（无侵入：仅显示）。
  useEffect(() => {
    if (state.items.length > 0) {
      const last = state.items[state.items.length - 1];
      if (last.role === 'user') {
        navigation.setOptions({ title: last.text.slice(0, 24) });
      }
    }
  }, [state.items, navigation]);

  // 新内容到达时滚动到底部。
  useEffect(() => {
    if (state.items.length === 0 && !active) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
    });
  }, [state.items, active?.assistantText, active?.activities.length]);

  const send = async () => {
    const message = draft.trim();
    if (!message || runInProgress || sending) return;
    setSending(true);
    setDraft('');
    try {
      const run = await api.createRun(sessionId, message);
      dispatch({ type: 'run-started', runId: run.id, userText: message });
      subscribe(run.id);
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      const messageText = code.includes('session_has_active_run')
        ? '会话已有运行中的任务，请等待完成或取消后再发送'
        : `发送失败：${code}`;
      dispatch({ type: 'send-failed', message: messageText });
      setDraft(message);
    } finally {
      setSending(false);
    }
  };

  const cancelRun = async () => {
    if (!active) return;
    try {
      await api.cancelRun(active.runId);
    } catch (err) {
      dispatch({
        type: 'send-failed',
        message: `取消失败：${err instanceof Error ? err.message : '未知错误'}`,
      });
    }
  };

  const respondApproval = useCallback(
    async (request: ApprovalRequest, approve: boolean) => {
      try {
        await api.respondApproval(request.runId, request.interruptId, approve);
        dispatch({ type: 'interrupt-responded' });
      } catch (err) {
        dispatch({
          type: 'send-failed',
          message: `审批提交失败：${err instanceof Error ? err.message : '未知错误'}`,
        });
      }
    },
    [],
  );

  const respondQuestion = useCallback(
    async (
      request: QuestionRequest,
      selections: { index: number; label: string }[],
      customText?: string,
    ) => {
      try {
        await api.respondQuestion(
          request.runId,
          request.interruptId,
          selections,
          customText,
        );
        dispatch({ type: 'interrupt-responded' });
      } catch (err) {
        dispatch({
          type: 'send-failed',
          message: `回答提交失败：${err instanceof Error ? err.message : '未知错误'}`,
        });
      }
    },
    [],
  );

  const renderItem = ({ item }: ListRenderItemInfo<ChatItem>) =>
    item.role === 'user' ? (
      <UserMessage text={item.text} />
    ) : (
      <AssistantMessage text={item.text} />
    );

  const footer = useMemo(() => {
    if (!active) return null;
    return (
      <View>
        <ActivityPanel items={active.activities} />
        {active.todos.length > 0 ? (
          <View
            style={{
              marginHorizontal: spacing.md,
              marginVertical: spacing.xs,
              padding: spacing.md,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
              gap: spacing.xs,
            }}
          >
            {active.todos.map((todo) => (
              <Text
                key={todo.content}
                style={{
                  fontSize: 13,
                  color:
                    todo.status === 'completed'
                      ? colors.textMuted
                      : todo.status === 'in_progress'
                        ? colors.warning
                        : colors.textSecondary,
                }}
              >
                {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'}{' '}
                {todo.content}
              </Text>
            ))}
          </View>
        ) : null}
        {active.reasoning ? (
          <ReasoningBlock text={active.reasoning} streaming={!active.finished} />
        ) : null}
        {active.approval ? (
          <ApprovalCard
            request={active.approval}
            onRespond={(approve) => respondApproval(active.approval!, approve)}
          />
        ) : null}
        {active.question ? (
          <QuestionCard
            request={active.question}
            onRespond={(selections, customText) =>
              respondQuestion(active.question!, selections, customText)
            }
          />
        ) : null}
        {active.assistantText ? (
          <AssistantMessage text={active.assistantText} streaming={!active.finished} />
        ) : !active.finished ? (
          <View style={{ padding: spacing.md, alignItems: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : null}
      </View>
    );
  }, [active, respondApproval, respondQuestion]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {state.loadingHistory ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={state.items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListFooterComponent={footer}
          contentContainerStyle={{ paddingVertical: spacing.md }}
        />
      )}

      {state.error ? (
        <Text
          style={{ color: colors.danger, fontSize: 13, paddingHorizontal: spacing.md }}
          numberOfLines={2}
        >
          {state.error}
        </Text>
      ) : null}

      {active?.reconnecting && !active.finished ? (
        <Text
          style={{ color: colors.warning, fontSize: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.xs }}
        >
          连接中断，正在重连…（恢复后自动从断点续传）
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: spacing.sm,
          padding: spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
        }}
      >
        <TextInput
          style={[inputStyle, { flex: 1, maxHeight: 120 }]}
          value={draft}
          onChangeText={setDraft}
          placeholder={runInProgress ? '任务执行中…' : '输入消息'}
          placeholderTextColor={colors.textMuted}
          multiline
          editable={!runInProgress}
        />
        {!runInProgress ? (
          <Pressable
            onPress={async () => {
              try {
                const res = await fetch(`${api.baseUrl}/api/clipboard`, {
                  headers: { Authorization: `Bearer ${api.bearerToken}` },
                });
                const data = await res.json();
                if (data.text) setDraft(data.text);
              } catch {
                // fallback: expo-clipboard
                const text = await Clipboard.getStringAsync();
                if (text) setDraft(text);
              }
            }}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.background,
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>
              粘贴
            </Text>
          </Pressable>
        ) : null}
        {runInProgress ? (
          <Pressable
            onPress={() => void cancelRun()}
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.danger,
            }}
          >
            <Text style={{ color: colors.danger, fontWeight: '600' }}>停止</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void send()}
            disabled={!draft.trim() || sending}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.lg,
              paddingVertical: 12,
              borderRadius: 10,
              backgroundColor: draft.trim() ? colors.accent : colors.surfaceElevated,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text style={{ color: draft.trim() ? '#ffffff' : colors.textMuted, fontWeight: '600' }}>
                发送
              </Text>
            )}
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// FlatList 泛型在下方声明前先引用（类型层面无运行时影响）。
const keyExtractor = (item: ChatItem) => item.id;
