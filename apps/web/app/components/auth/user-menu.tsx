'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { logout } from '../resilient-chat/api';
import { Icon } from '../resilient-chat/icon';
import { useAuth } from './auth-context';

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  owner: '知识库拥有者',
  member: '成员',
};

// 右上角头像菜单：悬停/聚焦展开浮层，展示角色与导航，提供退出登录。
// 触屏无 hover 时可点击头像切换；Esc 或点击外部关闭。
export function UserMenu() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  // dev 模式下 API 对所有请求注入固定身份，Cookie 无意义，退出登录不可能生效。
  const isDevMode = user.authMode === 'dev';
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;

  const handleLogout = async () => {
    await logout().catch(() => undefined);
    await refresh();
    router.replace('/login');
  };

  return (
    <div className={`user-badge ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="user-badge-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="账号菜单"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="user-badge-avatar" aria-hidden="true">
          <Icon name="user" size={18} />
        </span>
        <span className="user-badge-name">{user.displayName}</span>
      </button>

      <div className="user-badge-popover" role="menu">
        <div className="user-badge-head">
          <span className="user-badge-avatar is-lg" aria-hidden="true">
            <Icon name="user" size={22} />
          </span>
          <div className="user-badge-meta">
            <p className="user-badge-display-name">{user.displayName}</p>
            <span className={`user-badge-role is-${user.role}`}>{roleLabel}</span>
          </div>
        </div>

        <nav className="user-badge-links" aria-label="页面导航">
          <Link href="/" onClick={() => setOpen(false)}>
            <Icon name="home" size={15} />
            首页
          </Link>
          <Link href="/knowledge" onClick={() => setOpen(false)}>
            <Icon name="layers" size={15} />
            知识库
          </Link>
          {user.role === 'admin' && (
            <Link href="/admin/users" onClick={() => setOpen(false)}>
              <Icon name="shield" size={15} />
              用户管理
            </Link>
          )}
        </nav>

        {isDevMode ? (
          <p className="user-badge-dev-hint" title="设置 AUTH_MODE=password 后可使用账号密码登录与退出">
            开发免登录模式（AUTH_MODE=dev）
          </p>
        ) : (
          <button
            type="button"
            className="user-badge-logout"
            role="menuitem"
            onClick={() => void handleLogout()}
          >
            <Icon name="logout" size={15} />
            退出登录
          </button>
        )}
      </div>
    </div>
  );
}
