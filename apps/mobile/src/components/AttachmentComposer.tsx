import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import type { DraftAttachment } from '../attachments/useAttachments';
import { colors, spacing } from '../theme';

export default function AttachmentComposer({
  files,
  onRemove,
  onRetry,
}: {
  files: DraftAttachment[];
  onRemove: (id: string) => void;
  onRetry: (file: DraftAttachment) => void;
}) {
  if (!files.length) return null;
  return (
    <ScrollView
      horizontal
      style={{ maxHeight: 160, backgroundColor: colors.surface }}
      contentContainerStyle={{ padding: spacing.sm, gap: spacing.sm }}
    >
      {files.map((file) => (
        <View
          key={file.id}
          style={{
            width: 180,
            padding: spacing.sm,
            borderRadius: 8,
            borderWidth: 1,
            borderColor:
              file.status === 'failed' ? colors.danger : colors.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text
              numberOfLines={1}
              style={{ flex: 1, color: colors.textPrimary, fontSize: 13 }}
            >
              📎 {file.file.name}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`移除附件 ${file.file.name}`}
              onPress={() => onRemove(file.id)}
              style={{
                minHeight: 44,
                minWidth: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: colors.textMuted }}>✕</Text>
            </Pressable>
          </View>
          {file.status === 'uploading' ? (
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                {file.progress.phase === 'preparing'
                  ? '准备文件…'
                  : file.progress.phase === 'verifying'
                    ? '校验中…'
                    : `上传中 ${Math.round(file.progress.progress * 100)}%`}
              </Text>
            </View>
          ) : file.status === 'failed' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onRetry(file)}
              style={{ minHeight: 44 }}
            >
              <Text
                numberOfLines={2}
                style={{ color: colors.danger, fontSize: 12 }}
              >
                {file.error} · 点击重试
              </Text>
            </Pressable>
          ) : (
            <Text style={{ color: colors.success, fontSize: 12 }}>
              ✓ 已上传 · {Math.ceil(file.file.size / 1024)} KB
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
