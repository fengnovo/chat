import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { FocusEvent } from 'react-native';

import { useAuth } from '../store/auth';
import { colors, inputStyle, primaryButton, primaryButtonText, spacing } from '../theme';

const defaultServerUrl = __DEV__
  ? (Platform.OS === 'android' ? 'http://10.0.2.2:8002' : 'http://127.0.0.1:8002')
  : 'https://chat.keen-tech.top';

export default function LoginScreen() {
  const { login } = useAuth();
  const scrollViewRef = useRef<ScrollView>(null);
  const focusedInputRef = useRef<number | null>(null);
  const keyboardVisibleRef = useRef(false);
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revealFocusedInput = useCallback(() => {
    const target = focusedInputRef.current;
    if (Platform.OS === 'android' && target !== null) {
      scrollViewRef.current?.scrollResponderScrollNativeHandleToKeyboard(
        target,
        spacing.md,
        true,
      );
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisibleRef.current = true;
      revealFocusedInput();
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisibleRef.current = false;
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [revealFocusedInput]);

  const handleInputFocus = useCallback(
    (event: FocusEvent) => {
      focusedInputRef.current = event.nativeEvent.target;
      if (keyboardVisibleRef.current) revealFocusedInput();
    },
    [revealFocusedInput],
  );

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
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scrollViewRef}
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
              Keen Chat
            </Text>
            <Text style={{ color: colors.textSecondary, marginTop: spacing.xs }}>
              {__DEV__ ? 'Debug · 本地开发' : 'Release · 线上服务'}
            </Text>
          </View>

          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>服务器地址</Text>
          <TextInput
            style={inputStyle}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder={defaultServerUrl}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onFocus={handleInputFocus}
          />
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {__DEV__
              ? '默认连接本机 API，需启动 API、Worker 和 Metro。真机调试请改为电脑局域网 IP。'
              : '默认连接线上服务，使用线上账号登录，无需 Metro。'}
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
            onFocus={handleInputFocus}
          />

          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>密码</Text>
          <TextInput
            style={inputStyle}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            onFocus={handleInputFocus}
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
