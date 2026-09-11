import { Box, Text, useInput } from 'ink';
import React, { useCallback, useRef, useSyncExternalStore } from 'react';

import { IS_TTY, SEP } from '../constants.js';
import { tuiStore } from '../store.js';
import type { NavigationKey, SessionPickerProps } from '../types.js';

export function SessionPicker({ items, onPick }: SessionPickerProps): JSX.Element {
  const state = useSyncExternalStore(tuiStore.subscribe, tuiStore.getState);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const handler = useCallback(
    (input: string, key: NavigationKey) => {
      if (key.ctrl && input === 'c') {
        process.exit(0);
        return;
      }
      const current = tuiStore.getState().sessionSelected;
      if (key.upArrow) {
        tuiStore.setState({
          sessionSelected: (current + items.length - 1) % items.length,
        });
      } else if (key.downArrow) {
        tuiStore.setState({ sessionSelected: (current + 1) % items.length });
      } else if (key.return) {
        onPickRef.current(current);
      }
    },
    [items.length],
  );

  useInput(handler, { isActive: IS_TTY });

  return (
    <Box flexDirection="column">
      <Text bold>📚 选择会话</Text>
      <Text color="gray">{SEP}</Text>
      {items.map((item, index) => (
        <Box key={index}>
          <Text color={index === state.sessionSelected ? 'cyan' : 'gray'}>
            {index === state.sessionSelected ? '❯ ' : '  '}
          </Text>
          <Text bold={index === state.sessionSelected}>{item.title}</Text>
          {item.subtitle ? <Text dimColor>  {item.subtitle}</Text> : <Text>{' '}</Text>}
        </Box>
      ))}
      <Text>{' '}</Text>
      <Text dimColor>↑/↓ 选择 · Enter 确认（默认开始新会话）· Ctrl+C 退出</Text>
    </Box>
  );
}
