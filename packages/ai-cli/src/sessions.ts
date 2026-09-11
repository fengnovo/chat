/**
 * 会话持久化：
 * - 对话状态（消息历史、todos、中断点）由 LangGraph SqliteSaver 落到
 *   sessions/checkpoints.db，进程退出后不丢，按 thread_id 恢复；
 * - 会话元数据（标题、时间、任务数）维护在 sessions/index.json，
 *   用于启动时列出历史会话。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface SessionMeta {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 该会话累计执行的任务（用户输入）条数 */
  tasks: number;
}

export class SessionStore {
  readonly dir: string;
  /** SqliteSaver 的数据库文件路径 */
  readonly dbPath: string;
  private readonly indexPath: string;
  private sessions: SessionMeta[];

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'sessions');
    this.dbPath = path.join(this.dir, 'checkpoints.db');
    this.indexPath = path.join(this.dir, 'index.json');
    mkdirSync(this.dir, { recursive: true });
    this.sessions = this.load();
  }

  private load(): SessionMeta[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as { sessions?: SessionMeta[] };
      return Array.isArray(raw.sessions) ? raw.sessions : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    writeFileSync(this.indexPath, JSON.stringify({ sessions: this.sessions }, null, 2));
  }

  /** 按最后活跃时间倒序返回全部会话 */
  list(): SessionMeta[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 记录一次任务执行：新会话用 titleForNew（首条用户输入）作标题，
   * 已有会话只更新活跃时间与任务数。
   */
  recordTask(threadId: string, titleForNew: string): void {
    const now = Date.now();
    const existing = this.sessions.find((s) => s.threadId === threadId);
    if (existing) {
      existing.updatedAt = now;
      existing.tasks += 1;
    } else {
      this.sessions.push({
        threadId,
        title: titleForNew || '未命名会话',
        createdAt: now,
        updatedAt: now,
        tasks: 1,
      });
    }
    this.persist();
  }
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / MM-DD */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 会话标题：取首行、截断到 maxLen */
export function titleOf(userInput: string, maxLen = 40): string {
  const firstLine = userInput.split('\n')[0].trim();
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
}
