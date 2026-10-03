import type { AgentEvent } from '@repo/contracts';

/** 会话记录（与 apps/api sessions 路由返回一致，字段按需取子集）。 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 运行记录（POST /sessions/:id/runs 响应）。 */
export interface RunRecord {
  id: string;
  sessionId: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_approval'
    | 'waiting_question'
    | 'completed'
    | 'failed'
    | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/** GET /sessions/:id/history 返回的消息条目。 */
export interface HistoryMessage {
  id: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  reasoning?: string;
}

export interface HistoryResponse {
  session: SessionSummary;
  messages: HistoryMessage[];
  latestRun: RunRecord | null;
}

export interface CurrentUser {
  id: string;
  displayName: string;
  role: string;
  tenantId: string;
  authMode?: string;
}

/** SSE data-agent 事件（服务端持久化后的 AgentEvent + seq）。 */
export type StreamAgentEvent = AgentEvent & { seq: number };
