import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatDetail, type ActivityItem } from '../chat/activity';
import { colors, spacing } from '../theme';

function ToolRow({ item }: { item: Extract<ActivityItem, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const status = item.running ? '执行中' : item.failed ? '失败' : '完成';
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text
          style={{
            color: item.failed
              ? colors.danger
              : item.running
                ? colors.warning
                : colors.textSecondary,
            fontSize: 13,
          }}
        >
          {item.running ? '▶' : item.failed ? '✕' : '✓'} {item.summary} ·{' '}
          {status} {expanded ? '▲' : '▼'}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={{ gap: spacing.xs, paddingBottom: spacing.sm }}>
          {item.input !== undefined ? (
            <>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                请求参数
              </Text>
              <Text
                selectable
                style={{
                  color: colors.textSecondary,
                  fontSize: 12,
                  fontFamily: 'monospace',
                }}
              >
                {formatDetail(item.input)}
              </Text>
            </>
          ) : null}
          {item.output !== undefined ? (
            <>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                返回结果
              </Text>
              <Text
                selectable
                style={{
                  color: item.failed ? colors.danger : colors.textSecondary,
                  fontSize: 12,
                  fontFamily: 'monospace',
                }}
              >
                {formatDetail(item.output)}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Execution details belong to their assistant turn, including after completion. */
export default function ActivityPanel({ items }: { items: ActivityItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const running = items.filter(
    (item) => item.kind === 'tool' && item.running,
  ).length;
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
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{
          minHeight: 44,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: spacing.md,
        }}
      >
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          {running
            ? `正在执行 · ${running} 个工具`
            : `执行过程 · ${items.length} 条`}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {expanded ? '收起 ▲' : '展开 ▼'}
        </Text>
      </Pressable>
      {expanded ? (
        <View
          style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.sm }}
        >
          {items.map((item, index) =>
            item.kind === 'tool' ? (
              <ToolRow key={item.invocationId} item={item} />
            ) : (
              <Text
                key={`note-${index}`}
                selectable
                style={{
                  color: colors.textSecondary,
                  fontSize: 13,
                  paddingVertical: spacing.xs,
                }}
              >
                · {item.summary}
              </Text>
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}
