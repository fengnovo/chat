import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { api } from '../api/client';
import { subscribeRunStream, type RunStreamHandle } from '../api/sse';
import {
  reducer,
  initialState,
  selectChatItems,
  restoreHistory,
  type ChatItem,
} from '../chat/state';
import { UserMessage } from '../components/MessageBubble';
import AssistantTurn from '../components/AssistantTurn';
import TaskProgress from '../components/TaskProgress';
import AttachmentComposer from '../components/AttachmentComposer';
import { useAttachments } from '../attachments/useAttachments';
import type {
  ApprovalRequest,
  QuestionRequest,
} from '../components/InterruptCards';
import { colors, inputStyle, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({ route }: Props) {
  const { sessionId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');
  const attachments = useAttachments();
  const [picking, setPicking] = useState(false);
  const [sessionTitle, setSessionTitle] = useState(route.params.title);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [sending, setSending] = useState(false);
  const streamRef = useRef<RunStreamHandle | null>(null);
  const listRef = useRef<FlatList<ChatItem> | null>(null);
  const historyPage = state.historyPage;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyPageGeneration = useRef(0);
  const historySession = useRef(sessionId);
  historySession.current = sessionId;
  const olderRequest = useRef<AbortController | null>(null);

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
  const subscribe = useCallback((runId: string, cursor = 0) => {
    streamRef.current?.close();
    const token = api.bearerToken;
    if (!token) return;
    streamRef.current = subscribeRunStream(
      api.baseUrl,
      token,
      runId,
      {
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
      },
      cursor,
    );
  }, []);

  // 执行由服务器负责；失去焦点或进入后台只会断开 SSE。
  useFocusEffect(
    useCallback(() => {
      let disposed = false;
      let generation = 0;
      let initiallyLoaded = false;
      historyPageGeneration.current++;
      setLoadingOlder(false);
      dispatch({ type: 'reset' });
      stickToBottom.current = true;
      const load = async () => {
        const request = ++generation;
        streamRef.current?.close();
        try {
          const history = await api.history(sessionId);
          if (disposed || request !== generation) return;
          historyPageGeneration.current++;
          olderRequest.current?.abort(); olderRequest.current = null;
          setLoadingOlder(false);
          const restored = restoreHistory(history);
          dispatch({
            type: 'history',
            items: [],
            activeRunId: null,
            snapshot: history,
            preserveOlder: initiallyLoaded,
          });
          initiallyLoaded = true;
          setSessionTitle(history.session.title);
          navigation.setOptions({ title: history.session.title });
          void api
            .rememberChat(sessionId, history.session.title)
            .catch(() => {});
          if (restored.active && !restored.active.finished)
            subscribe(restored.active.runId, restored.active.lastSeq);
        } catch (err) {
          if (!disposed && request === generation) {
            dispatch({
              type: 'send-failed',
              message: `恢复会话失败：${err instanceof Error ? err.message : '未知错误'}`,
              connectionError:
                !!stateRef.current.active && !stateRef.current.active.finished,
            });
          }
        }
      };
      void load();
      const listener = AppState.addEventListener('change', (status) => {
        if (status === 'active') void load();
        else {
          generation++;
          streamRef.current?.close();
        }
      });
      return () => {
        disposed = true;
        generation++;
        historyPageGeneration.current++;
        olderRequest.current?.abort(); olderRequest.current = null;
        listener.remove();
        streamRef.current?.close();
        streamRef.current = null;
      };
    }, [sessionId, subscribe, navigation]),
  );

  const loadOlderHistory = async () => {
    if (!historyPage?.cursor || historyPage.sessionId !== sessionId || olderRequest.current) return;
    const page = historyPage;
    const request = ++historyPageGeneration.current;
    const controller = new AbortController(); olderRequest.current = controller;
    setLoadingOlder(true);
    try {
      const history = await api.history(sessionId, { cursor: page.cursor!, includeLatestEvents: false, signal: controller.signal });
      if (controller.signal.aborted || request !== historyPageGeneration.current || historySession.current !== sessionId) return;
      stickToBottom.current = false;
      dispatch({ type: 'history-page', items: history.messages.map((message) => ({
        id: message.id, role: message.role, text: message.text, reasoning: message.reasoning, attachments: message.attachments,
      })), nextCursor: history.hasMore ? history.nextCursor ?? null : null });
    } catch (error) {
      if (!controller.signal.aborted && historySession.current === sessionId) dispatch({ type: 'send-failed', message: `加载历史失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      if (olderRequest.current === controller) { olderRequest.current = null; setLoadingOlder(false); }
    }
  };

  const pickAttachment = async () => {
    if (picking || runInProgress || sending) return;
    setPicking(true);
    try {
      await attachments.pick();
    } catch (error) {
      dispatch({
        type: 'send-failed',
        message: error instanceof Error ? error.message : '附件选择失败',
      });
    } finally {
      setPicking(false);
    }
  };

  const send = async () => {
    const selected = attachments.files
      .map((file) => file.attachment!)
      .filter(Boolean);
    const message =
      draft.trim() ||
      (selected.length ? '（用户发送了附件，请结合附件内容完成任务）' : '');
    if (
      !message ||
      runInProgress ||
      sending ||
      (attachments.files.length > 0 && !attachments.ready)
    )
      return;
    stickToBottom.current = true;
    setSending(true);
    setDraft('');
    try {
      const run = await api.createRun(
        sessionId,
        message,
        selected.map((file) => file.id),
      );
      dispatch({
        type: 'run-started',
        runId: run.id,
        userText: message,
        attachments: selected,
      });
      attachments.consume();
      if (sessionTitle === '新会话') {
        const title = message.split('\n')[0].slice(0, 120);
        setSessionTitle(title);
        navigation.setOptions({ title });
        void api.rememberChat(sessionId, title).catch(() => {});
      }
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
        <UserMessage text={item.text} attachments={item.attachments} />
      ) : (
        <AssistantTurn
          item={item}
          sessionId={sessionId}
          onApproval={respondApproval}
          onQuestion={respondQuestion}
        />
      ),
    [respondApproval, respondQuestion, sessionId],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={keyboardOffset}
      onLayout={(event) => {
        // Android 窗口测量值不包含状态栏，iOS 则包含。
        // 测量实际标题栏起点，不要假定标题栏高度固定。
        event.target.measureInWindow((_x, y) =>
          setKeyboardOffset(y + (Platform.OS === 'android' ? insets.top : 0)),
        );
      }}
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
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          ListHeaderComponent={historyPage?.sessionId === sessionId && historyPage.cursor ? (
            <Pressable accessibilityRole="button" disabled={loadingOlder} onPress={() => void loadOlderHistory()}
              style={{ alignItems: 'center', padding: spacing.md }}>
              <Text style={{ color: colors.accent }}>{loadingOlder ? '正在加载…' : '加载更早消息'}</Text>
            </Pressable>
          ) : null}
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
            subscribe(active.runId, active.lastSeq);
          }}
          style={{ minHeight: 44, padding: spacing.md }}
        >
          <Text style={{ color: colors.accent }}>重新连接</Text>
        </Pressable>
      ) : null}
      <AttachmentComposer
        files={attachments.files}
        onRemove={attachments.remove}
        onRetry={(file) => {
          void attachments.retry(file);
        }}
      />
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
            accessibilityRole="button"
            accessibilityLabel="上传附件"
            disabled={picking || sending || attachments.files.length >= 5}
            onPress={() => void pickAttachment()}
            style={{
              minHeight: 44,
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: colors.accent, fontSize: 16 }}>📎</Text>
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
            disabled={
              (!draft.trim() && !attachments.ready) ||
              sending ||
              (attachments.files.length > 0 && !attachments.ready)
            }
            style={({ pressed }) => ({
              paddingHorizontal: spacing.lg,
              paddingVertical: 12,
              borderRadius: 10,
              backgroundColor:
                draft.trim() || attachments.ready
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
                  color:
                    draft.trim() || attachments.ready
                      ? '#ffffff'
                      : colors.textMuted,
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
