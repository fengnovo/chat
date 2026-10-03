import type { TextStyle, ViewStyle } from 'react-native';

export const colors = {
  background: '#0b0f14',
  surface: '#131a23',
  surfaceElevated: '#1a2330',
  border: '#253040',
  textPrimary: '#e8eef5',
  textSecondary: '#94a3b3',
  textMuted: '#64748b',
  accent: '#4f8cff',
  accentPressed: '#3b6fd4',
  userBubble: '#2b5c46',
  assistantBubble: '#131a23',
  danger: '#ef4444',
  warning: '#f59e0b',
  success: '#22c55e',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export const card: ViewStyle = {
  backgroundColor: colors.surface,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: colors.border,
};

export const inputStyle: TextStyle = {
  backgroundColor: colors.surface,
  borderColor: colors.border,
  borderWidth: 1,
  borderRadius: 10,
  color: colors.textPrimary,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 15,
};

export const primaryButton: ViewStyle = {
  backgroundColor: colors.accent,
  borderRadius: 10,
  paddingVertical: 12,
  alignItems: 'center',
};

export const primaryButtonText: TextStyle = {
  color: '#ffffff',
  fontSize: 15,
  fontWeight: '600',
};

// react-native-markdown-display 的 style 接受 RN 命名样式对象，
// 这里保持无注解推断（值均为合法 TextStyle / ViewStyle 属性）。
export const markdownStyles = {
  body: { color: colors.textPrimary, fontSize: 15 },
  heading1: { color: colors.textPrimary, fontSize: 22, fontWeight: '700' as const },
  heading2: { color: colors.textPrimary, fontSize: 19, fontWeight: '700' as const },
  heading3: { color: colors.textPrimary, fontSize: 17, fontWeight: '600' as const },
  link: { color: colors.accent },
  code_inline: {
    color: '#f472b6',
    backgroundColor: '#1e293b',
    fontFamily: 'monospace',
  },
  fence: {
    color: colors.textPrimary,
    backgroundColor: '#0f1720',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  blockquote: {
    color: colors.textSecondary,
    borderLeftColor: colors.accent,
    borderLeftWidth: 3,
    paddingLeft: 10,
  },
  bullet_list_icon: { color: colors.accent },
  strong: { fontWeight: '700' as const },
  hr: { backgroundColor: colors.border },
};
