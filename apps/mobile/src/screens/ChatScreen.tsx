import * as Clipboard from 'expo-clipboard';
import { useNavigation } from '@react-navigation/native';
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
import {
  reducer,
  initialState,
  selectChatItems,
  type ChatItem,
} from '../chat/state';
import { UserMessage } from '../components/MessageBubble';
import AssistantTurn from '../components/AssistantTurn';
import TaskProgress from '../components/TaskProgress';
import type {
  ApprovalRequest,
  QuestionRequest,
} from '../components/InterruptCards';
import { colors, inputStyle, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({ route }: Props) {
  const { sessionId } = route.params;
  const navigation = useNavigation();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const streamRef = useRef<RunStreamHandle | null>(null);
  const listRef = useRef<FlatList<ChatItem> | null>(null);

  const stickToBottom = useRef(true);
  const userScrolling = useRef(false);
  const contentHeight = useRef(0);
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (stickToBottom.current && !userScrolling.current) {
        listRef.current?.scrollToOffset({
          offset: contentHeight.current,
          animated: false,
        });
      }
    });
  }, []);
  const items = useMemo(() => selectChatItems(state), [state]);
  const active = state.active;
  const runInProgress = active !== null && !active.finished;

  // 建立/复用事件流订阅：发送新 run 或恢复活跃 run 都走这里。
  const subscribe = useCallback((runId: string) => {
    streamRef.current?.close();
    const token = api.bearerToken;
    if (!token) return;
    streamRef.current = subscribeRunStream(api.baseUrl, token, runId, {
      onEvent: (event) => dispatch({ type: 'event', event }),
      onFinished: () => dispatch({ type: 'finished', runId }),
      onReconnecting: (attempt) =>
        dispatch({ type: 'reconnecting', runId, attempt }),
      onResumed: () => dispatch({ type: 'resumed', runId }),
      onError: (message) =>
        dispatch({
          type: 'send-failed',
          runId,
          message,
          connectionError: true,
        }),
    });
  }, []);

  // 加载历史；若最新 run 未结束则直接续订事件流（服务端按 seq 重放）。
  useEffect(() => {
    let cancelled = false;
    streamRef.current?.close();
    dispatch({ type: 'reset' });
    setDraft('');
    stickToBottom.current = true;
    (async () => {
      try {
        const history = await api.history(sessionId);
        if (cancelled) return;
        const latest = history.latestRun;
        const activeRunId =
          latest &&
          [
            'queued',
            'running',
            'waiting_approval',
            'waiting_question',
          ].includes(latest.status)
            ? latest.id
            : null;
        // 活跃 run 的 assistant 半成品正文不进历史列表，由事件重放重建，避免重复。
        const items: ChatItem[] = history.messages
          .filter(
            (message) =>
              !(
                activeRunId &&
                message.runId === activeRunId &&
                message.role === 'assistant'
              ),
          )
          .map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
            reasoning: message.reasoning,
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
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [sessionId, subscribe]);

  // 会话标题跟随最新内容更新（无侵入：仅显示）。
  useEffect(() => {
    if (state.items.length > 0) {
      const last = state.items[state.items.length - 1];
      if (last.role === 'user') {
        navigation.setOptions({ title: last.text.slice(0, 24) });
      }
    }
  }, [state.items, navigation]);

  const send = async () => {
    const message = draft.trim();
    if (!message || runInProgress || sending) return;
    stickToBottom.current = true;
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
        runId: active.runId,
        message: `取消失败：${err instanceof Error ? err.message : '未知错误'}`,
      });
    }
  };

  const respondApproval = useCallback(
    async (
      request: ApprovalRequest,
      approve: boolean,
      scope: 'once' | 'session',
    ) => {
      await api.respondApproval(
        request.runId,
        request.interruptId,
        approve,
        scope,
      );
      dispatch({
        type: 'interrupt-responded',
        runId: request.runId,
        interruptId: request.interruptId,
      });
    },
    [],
  );

  const respondQuestion = useCallback(
    async (
      request: QuestionRequest,
      selections: { index: number; label: string }[],
      customText?: string,
    ) => {
      await api.respondQuestion(
        request.runId,
        request.interruptId,
        selections,
        customText,
      );
      dispatch({
        type: 'interrupt-responded',
        runId: request.runId,
        interruptId: request.interruptId,
      });
    },
    [],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatItem>) =>
      item.role === 'user' ? (
        <UserMessage text={item.text} />
      ) : (
        <AssistantTurn
          item={item}
          onApproval={respondApproval}
          onQuestion={respondQuestion}
        />
      ),
    [respondApproval, respondQuestion],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {state.loadingHistory ? (
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => {
            userScrolling.current = true;
          }}
          onMomentumScrollBegin={() => {
            userScrolling.current = true;
          }}
          onScrollEndDrag={() => {
            userScrolling.current = false;
          }}
          onMomentumScrollEnd={() => {
            userScrolling.current = false;
          }}
          onScroll={({ nativeEvent }) => {
            if (userScrolling.current)
              stickToBottom.current =
                nativeEvent.contentSize.height -
                  nativeEvent.layoutMeasurement.height -
                  nativeEvent.contentOffset.y <
                100;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={(_, height) => {
            contentHeight.current = height;
            scrollToBottom();
          }}
          onLayout={scrollToBottom}
          contentContainerStyle={{ paddingVertical: spacing.md }}
        />
      )}

      {state.error ? (
        <Text
          style={{
            color: colors.danger,
            fontSize: 13,
            paddingHorizontal: spacing.md,
          }}
          numberOfLines={2}
        >
          {state.error}
        </Text>
      ) : null}

      {active?.reconnecting && !active.finished ? (
        <Text
          style={{
            color: colors.warning,
            fontSize: 12,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.xs,
          }}
        >
          连接中断，正在重连…（恢复后自动从断点续传）
        </Text>
      ) : null}

      {active?.connectionError && !active.finished ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            dispatch({ type: 'reconnecting', runId: active.runId, attempt: 1 });
            subscribe(active.runId);
          }}
          style={{ minHeight: 44, padding: spacing.md }}
        >
          <Text style={{ color: colors.accent }}>重新连接</Text>
        </Pressable>
      ) : null}
      <TaskProgress todos={active?.todos ?? []} />

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
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: 13,
                fontWeight: '600',
              }}
            >
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
            <Text style={{ color: colors.danger, fontWeight: '600' }}>
              停止
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void send()}
            disabled={!draft.trim() || sending}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.lg,
              paddingVertical: 12,
              borderRadius: 10,
              backgroundColor: draft.trim()
                ? colors.accent
                : colors.surfaceElevated,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text
                style={{
                  color: draft.trim() ? '#ffffff' : colors.textMuted,
                  fontWeight: '600',
                }}
              >
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
