import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { api } from '../api/client';
import type { CurrentUser } from '../api/types';

interface AuthContextValue {
  restoring: boolean;
  user: CurrentUser | null;
  login: (serverUrl: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [restoring, setRestoring] = useState(true);
  const [user, setUser] = useState<CurrentUser | null>(null);

  // 冷启动：从 SecureStore 恢复 token / 服务器地址，并用 /auth/me 验证有效性。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (await api.restore()) {
          const me = await api.me();
          if (!cancelled) setUser(me);
        }
      } catch {
        await api.configure('', null);
        await api.persist();
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (serverUrl: string, username: string, password: string) => {
      const result = await api.login(serverUrl, username, password);
      await api.persist();
      setUser(result.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      await api.persist();
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ restoring, user, login, logout }),
    [restoring, user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}
