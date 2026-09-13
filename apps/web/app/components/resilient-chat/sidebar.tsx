import Image from 'next/image';

import { useEffect, useRef } from 'react';

import { Icon } from './icon';
import { formatSessionTime } from './utils';
import type { WebSessionSummary } from './types';

function Sidebar({
  activeChatId,
  busy,
  collapsed,
  creating,
  error,
  hasMore,
  inactive,
  loaded,
  loadingMore,
  onClose,
  onLoadMore,
  onNewChat,
  onRefresh,
  onSelect,
  onToggleCollapse,
  open,
  sessions,
  switchingSessionId,
}: {
  activeChatId: string;
  busy: boolean;
  collapsed: boolean;
  creating: boolean;
  error: string | null;
  hasMore: boolean;
  inactive: boolean;
  loaded: boolean;
  loadingMore: boolean;
  onClose: () => void;
  onLoadMore: () => void;
  onNewChat: () => void;
  onRefresh: () => void;
  onSelect: (session: WebSessionSummary) => void;
  onToggleCollapse: () => void;
  open: boolean;
  sessions: WebSessionSummary[];
  switchingSessionId: string | null;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  return (
    <aside
      className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}
      inert={inactive || undefined}
    >
      <div className="brand">
        <span className="brand-mark">
          <Image
            alt="Keen Agent"
            className="brand-logo"
            height={32}
            src="/keen-ai-logo.png"
            width={32}
          />
        </span>
        {!collapsed && (
          <span>
            <strong>Keen Agent</strong>
          </span>
        )}
        <button
          aria-label="收起左侧栏"
          className="sidebar-collapse"
          type="button"
          onClick={onToggleCollapse}
        >
          <Icon name="chevron" size={16} />
        </button>
        {collapsed && (
          <button
            aria-label="展开左侧栏"
            className="sidebar-expand"
            type="button"
            onClick={onToggleCollapse}
          >
            <Icon name="chevron" size={16} />
          </button>
        )}
        <button
          aria-label="关闭历史对话"
          className="sidebar-close"
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
        >
          <Icon name="x" size={18} />
        </button>
      </div>

      <button
        aria-label={creating ? '正在创建对话' : '新建对话'}
        className="new-chat-button"
        disabled={creating}
        type="button"
        onClick={onNewChat}
      >
        <Icon name="plus" size={17} />
        {!collapsed && <span>{creating ? '正在创建…' : '新建对话'}</span>}
      </button>

      {!collapsed && (
        <nav aria-label="历史对话" className="session-nav">
        {!loaded && <p className="session-list-status">正在加载历史记录…</p>}
        {loaded && error && (
          <button className="session-list-retry" type="button" onClick={onRefresh}>
            {error}，重新加载
          </button>
        )}
        {loaded && !error && sessions.length === 0 && (
          <p className="session-list-status">还没有历史对话</p>
        )}
        {sessions.map((session) => {
          const active = session.externalKey === activeChatId;
          const switching = switchingSessionId === session.id;
          return (
            <div
              className={active ? 'session-item is-active' : 'session-item'}
              key={session.id}
            >
              <button
                aria-current={active ? 'page' : undefined}
                aria-label={`打开对话：${session.title}`}
                className="session-main"
                disabled={busy || switchingSessionId !== null}
                type="button"
                onClick={() => onSelect(session)}
              >
                <span className="session-icon">
                  <Icon name="shield" size={16} />
                </span>
                <span className="session-copy">
                  <strong>{session.title}</strong>
                  <small>
                    {switching
                      ? '正在载入…'
                      : formatSessionTime(session.updatedAt)}
                  </small>
                </span>
              </button>
            </div>
          );
        })}
        {loaded && !error && hasMore && (
          <button
            className="load-more-button"
            disabled={loadingMore}
            type="button"
            onClick={onLoadMore}
          >
            {loadingMore ? '正在加载…' : '加载更多'}
          </button>
        )}
      </nav>
      )}
    </aside>
  );
}

export { Sidebar };
