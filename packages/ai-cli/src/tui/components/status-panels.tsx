import { Box, Text } from 'ink';
import React from 'react';

import type { LogListProps, TodoListProps } from '../types.js';

export function TodoList({ todos }: TodoListProps): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>📋 任务清单</Text>
      {todos.length === 0 ? (
        <Text dimColor>  （简单对话无需清单；复杂任务会自动拆解并显示在这里）</Text>
      ) : (
        todos.map((todo, index) => {
          if (todo.status === 'completed') {
            return (
              <Box key={index}>
                <Text color="green">✓</Text>
                <Text>{' '}</Text>
                <Text dimColor strikethrough>
                  {todo.content}
                </Text>
              </Box>
            );
          }
          if (todo.status === 'in_progress') {
            return (
              <Box key={index}>
                <Text color="yellow">►</Text>
                <Text>{' '}</Text>
                <Text color="cyan">{todo.content}</Text>
              </Box>
            );
          }
          return (
            <Box key={index}>
              <Text dimColor>○</Text>
              <Text> {todo.content}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

export function LogList({ logs }: LogListProps): JSX.Element {
  const tail = logs.slice(-10);
  return (
    <Box flexDirection="column">
      <Text bold>📜 执行日志</Text>
      {tail.length === 0 ? (
        <Text dimColor>  （暂无）</Text>
      ) : (
        tail.map((line, index) => (
          <Box key={index}>
            <Text>  {line}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
