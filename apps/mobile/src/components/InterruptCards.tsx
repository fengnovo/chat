import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, inputStyle, spacing } from '../theme';

export interface ApprovalRequest {
  runId: string;
  interruptId: string;
  actions: { name: string; summary: string }[];
}

/** 人工审批卡片：列出待批准的命令/操作，允许或拒绝。 */
export function ApprovalCard({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (approve: boolean, scope: 'once' | 'session') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (
    approve: boolean,
    scope: 'once' | 'session' = 'once',
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRespond(approve, scope);
    } catch (err) {
      setError(
        `审批提交失败：${err instanceof Error ? err.message : '请重试'}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      style={{
        marginHorizontal: spacing.md,
        marginVertical: spacing.sm,
        borderWidth: 1,
        borderColor: colors.warning,
        borderRadius: 12,
        backgroundColor: colors.surface,
        padding: spacing.lg,
        gap: spacing.sm,
      }}
    >
      <Text style={{ color: colors.warning, fontSize: 14, fontWeight: '700' }}>
        需要人工审批
      </Text>
      {request.actions.map((action, index) => (
        <View key={`${index}-${action.name}`}>
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: 13,
              fontFamily: 'monospace',
            }}
          >
            {action.name}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
            {action.summary}
          </Text>
        </View>
      ))}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.danger }}>
          {error}
        </Text>
      ) : null}
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}
        >
          {[
            { label: '拒绝', approve: false, scope: 'once' as const },
            { label: '仅批准这一次', approve: true, scope: 'once' as const },
            { label: '本会话都允许', approve: true, scope: 'session' as const },
          ].map((option) => (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              onPress={() => void respond(option.approve, option.scope)}
              style={({ pressed }) => ({
                minHeight: 44,
                paddingHorizontal: spacing.md,
                paddingVertical: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: option.approve ? colors.accent : colors.danger,
                backgroundColor:
                  option.approve && option.scope === 'once'
                    ? colors.accent
                    : 'transparent',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={{
                  color: !option.approve
                    ? colors.danger
                    : option.scope === 'once'
                      ? '#ffffff'
                      : colors.accent,
                  fontWeight: '600',
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

export interface QuestionRequest {
  runId: string;
  interruptId: string;
  question: string;
  options: { label: string; description?: string }[];
  multiple: boolean;
  allowCustom: boolean;
}

/** Agent 提问卡片：选项（单选/多选）+ 可选自定义补充。 */
export function QuestionCard({
  request,
  onRespond,
}: {
  request: QuestionRequest;
  onRespond: (
    selections: { index: number; label: string }[],
    customText?: string,
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [customText, setCustomText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (index: number) => {
    setSelected((prev) =>
      request.multiple
        ? prev.includes(index)
          ? prev.filter((item) => item !== index)
          : [...prev, index]
        : prev.includes(index)
          ? []
          : [index],
    );
  };

  const submit = async () => {
    const selections = selected.map((index) => ({
      index,
      label: request.options[index].label,
    }));
    const custom = customText.trim();
    if (busy || (selections.length === 0 && !custom)) return;
    setBusy(true);
    setError(null);
    try {
      await onRespond(selections, custom || undefined);
    } catch (err) {
      setError(
        `回答提交失败：${err instanceof Error ? err.message : '请重试'}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{
        marginHorizontal: spacing.md,
        marginVertical: spacing.sm,
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 12,
        backgroundColor: colors.surface,
        padding: spacing.lg,
        gap: spacing.sm,
      }}
    >
      <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '700' }}>
        需要你选择{request.multiple ? '（可多选）' : '（单选）'}
      </Text>
      <Text style={{ color: colors.textPrimary, fontSize: 14 }}>
        {request.question}
      </Text>
      <View style={{ gap: spacing.sm }}>
        {request.options.map((option, index) => {
          const active = selected.includes(index);
          return (
            <Pressable
              key={`${index}-${option.label}`}
              accessibilityRole={request.multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: active, disabled: busy }}
              disabled={busy}
              onPress={() => toggle(index)}
              style={{
                minHeight: 44,
                borderWidth: 1,
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active
                  ? colors.surfaceElevated
                  : 'transparent',
                borderRadius: 8,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
              }}
            >
              <Text
                style={{
                  color: active ? colors.accent : colors.textPrimary,
                  fontSize: 14,
                }}
              >
                {request.multiple
                  ? active
                    ? '☑ '
                    : '☐ '
                  : active
                    ? '◉ '
                    : '○ '}
                {option.label}
              </Text>
              {option.description ? (
                <Text
                  style={{
                    color: colors.textMuted,
                    fontSize: 12,
                    marginTop: 2,
                  }}
                >
                  {option.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {request.allowCustom ? (
        <TextInput
          style={inputStyle}
          editable={!busy}
          value={customText}
          onChangeText={setCustomText}
          placeholder="补充说明（可选）"
          placeholderTextColor={colors.textMuted}
          multiline
        />
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.danger }}>
          {error}
        </Text>
      ) : null}
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={selected.length === 0 && !customText.trim()}
          accessibilityState={{
            disabled: selected.length === 0 && !customText.trim(),
          }}
          onPress={() => void submit()}
          style={{
            paddingVertical: 10,
            borderRadius: 8,
            minHeight: 44,
            backgroundColor:
              selected.length || customText.trim()
                ? colors.accent
                : colors.surfaceElevated,
            alignItems: 'center',
            marginTop: spacing.xs,
          }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '600' }}>提交回答</Text>
        </Pressable>
      )}
    </View>
  );
}
