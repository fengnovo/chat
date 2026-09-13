'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useAuth } from './auth-context';

// 未登录访问受保护页面时跳转登录页；/login 页面自身不包裹本组件。
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="auth-gate-loading" role="status" aria-live="polite">
        正在加载…
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}
