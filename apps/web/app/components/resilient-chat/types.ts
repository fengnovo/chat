import type { AgentEvent, RunStatus } from '@repo/contracts';
import type { UIMessage } from 'ai';

import type { PersistedRun } from '@/app/lib/persistence';

type PipelineEvent = {
  id: string;
  stage:
    | 'request'
    | 'retry'
    | 'circuit'
    | 'fallback'
    | 'verify'
    | 'transport'
    | 'done';
  status: 'running' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
  timestamp: string;
};

type InsightCard = {
  kind: 'reliability-summary' | 'unsupported-widget';
  eyebrow: string;
  title: string;
  body: string;
  metric: string;
  metric_label: string;
};

type MessageMetadata = {
  createdAt?: string;
  model?: string;
  runId?: string;
};

type ResilientData = {
  agent: AgentEvent;
  pipeline: PipelineEvent;
  card: InsightCard | null;
  suggestions: string[];
  citations: { citations: Citation[] };
};

type ResilientMessage = UIMessage<MessageMetadata, ResilientData>;
type PendingInterrupt = Extract<
  AgentEvent,
  { type: 'approval.required' | 'question.required' }
>;
type AgentTodo = Extract<AgentEvent, { type: 'todo.updated' }>['todos'][number];

type AgentActivityEntry =
  | {
      kind: 'tool';
      id: string;
      invocationId: string;
      tool: string;
      phase: 'start' | 'end';
      at: number;
      /** 工具调用参数（对话流内已限长）。 */
      input: unknown;
      /** 工具执行结果/打印输出（对话流内已限长）。 */
      output: unknown;
    }
  | {
      /** 模型在带工具调用的轮次里输出的过程旁白，不属于最终答复。 */
      kind: 'narration';
      id: string;
      text: string;
      at: number;
    };

type AgentActivityState = {
  entries: AgentActivityEntry[];
  startedAt: number | null;
  lastEventAt: number | null;
};

type AgentStatus = {
  entries: AgentActivityEntry[];
  runningTool: string | null;
  elapsedSeconds: number;
  idleSeconds: number;
  tokens: number;
};

type QuestionAnswer = {
  selections: Array<{ index: number; label: string }>;
  customText?: string;
};

type SessionSummary = {
  id: string;
  title: string;
  externalKey: string | null;
  createdAt: string;
  updatedAt: string;
};

type WebSessionSummary = SessionSummary & { externalKey: string };

type SessionPage = {
  data: WebSessionSummary[];
  nextCursor: string | null;
};

type HistoryAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: 'image' | 'text' | 'file';
  /** 鉴权重定向地址，由后端换发新鲜预签名 URL。 */
  url: string;
};

type HistoryMessage = {
  id: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  citations?: Citation[];
  /** 用户随消息发送的附件；续跑 run 的合成消息不带附件。 */
  attachments?: HistoryAttachment[];
  /** 模型思考过程（reasoning_content），持久化保留。 */
  reasoning?: string;
};

type Citation = {
  chunkId: string;
  documentId: string;
  documentName: string;
  ordinal: number;
  heading?: string;
  score: number;
  via: 'vector' | 'graph' | 'both';
};

type SessionHistory = {
  session: SessionSummary;
  messages: HistoryMessage[];
  latestRun: RunSummary | null;
};

type RunSummary = {
  id: string;
  status: RunStatus;
  errorCode: string | null;
  errorMessage: string | null;
};

type TaskFailure = {
  code: string;
  message: string;
};

type ConversationSeed = {
  chatId: string;
  messages: ResilientMessage[];
  resumeRun: PersistedRun | null;
};

type SessionDialog =
  | { kind: 'rename'; session: WebSessionSummary }
  | { kind: 'delete'; session: WebSessionSummary };

export type {
  AgentActivityEntry,
  AgentActivityState,
  AgentStatus,
  AgentTodo,
  ConversationSeed,
  HistoryAttachment,
  HistoryMessage,
  Citation,
  InsightCard,
  MessageMetadata,
  PendingInterrupt,
  PipelineEvent,
  QuestionAnswer,
  ResilientData,
  ResilientMessage,
  RunSummary,
  SessionDialog,
  SessionHistory,
  SessionPage,
  SessionSummary,
  TaskFailure,
  WebSessionSummary,
};
