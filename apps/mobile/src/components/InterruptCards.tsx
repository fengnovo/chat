import React, { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

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
  onRespond: (approve: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const respond = async (approve: boolean) => {
    setBusy(true);
    try {
      await onRespond(approve);
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
      {request.actions.map((action) => (
        <View key={`${action.name}-${action.summary.slice(0, 16)}`}>
          <Text style={{ color: colors.textPrimary, fontSize: 13, fontFamily: 'monospace' }}>
            {action.name}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{action.summary}</Text>
        </View>
      ))}
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs }}>
          <Pressable
            onPress={() => void respond(false)}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.danger,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: colors.danger, fontWeight: '600' }}>拒绝</Text>
          </Pressable>
          <Pressable
            onPress={() => void respond(true)}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              backgroundColor: colors.success,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#ffffff', fontWeight: '600' }}>允许</Text>
          </Pressable>
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
    if (selections.length === 0 && !custom) return;
    setBusy(true);
    try {
      await onRespond(selections, custom || undefined);
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
        Agent 提问
      </Text>
      <Text style={{ color: colors.textPrimary, fontSize: 14 }}>{request.question}</Text>
      <View style={{ gap: spacing.sm }}>
        {request.options.map((option, index) => {
          const active = selected.includes(index);
          return (
            <Pressable
              key={`${index}-${option.label}`}
              onPress={() => toggle(index)}
              style={{
                borderWidth: 1,
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active ? colors.surfaceElevated : 'transparent',
                borderRadius: 8,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
              }}
            >
              <Text style={{ color: active ? colors.accent : colors.textPrimary, fontSize: 14 }}>
                {request.multiple ? (active ? '☑ ' : '☐ ') : active ? '◉ ' : '○ '}
                {option.label}
              </Text>
              {option.description ? (
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
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
          value={customText}
          onChangeText={setCustomText}
          placeholder="补充说明（可选）"
          placeholderTextColor={colors.textMuted}
          multiline
        />
      ) : null}
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Pressable
          onPress={() => void submit()}
          style={{
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: colors.accent,
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
