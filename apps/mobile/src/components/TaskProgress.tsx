import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

export default function TaskProgress({
  todos,
}: {
  todos: { content: string; status: string }[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (!todos.length) return null;
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress');
  return (
    <View
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: 44, justifyContent: 'center', gap: 4 }}
      >
        <Text style={{ color: colors.textSecondary }}>
          任务进度 {completed}/{todos.length}　{expanded ? '收起 ▲' : '展开 ▼'}
        </Text>
        {!expanded && current ? (
          <Text
            numberOfLines={1}
            style={{ color: colors.accent, fontSize: 12 }}
          >
            ▶ {current.content}
          </Text>
        ) : null}
      </Pressable>
      {expanded
        ? todos.map((todo, index) => (
            <Text
              key={`${index}-${todo.content}`}
              style={{
                color:
                  todo.status === 'completed'
                    ? colors.textMuted
                    : colors.textPrimary,
                paddingVertical: 4,
                fontSize: 13,
              }}
            >
              {todo.status === 'completed'
                ? '✓'
                : todo.status === 'in_progress'
                  ? '▶'
                  : '○'}{' '}
              {todo.content}
            </Text>
          ))
        : null}
    </View>
  );
}
