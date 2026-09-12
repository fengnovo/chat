import type { AgentEvent } from '@repo/contracts';

export interface ModelSpec {
  id: string;
  model: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
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

export interface HeadlessAgentOptions {
  runId: string;
  sessionId: string;
  workspacePath: string;
  checkpointer: unknown;
  models: ModelSpec[];
  circuitBreaker?: CircuitBreakerStore;
  mcpConfigPath?: string;
  skills?: string[];
  memory?: string[];
  inheritEnv?: boolean;
  autoApproveTools?: boolean;
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
  readonly backendMode: 'local' | 'sandbox';
  readonly mcpStatus: string;
  run(message: string): AsyncIterable<AgentEvent>;
  resume(input: AgentResumeInput): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}

export interface AgentDriver {
  create(options: HeadlessAgentOptions): Promise<HeadlessAgentRuntime>;
}
