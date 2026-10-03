import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '../store/auth';
import { colors, inputStyle, primaryButton, primaryButtonText, spacing } from '../theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!serverUrl.trim() || !username.trim() || !password) {
      setError('请填写服务器地址、用户名和密码');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(serverUrl.trim(), username.trim(), password);
    } catch (err) {
      const message = err instanceof Error ? err.message : '登录失败';
      setError(
        message.includes('401') || message.includes('invalid_credentials')
          ? '用户名或密码错误'
          : `无法连接服务器：${message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: spacing.md }}>
          <View style={{ alignItems: 'center', marginBottom: spacing.xl }}>
            <Text style={{ fontSize: 32, fontWeight: '700', color: colors.textPrimary }}>
              Keen AI
            </Text>
            <Text style={{ color: colors.textSecondary, marginTop: spacing.xs }}>
              Coding Agent 移动客户端
            </Text>
          </View>

          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>服务器地址</Text>
          <TextInput
            style={inputStyle}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="http://10.0.2.2:8002"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            指向 Agent API（本仓库 .env 中 PORT，默认开发端口 8002）。模拟器访问本机可填
            http://127.0.0.1:8002（iOS）或 http://10.0.2.2:8002（Android）；真机请填电脑局域网 IP。
          </Text>

          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>用户名</Text>
          <TextInput
            style={inputStyle}
            value={username}
            onChangeText={setUsername}
            placeholder="admin"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>密码</Text>
          <TextInput
            style={inputStyle}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
          />

          {error ? (
            <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text>
          ) : null}

          <Pressable
            onPress={submit}
            disabled={submitting}
            style={({ pressed }) => [
              primaryButton,
              pressed && { backgroundColor: colors.accentPressed },
              submitting && { opacity: 0.6 },
            ]}
          >
            {submitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={primaryButtonText}>登录</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
