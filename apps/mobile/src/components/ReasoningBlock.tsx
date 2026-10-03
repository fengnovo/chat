import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { colors, spacing } from '../theme';

/** 模型思考过程（assistant.reasoning 流式拼接），默认折叠、不打断正文。 */
export default function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
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
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          {streaming ? '思考中…' : '思考过程'}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {expanded ? '收起 ▲' : '展开 ▼'}
        </Text>
      </Pressable>
      {expanded ? (
        <Text
          style={{
            paddingHorizontal: spacing.md,
            paddingBottom: spacing.md,
            color: colors.textSecondary,
            fontSize: 13,
            lineHeight: 19,
          }}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}
