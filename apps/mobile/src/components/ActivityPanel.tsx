import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { colors, spacing } from '../theme';

export type ActivityItem =
  | { kind: 'tool'; invocationId: string; tool: string; summary: string; running: boolean }
  | { kind: 'note'; summary: string };

function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return tool;
  const record = input as Record<string, unknown>;
  const hint =
    record.file_path ?? record.path ?? record.command ?? record.pattern ?? record.query ?? '';
  return hint ? `${tool} · ${String(hint).slice(0, 80)}` : tool;
}

export function toolStartedItem(
  invocationId: string,
  tool: string,
  input: unknown,
): ActivityItem {
  return {
    kind: 'tool',
    invocationId,
    tool,
    summary: summarizeToolInput(tool, input),
    running: true,
  };
}

/** 工具调用与过程旁白的可折叠面板：执行过程不混入最终答复正文。 */
export default function ActivityPanel({ items }: { items: ActivityItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const runningCount = items.filter(
    (item) => item.kind === 'tool' && item.running,
  ).length;
  const title = runningCount > 0 ? `执行中（${runningCount} 个工具）` : `过程（${items.length} 条）`;
  return (
    <View
      style={{
        marginHorizontal: spacing.md,
        marginVertical: spacing.xs,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        backgroundColor: colors.surface,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
        }}
      >
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{title}</Text>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {expanded ? '收起 ▲' : '展开 ▼'}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.xs }}>
          {items.map((item, index) => (
            <Text
              key={item.kind === 'tool' ? item.invocationId : `note-${index}`}
              style={{
                color: item.kind === 'tool' && item.running ? colors.warning : colors.textMuted,
                fontSize: 12,
                fontFamily: 'monospace',
              }}
            >
              {item.kind === 'tool'
                ? `${item.running ? '▶' : '✓'} ${item.summary}`
                : `· ${item.summary}`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
