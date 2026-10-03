import React from 'react';
import Markdown from 'react-native-markdown-display';
import { StyleSheet, View } from 'react-native';

import { colors, markdownStyles, spacing } from '../theme';

export function UserMessage({ text }: { text: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.userBubble}>
        <Markdown style={markdownStyles}>{text}</Markdown>
      </View>
    </View>
  );
}

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
    maxWidth: '90%',
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
