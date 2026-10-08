import React from 'react';
import Markdown from 'react-native-markdown-display';
import { StyleSheet, Text, View } from 'react-native';

import { colors, markdownStyles, spacing } from '../theme';

export const UserMessage = React.memo(function UserMessage({
  text,
}: {
  text: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.userBubble}>
        <Text
          selectable
          style={{ color: colors.textPrimary, fontSize: 15, lineHeight: 23 }}
        >
          {text}
        </Text>
      </View>
    </View>
  );
});

export function AssistantMessage({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <View style={[styles.row, { justifyContent: 'flex-start' }]}>
      <View style={styles.assistantBubble}>
        <Markdown style={markdownStyles}>{text}</Markdown>
        {streaming ? (
          <View style={styles.cursor}>
            <View style={styles.cursorDot} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
    marginVertical: spacing.xs,
  },
  userBubble: {
    backgroundColor: colors.userBubble,
    borderRadius: 14,
    borderTopRightRadius: 4,
    padding: spacing.md,
    maxWidth: '85%',
  },
  assistantBubble: {
    backgroundColor: colors.assistantBubble,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    padding: spacing.md,
    width: '100%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cursor: {
    flexDirection: 'row',
    marginTop: spacing.xs,
  },
  cursorDot: {
    width: 8,
    height: 14,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
});
