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
  skills?: string[];
  memory?: string[];
  autoApproveTools?: boolean;
  /** 单次运行允许的 LangGraph super-step 上限；多步长任务需要足够余量。 */
  recursionLimit?: number;
  /** 单次运行允许的模型调用次数上限。 */
  modelCallLimit?: number;
  signal?: AbortSignal;
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

export interface HeadlessAgentRuntime {
  readonly backendMode: AgentBackendMode;
  readonly workspacePath: string;
  readonly mcpStatus: string;
  run(message: string): AsyncIterable<AgentEvent>;
  resume(input: AgentResumeInput): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}
