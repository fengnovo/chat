import { Box, Text, useInput } from 'ink';
import React, { useCallback, useRef, useSyncExternalStore } from 'react';

import { IS_TTY, SEP } from '../constants.js';
import { buildUserQuestionAnswer, toggleQuestionSelection } from '../question.js';
import { editReplBuffer, splitReplCursor } from '../repl-input.js';
import { tuiStore } from '../store.js';
import type { QuestionInputKey, UserQuestionMenuProps } from '../types.js';

/** 把 ask_user interrupt 渲染成单选、多选或自定义输入菜单。 */
export function UserQuestionMenu({ onAnswer }: UserQuestionMenuProps): JSX.Element {
  const state = useSyncExternalStore(tuiStore.subscribe, tuiStore.getState);
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;

  const questionState = state.question;
  const request = questionState?.request;
  const optionCount = request?.options.length ?? 0;
  const customIndex = request?.allowCustom ? optionCount : -1;
  const confirmIndex = request?.multiple
    ? optionCount + (request.allowCustom ? 1 : 0)
    : -1;
  const rowCount = optionCount + (request?.allowCustom ? 1 : 0) + (request?.multiple ? 1 : 0);

  const handler = useCallback(
    (input: string, key: QuestionInputKey) => {
      if (key.ctrl && input === 'c') {
        process.exit(0);
        return;
      }

      const current = tuiStore.getState().question;
      if (!current) return;

      if (current.editingCustom) {
        if (key.escape) {
          tuiStore.setState({
            question: { ...current, editingCustom: false, error: null },
          });
          return;
        }

        if (key.return) {
          const answer = buildUserQuestionAnswer(
            current.request,
            current.selectedIndices,
            current.customInput,
          );
          if (!current.customInput.trim()) {
            tuiStore.setState({
              question: { ...current, error: '自定义内容不能为空' },
            });
          } else if (!current.request.multiple && answer) {
            onAnswerRef.current(answer);
          } else {
            tuiStore.setState({
              question: { ...current, editingCustom: false, error: null },
            });
          }
          return;
        }

        const next = editReplBuffer(
          { value: current.customInput, cursor: current.customCursor },
          input,
          key,
        );
        if (next.value !== current.customInput || next.cursor !== current.customCursor) {
          tuiStore.setState({
            question: {
              ...current,
              customInput: next.value,
              customCursor: next.cursor,
              error: null,
            },
          });
        }
        return;
      }

      if (key.upArrow) {
        tuiStore.setState({
          question: {
            ...current,
            highlighted: (current.highlighted + rowCount - 1) % rowCount,
            error: null,
          },
        });
        return;
      }
      if (key.downArrow) {
        tuiStore.setState({
          question: {
            ...current,
            highlighted: (current.highlighted + 1) % rowCount,
            error: null,
          },
        });
        return;
      }

      const highlighted = current.highlighted;
      const togglingOption = highlighted < current.request.options.length;
      if ((input === ' ' || key.return) && togglingOption) {
        if (current.request.multiple) {
          tuiStore.setState({
            question: {
              ...current,
              selectedIndices: toggleQuestionSelection(
                current.selectedIndices,
                highlighted,
              ),
              error: null,
            },
          });
        } else if (key.return) {
          const answer = buildUserQuestionAnswer(current.request, [highlighted], '');
          if (answer) onAnswerRef.current(answer);
        }
        return;
      }

      if (key.return && highlighted === customIndex) {
        tuiStore.setState({
          question: {
            ...current,
            selectedIndices: current.request.multiple ? current.selectedIndices : [],
            editingCustom: true,
            customCursor: current.customInput.length,
            error: null,
          },
        });
        return;
      }

      if (key.return && highlighted === confirmIndex) {
        const answer = buildUserQuestionAnswer(
          current.request,
          current.selectedIndices,
          current.customInput,
        );
        if (answer) {
          onAnswerRef.current(answer);
        } else {
          tuiStore.setState({
            question: { ...current, error: '请至少选择一项或填写自定义内容' },
          });
        }
      }
    },
    [customIndex, confirmIndex, rowCount],
  );

  useInput(handler, { isActive: IS_TTY });

  if (!questionState || !request) return <Text>{' '}</Text>;

  const customView = splitReplCursor({
    value: questionState.customInput,
    cursor: questionState.customCursor,
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        💬 {request.question}
      </Text>
      <Text color="gray">{SEP}</Text>
      {request.options.map((option, index) => {
        const highlighted = questionState.highlighted === index;
        const checked = questionState.selectedIndices.includes(index);
        return (
          <Box key={index}>
            <Text color={highlighted ? 'cyan' : 'gray'}>{highlighted ? '❯ ' : '  '}</Text>
            <Text color={checked ? 'green' : undefined} inverse={highlighted}>
              {request.multiple ? (checked ? '[✓] ' : '[ ] ') : ''}
              {option.label}
            </Text>
            {option.description ? <Text dimColor>  {option.description}</Text> : null}
          </Box>
        );
      })}

      {request.allowCustom && (
        <Box>
          <Text color={questionState.highlighted === customIndex ? 'cyan' : 'gray'}>
            {questionState.highlighted === customIndex ? '❯ ' : '  '}
          </Text>
          <Text inverse={questionState.highlighted === customIndex && !questionState.editingCustom}>
            ✎ 其他：
          </Text>
          {questionState.editingCustom ? (
            <>
              <Text>{customView.before}</Text>
              <Text inverse color="white">
                {customView.cursorText}
              </Text>
              <Text>{customView.after}</Text>
            </>
          ) : (
            <Text>{questionState.customInput || '（自定义输入）'}</Text>
          )}
        </Box>
      )}

      {request.multiple && (
        <Box>
          <Text color={questionState.highlighted === confirmIndex ? 'cyan' : 'gray'}>
            {questionState.highlighted === confirmIndex ? '❯ ' : '  '}
          </Text>
          <Text color="green" inverse={questionState.highlighted === confirmIndex}>
            ✓ 确认选择
          </Text>
        </Box>
      )}

      {questionState.error ? <Text color="red">⚠ {questionState.error}</Text> : null}
      <Text>{' '}</Text>
      <Text dimColor>
        {questionState.editingCustom
          ? `输入自定义内容 · Enter ${request.multiple ? '保存' : '确认'} · Esc 返回`
          : request.multiple
            ? '↑/↓ 移动 · Space/Enter 勾选 · 在“确认选择”处 Enter 提交 · Ctrl+C 退出'
            : '↑/↓ 选择 · Enter 确认 · Ctrl+C 退出'}
      </Text>
    </Box>
  );
}
