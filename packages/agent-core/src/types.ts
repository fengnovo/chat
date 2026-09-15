import type { AgentEvent } from '@repo/contracts';

export interface ModelSpec {
  id: string;
  model: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  /** 单次回复的输出上限。推理模型会把思考过程也计入该额度，太小会导致只输出 reasoning、正文为空。 */
  maxTokens?: number;
}

export interface ModelRouterEvent {
  type: 'model.retry' | 'model.fallback';
  model?: string;
  from?: string;
  to?: string;
  attempt?: number;
  delayMs?: number;
  reason: string;
}

export interface CircuitBreakerStore {
  allows(key: string): Promise<boolean>;
  recordSuccess(key: string): Promise<void>;
  recordFailure(key: string): Promise<void>;
}

/** 熔断器状态有限枚举；任何遥测实现都不得扩展该集合（低基数指标约束）。 */
export type CircuitTelemetryState = 'open' | 'half_open' | 'closed' | 'rejected';

export type AgentTelemetryEvent =
  | 'model.retry'
  | 'model.fallback'
  | 'retrieval.completed'
  | 'run.terminal';

export type AgentTelemetryOutcome = 'success' | 'failure';

/**
 * Agent 运行时的遥测端口（依赖倒置）。
 * agent-core 不依赖 OTel/Langfuse；由 Worker 提供实现。
 * 约定：实现必须 fail-open——任何方法抛错都不得影响 agent 执行。
 * 属性只允许 provider/model 标识、工具名、状态、耗时、token 数等低基数字段；
 * prompt、completion、工具参数/结果、用户输入一律不得进入。
 */
export interface AgentTelemetry {
  /** 为一个阶段建立 span 并执行动作；run_id 只进 span attribute，不进 metric label。 */
  runSpan<T>(
    meta: { runId: string; operation: string },
    action: () => Promise<T>,
  ): Promise<T>;
  modelCall(meta: {
    provider: string;
    model: string;
    outcome: AgentTelemetryOutcome;
    latencyMs: number;
    retries?: number;
    fallbacks?: number;
  }): void;
  /** 流式 usage 事件的 token 结算；只计非负数，避免重复/负值结算。 */
  modelTokens(meta: {
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  }): void;
  toolCall(meta: { tool: string; outcome: AgentTelemetryOutcome; latencyMs?: number }): void;
  circuit(meta: { model: string; state: CircuitTelemetryState }): void;
  phase(meta: { operation: string; outcome: AgentTelemetryOutcome; durationMs: number }): void;
  event(
    name: AgentTelemetryEvent,
    attributes?: Record<string, string | number | boolean>,
  ): void;
}

/** Agent 运行所依赖的沙箱后端类型。 */
export type AgentBackendMode = 'e2b' | 'docker';

export interface HeadlessAgentOptions {
  runId: string;
  sessionId: string;
  workspacePath: string;
  backend: unknown;
  backendMode?: AgentBackendMode;
  checkpointer: unknown;
  models: ModelSpec[];
  circuitBreaker?: CircuitBreakerStore;
  mcpConfigPath?: string;
  knowledgeMcp?: { url: string; token: string; timeoutMs: number; enabled: boolean };
  skills?: string[];
  memory?: string[];
  autoApproveTools?: boolean;
  /** 单次运行允许的 LangGraph super-step 上限；多步长任务需要足够余量。 */
  recursionLimit?: number;
  /** 单次运行允许的模型调用次数上限。 */
  modelCallLimit?: number;
  signal?: AbortSignal;
  /** 遥测端口；缺省时所有观测静默关闭。 */
  telemetry?: AgentTelemetry;
  /**
   * 注入到 LangGraph 执行配置的 callbacks（如 Langfuse CallbackHandler）。
   * 由宿主按 run 粒度构建并决定是否采样；agent-core 只负责透传，不识别内容。
   */
  callbacks?: readonly unknown[];
}

export type AgentResumeInput =
  | {
      kind: 'approval';
      decision: 'approve' | 'reject';
      message?: string;
    }
  | {
      kind: 'question';
      answer: {
        selections: Array<{ index: number; label: string }>;
        customText?: string;
      };
    };

/** 随用户消息一起提交的图片（data URL 内联），用于视觉模型的图文混合输入。 */
export interface ChatImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** 完整 data URL（data:image/...;base64,...）。 */
  dataUrl: string;
  filename?: string;
}

export interface HeadlessAgentRuntime {
  readonly backendMode: AgentBackendMode;
  readonly workspacePath: string;
  readonly mcpStatus: string;
  run(message: string, images?: ChatImageAttachment[]): AsyncIterable<AgentEvent>;
  resume(input: AgentResumeInput): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}
