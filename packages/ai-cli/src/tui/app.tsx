import { Box, Text } from 'ink';
import React, { useEffect, useState, useSyncExternalStore } from 'react';

import {
  resolveApproval,
  resolveReplInput,
  resolveSession,
  resolveUserQuestion,
} from './bridge.js';
import { ApprovalMenu } from './components/approval-menu.js';
import { IdleInput, ReplInput } from './components/repl-input.js';
import { SessionPicker } from './components/session-picker.js';
import { LogList, TodoList } from './components/status-panels.js';
import { UserQuestionMenu } from './components/user-question-menu.js';
import { SEP } from './constants.js';
import { tuiStore } from './store.js';
import type { ThinkingIndicatorProps } from './types.js';

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

function ThinkingIndicator({ activity }: ThinkingIndicatorProps): JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [, setClock] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
      setClock(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const idleSeconds = activity
    ? Math.max(0, Math.floor((Date.now() - activity.updatedAt) / 1_000))
    : elapsedSeconds;
  const received = activity?.receivedChars
    ? ` · 已接收 ${activity.receivedChars.toLocaleString()} 字符`
    : '';

  return (
    <Text color="yellow">
      🤔 {activity?.label ?? '等待模型响应'} · 本轮 {formatElapsed(elapsedSeconds)}
      {received} · 最近活动 {formatElapsed(idleSeconds)}前
    </Text>
  );
}

export function App(): JSX.Element {
  const state = useSyncExternalStore(tuiStore.subscribe, tuiStore.getState);

  if (state.inputMode === 'session') {
    return <SessionPicker items={state.sessionItems} onPick={resolveSession} />;
  }

  return (
    <Box flexDirection="column">
      {state.banner && (
        <Box flexDirection="column">
          <Text bold>🧑‍💻 DeepAgents Coding Agent</Text>
          <Text>   模式：{state.banner.mode}</Text>
          <Text>   工作目录：{state.banner.cwd}</Text>
          <Text>   Skills：{state.banner.skills}</Text>
          <Text>   MCP：{state.banner.mcp}</Text>
          <Text>   LangSmith：{state.banner.langsmith}</Text>
          <Text>   记忆：{state.banner.memory}</Text>
          <Text>{' '}</Text>
        </Box>
      )}

      {state.startLine && (
        <Box>
          <Text dimColor>{state.startLine}</Text>
        </Box>
      )}

      {state.recap && (
        <Box flexDirection="column">
          <Text dimColor>💬 上次对话（直接输入即可继续）：</Text>
          <Text dimColor>  你：{state.recap.human}</Text>
          <Text dimColor>  助手：{state.recap.ai}</Text>
          <Text>{' '}</Text>
        </Box>
      )}

      <Text bold>🧑‍💻 {state.header}</Text>
      <Text color="gray">{SEP}</Text>

      {state.todos.length > 0 && (
        <>
          <TodoList todos={state.todos} />
          <Text color="gray">{SEP}</Text>
        </>
      )}

      <LogList logs={state.logs} />
      <Text color="gray">{SEP}</Text>

      {state.approval ? (
        <ApprovalMenu
          requests={state.approval.requests}
          selected={state.approval.selected}
          onDecide={resolveApproval}
        />
      ) : state.question ? (
        <UserQuestionMenu onAnswer={resolveUserQuestion} />
      ) : state.thinking ? (
        <ThinkingIndicator activity={state.activity} />
      ) : (
        <Box flexDirection="column">
          {state.finalAnswer && (
            <Box flexDirection="column">
              <Text bold color="green">
                ✅ 任务完成，最终回复：
              </Text>
              <Text>{state.finalAnswer}</Text>
              {state.inputMode === 'repl' && <Text>{' '}</Text>}
            </Box>
          )}
          {state.inputMode === 'repl' ? (
            <ReplInput onSubmit={resolveReplInput} />
          ) : (
            <IdleInput />
          )}
        </Box>
      )}
    </Box>
  );
}
