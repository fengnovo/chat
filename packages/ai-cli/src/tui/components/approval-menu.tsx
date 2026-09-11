import { Box, Text, useInput } from 'ink';
import React, { useCallback, useRef } from 'react';

import { IS_TTY } from '../constants.js';
import { tuiStore } from '../store.js';
import type {
  ApprovalDecision,
  ApprovalMenuProps,
  NavigationKey,
} from '../types.js';

export function ApprovalMenu({
  requests,
  selected,
  onDecide,
}: ApprovalMenuProps): JSX.Element {
  const onDecideRef = useRef(onDecide);
  onDecideRef.current = onDecide;

  const handler = useCallback(
    (input: string, key: NavigationKey) => {
      if (key.ctrl && input === 'c') {
        process.exit(0);
        return;
      }
      if (input === 'y' || input === 'Y') onDecideRef.current('approve');
      else if (input === 'n' || input === 'N') onDecideRef.current('reject');
      else if (input === 'a' || input === 'A') onDecideRef.current('approve-all');
      else if (key.upArrow) {
        const current = tuiStore.getState().approval?.selected ?? 0;
        tuiStore.setState({ approval: { requests, selected: (current + 2) % 3 } });
      } else if (key.downArrow) {
        const current = tuiStore.getState().approval?.selected ?? 0;
        tuiStore.setState({ approval: { requests, selected: (current + 1) % 3 } });
      } else if (key.return) {
        const current = tuiStore.getState().approval?.selected ?? 0;
        const decisions: ApprovalDecision[] = ['approve', 'reject', 'approve-all'];
        onDecideRef.current(decisions[current]);
      }
    },
    [requests],
  );

  useInput(handler, { isActive: IS_TTY });

  const options = [
    { label: '✅ 批准        (y / Enter)', color: 'green' as const },
    { label: '⛔ 拒绝        (n)', color: 'red' as const },
    { label: '⚡ 本次会话全部批准  (a)', color: 'yellow' as const },
  ];

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        ⚠️ 工具调用需要人工审批
      </Text>
      {requests.map((request, index) => (
        <Box key={index}>
          <Text color="magenta">→</Text>
          <Text>{' '}</Text>
          <Text bold>{request.name}</Text>
          <Text>  {request.summary}</Text>
        </Box>
      ))}
      <Text>{' '}</Text>
      {options.map((option, index) => (
        <Box key={index}>
          <Text color={index === selected ? 'cyan' : 'gray'}>
            {index === selected ? '❯ ' : '  '}
          </Text>
          <Text color={option.color} inverse={index === selected}>
            {' '}
            {option.label}{' '}
          </Text>
        </Box>
      ))}
      <Text>{' '}</Text>
      <Text dimColor>↑/↓ 选择 · Enter 确认 · y 批准 · n 拒绝 · a 全部批准 · Ctrl+C 退出</Text>
    </Box>
  );
}
