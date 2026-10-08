import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { api, ApiError } from '../api/client';
import type { CurrentUser } from '../api/types';

interface AuthContextValue {
  restoring: boolean;
  restoreError: string | null;
  retryRestore: () => void;
  lastChat: { sessionId: string; title: string } | null;
  user: CurrentUser | null;
  login: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const retryRestore = useCallback(
    () => setRestoreAttempt((attempt) => attempt + 1),
    [],
  );
  const [lastChat, setLastChat] = useState<{
    sessionId: string;
    title: string;
  } | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [user, setUser] = useState<CurrentUser | null>(null);

  // 冷启动：从 SecureStore 恢复 token / 服务器地址，并用 /auth/me 验证有效性。
  useEffect(() => {
    let cancelled = false;
    setRestoring(true);
    setRestoreError(null);
    (async () => {
      try {
        if (await api.restore()) {
          const me = await api.me();
          let chat = await api.rememberedChat();
          if (chat) {
            try {
              const session = await api.getSession(chat.sessionId);
              chat = { sessionId: session.id, title: session.title };
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) {
                await api.forgetChat();
                chat = null;
              } else throw error;
            }
          }
          if (!cancelled) {
            setUser(me);
            setLastChat(chat);
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          api.configure('', null);
          await api.persist();
          await api.forgetChat();
        } else if (!cancelled) {
          setRestoreError(
            `无法恢复连接：${error instanceof Error ? error.message : '请检查网络'}`,
          );
        }
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  const login = useCallback(
    async (serverUrl: string, username: string, password: string) => {
      const result = await api.login(serverUrl, username, password);
      await api.persist();
      setLastChat(null);
      setUser(result.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      await api.persist();
      setLastChat(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      restoring,
      restoreError,
      retryRestore,
      user,
      lastChat,
      login,
      logout,
    }),
    [restoring, restoreError, retryRestore, user, lastChat, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}
