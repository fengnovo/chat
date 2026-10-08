import React from 'react';
import Markdown from 'react-native-markdown-display';
import { StyleSheet, Text, View, Pressable } from 'react-native';

import type { ChatAttachment } from '../api/types';
import { useMedia } from '../media/MediaProvider';
import MessageImage from './MessageImage';
import { colors, markdownStyles, spacing } from '../theme';

export const UserMessage = React.memo(function UserMessage({
  text,
  attachments,
}: {
  text: string;
  attachments?: ChatAttachment[];
}) {
  return (
    <View style={styles.row}>
      <View style={styles.userBubble}>
        {attachments?.map((attachment) => (
          <View key={attachment.id} style={{ marginBottom: spacing.sm }}>
            {attachment.kind === 'image' ? (
              <MessageImage url={attachment.url} label={attachment.filename} />
            ) : null}
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              📎 {attachment.filename} ·{' '}
              {Math.ceil(attachment.sizeBytes / 1024)} KB
            </Text>
          </View>
        ))}
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
  sessionId,
}: {
  sessionId: string;
  text: string;
  streaming?: boolean;
}) {
  const { openLink } = useMedia();
  const rules = React.useMemo(
    () => ({
      image: (node: { key: string; attributes: Record<string, string> }) => (
        <MessageImage
          key={node.key}
          url={node.attributes.src}
          label={node.attributes.alt}
        />
      ),
    }),
    [],
  );
  return (
    <View style={[styles.row, { justifyContent: 'flex-start' }]}>
      <View style={styles.assistantBubble}>
        <Markdown
          style={markdownStyles}
          rules={rules}
          onLinkPress={(url) => {
            openLink(url, sessionId);
            return false;
          }}
        >
          {text}
        </Markdown>
        {/打开页面预览|preview_page/.test(text) &&
        !text.includes('(preview://open)') ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => openLink('preview://open', sessionId)}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.accent }}>打开页面预览</Text>
          </Pressable>
        ) : null}
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
