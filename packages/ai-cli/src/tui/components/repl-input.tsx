import { Box, Text, useInput } from 'ink';
import React, { useCallback, useRef, useSyncExternalStore } from 'react';

import { IS_TTY } from '../constants.js';
import { editReplBuffer, splitReplCursor } from '../repl-input.js';
import { tuiStore } from '../store.js';
import type { IdleInputKey, ReplInputKey, ReplInputProps } from '../types.js';

export function ReplInput({ onSubmit }: ReplInputProps): JSX.Element {
  const state = useSyncExternalStore(tuiStore.subscribe, tuiStore.getState);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const handler = useCallback((input: string, key: ReplInputKey) => {
    if (key.ctrl && input === 'c') {
      process.exit(0);
      return;
    }
    const current = tuiStore.getState();
    const value = current.replInput;

    if (key.return) {
      tuiStore.setState({ replInput: '', replCursor: 0 });
      if (value.trim()) onSubmitRef.current(value);
      return;
    }
    const next = editReplBuffer(
      { value, cursor: current.replCursor },
      input,
      key,
    );
    if (next.value !== value || next.cursor !== current.replCursor) {
      tuiStore.setState({ replInput: next.value, replCursor: next.cursor });
    }
  }, []);

  useInput(handler, { isActive: IS_TTY });

  const view = splitReplCursor({ value: state.replInput, cursor: state.replCursor });
  return (
    <Box>
      <Text color="cyan">{state.replPrompt}</Text>
      <Text>{view.before}</Text>
      <Text inverse color="white">
        {view.cursorText}
      </Text>
      <Text>{view.after}</Text>
    </Box>
  );
}

export function IdleInput(): JSX.Element {
  const handler = useCallback((input: string, key: IdleInputKey) => {
    if (key.ctrl && input === 'c') process.exit(0);
  }, []);
  useInput(handler, { isActive: IS_TTY });
  return <Text>{' '}</Text>;
}
