import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { RootStackParamList } from '../App';
import { api } from '../api/client';
import type { SessionSummary } from '../api/types';
import { useAuth } from '../store/auth';
import { card, colors, inputStyle, primaryButton, primaryButtonText, spacing } from '../theme';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function SessionsScreen() {
  const navigation = useNavigation<Navigation>();
  const { user, logout } = useAuth();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameText, setRenameText] = useState('');

  const loadFirstPage = useCallback(async () => {
    try {
      setError(null);
      const result = await api.listSessions();
      setSessions(result.data);
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
    // 每次进入该页面都刷新（从聊天页返回时能看到最新标题）。
    const unsubscribe = navigation.addListener('focus', () => {
      void loadFirstPage();
    });
    return unsubscribe;
  }, [loadFirstPage, navigation]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.listSessions(nextCursor);
      setSessions((prev) => [...prev, ...result.data]);
      setNextCursor(result.nextCursor);
    } catch {
      // 追加失败不打断列表，用户可下拉刷新重试。
    } finally {
      setLoadingMore(false);
    }
  };

  const createSession = async () => {
    try {
      const session = await api.createSession();
      navigation.navigate('Chat', { sessionId: session.id, title: session.title });
    } catch (err) {
      Alert.alert('新建失败', err instanceof Error ? err.message : '未知错误');
    }
  };

  const confirmDelete = (session: SessionSummary) => {
    Alert.alert('删除会话', `确定删除「${session.title}」？该操作不可恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteSession(session.id);
            setSessions((prev) => prev.filter((item) => item.id !== session.id));
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : '未知错误');
          }
        },
      },
    ]);
  };

  const submitRename = async () => {
    const title = renameText.trim();
    if (!renaming || !title) return;
    try {
      const updated = await api.renameSession(renaming.id, title);
      setSessions((prev) =>
        prev.map((item) => (item.id === updated.id ? { ...item, title } : item)),
      );
    } catch (err) {
      Alert.alert('重命名失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setRenaming(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {error ? (
        <Text style={{ color: colors.danger, padding: spacing.md, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}

      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.accent}
            onRefresh={() => {
              setRefreshing(true);
              void loadFirstPage();
            }}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadMore()}
        ListHeaderComponent={
          <Pressable
            onPress={createSession}
            style={[card, {
              margin: spacing.md,
              padding: spacing.lg,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: spacing.sm,
            }]}
          >
            <Text style={{ color: colors.accent, fontSize: 20, fontWeight: '600' }}>＋</Text>
            <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>
              新建会话
            </Text>
          </Pressable>
        }
        ListEmptyComponent={
          !loading ? (
            <Text
              style={{ color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl }}
            >
            {refreshing ? '' : '暂无会话，点击上方新建'}
            </Text>
          ) : null
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.md }} />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              navigation.navigate('Chat', { sessionId: item.id, title: item.title })
            }
            onLongPress={() =>
              Alert.alert(item.title, undefined, [
                {
                  text: '重命名',
                  onPress: () => {
                    setRenameText(item.title);
                    setRenaming(item);
                  },
                },
                { text: '删除', style: 'destructive', onPress: () => confirmDelete(item) },
                { text: '取消', style: 'cancel' },
              ])
            }
            style={[card, {
              marginHorizontal: spacing.md,
              marginVertical: spacing.xs,
              padding: spacing.lg,
            }]}
          >
            <Text
              numberOfLines={1}
              style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '600' }}
            >
              {item.title}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: spacing.xs }}>
              更新于 {formatTime(item.updatedAt)}
            </Text>
          </Pressable>
        )}
      />

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        }}
      >
        <View>
          <Text style={{ color: colors.textPrimary, fontSize: 14, fontWeight: '600' }}>
            {user?.displayName ?? '未登录'}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {user?.role ? `角色：${user.role}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={() => void logout()}
          style={{
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>退出登录</Text>
        </Pressable>
      </View>

      <Modal
        visible={renaming !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(null)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'center',
            padding: spacing.xl,
          }}
        >
          <View style={[card, { backgroundColor: colors.surfaceElevated, padding: spacing.lg, gap: spacing.md }]}>
            <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '600' }}>
              重命名会话
            </Text>
            <TextInput
              style={inputStyle}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              maxLength={120}
            />
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Pressable
                onPress={() => setRenaming(null)}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: colors.textSecondary }}>取消</Text>
              </Pressable>
              <Pressable onPress={submitRename} style={[primaryButton, { flex: 1 }]}>
                <Text style={primaryButtonText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
