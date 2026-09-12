import { useEffect, useRef } from 'react';

import { Icon } from './icon';
import { formatSessionTime } from './utils';
import type { WebSessionSummary } from './types';

function Sidebar({
  activeChatId,
  busy,
  creating,
  error,
  hasMore,
  inactive,
  loaded,
  loadingMore,
  menuSessionId,
  onDelete,
  onClose,
  onLoadMore,
  onMenu,
  onNewChat,
  onRename,
  onRefresh,
  onSelect,
  open,
  sessions,
  switchingSessionId,
}: {
  activeChatId: string;
  busy: boolean;
  creating: boolean;
  error: string | null;
  hasMore: boolean;
  inactive: boolean;
  loaded: boolean;
  loadingMore: boolean;
  menuSessionId: string | null;
  onDelete: (session: WebSessionSummary) => void;
  onClose: () => void;
  onLoadMore: () => void;
  onMenu: (sessionId: string | null) => void;
  onNewChat: () => void;
  onRename: (session: WebSessionSummary) => void;
  onRefresh: () => void;
  onSelect: (session: WebSessionSummary) => void;
  open: boolean;
  sessions: WebSessionSummary[];
  switchingSessionId: string | null;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  return (
    <aside className="sidebar" inert={inactive || undefined}>
      <div className="brand">
        <span className="brand-mark">
          <Icon name="layers" size={20} />
        </span>
        <span>
          <strong>Keen Agent</strong>
        </span>
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
        aria-label="新建对话"
        className="new-chat-button"
        disabled={creating}
        type="button"
        onClick={onNewChat}
      >
        <Icon name="plus" size={17} />
        <span>{creating ? '正在创建…' : '新建对话'}</span>
      </button>

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
          const menuOpen = menuSessionId === session.id;
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
              <button
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={`管理对话：${session.title}`}
                className="session-more"
                type="button"
                onClick={() => onMenu(menuOpen ? null : session.id)}
              >
                <Icon name="more" size={17} />
              </button>
              {menuOpen && (
                <div className="session-menu" role="menu">
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => onRename(session)}
                  >
                    <Icon name="edit" size={15} />
                    重命名
                  </button>
                  <button
                    className="is-danger"
                    role="menuitem"
                    type="button"
                    onClick={() => onDelete(session)}
                  >
                    <Icon name="trash" size={15} />
                    删除
                  </button>
                </div>
              )}
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

      <div className="system-card">
        <div className="system-card-head">
          <span className="status-dot" />
          <strong>Services connected</strong>
        </div>
        <p>API · Queue · Worker · Storage</p>
        <div className="protection-meter">
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
    </aside>
  );
}

export { Sidebar };
