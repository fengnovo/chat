import type { Attributes, Meter } from '@opentelemetry/api';
import { normalizeRoute, type NormalizedRoute } from './redaction.js';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'OTHER';
export type HttpStatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';
export type MetricOutcome = 'success' | 'failure' | 'cancelled' | 'timeout' | 'other';
export type SseOperation = 'chat' | 'events' | 'other';
export type SseDisconnectReason = 'client' | 'server' | 'error' | 'timeout' | 'other';
export type QueueName = 'agent-runs' | 'knowledge-index' | 'knowledge-caption' | 'outbox' | 'other';
export type JobKind = 'run' | 'resume' | 'index' | 'reconcile' | 'caption' | 'other';
export type QueueJobOutcome = 'started' | 'completed' | 'failed' | 'skipped';
export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'bailian' | 'other';
export type ModelFamily = 'gpt' | 'claude' | 'gemini' | 'qwen' | 'other';
export type ModelOperation = 'chat' | 'embedding' | 'rerank' | 'other';
export type ToolName = 'sandbox' | 'knowledge' | 'web' | 'other';
export type ToolOperation = 'execute' | 'search' | 'retrieve' | 'other';
export type KnowledgeOperation = 'search' | 'retrieve' | 'index' | 'reconcile' | 'consume' | 'caption' | 'other';
export type TelemetrySignal = 'traces' | 'metrics' | 'logs';
export type OutboxDispatchOutcome = 'published' | 'failed';
export type CircuitState = 'open' | 'half_open' | 'closed' | 'rejected';
export type AgentPhase =
  | 'session.lock.acquire'
  | 'sandbox.acquire'
  | 'workspace.prepare'
  | 'agent.resources.upload'
  | 'agent.runtime.create'
  | 'agent.execute'
  | 'persist'
  | 'cleanup'
  | 'other';
export type PhaseOutcome = 'success' | 'failure';

type HttpServerMeasurement = { method: HttpMethod; route: NormalizedRoute; status: HttpStatusClass; outcome: MetricOutcome; durationMs: number };
type SseConnectionMeasurement = { operation: SseOperation; outcome: MetricOutcome; delta: 1 | -1 };
type SseDisconnectMeasurement = { operation: SseOperation; reason: SseDisconnectReason };
type QueueJobMeasurement = { queue: QueueName; job: JobKind; outcome: QueueJobOutcome; durationMs?: number };
type QueueWaitMeasurement = { queue: QueueName; job: JobKind; waitMs: number };
type ModelCallMeasurement = {
  provider: ModelProvider; model: ModelFamily; operation: ModelOperation; outcome: MetricOutcome;
  durationMs: number; inputTokens?: number; outputTokens?: number; retries?: number; fallbacks?: number;
};
type ToolCallMeasurement = { tool: ToolName; operation: ToolOperation; outcome: MetricOutcome; durationMs?: number };
type KnowledgeRetrievalMeasurement = { operation: KnowledgeOperation; outcome: MetricOutcome; durationMs: number };
type ModelTokensMeasurement = {
  provider: ModelProvider; model: ModelFamily; inputTokens?: number; outputTokens?: number;
};
type CircuitMeasurement = { provider: ModelProvider; model: ModelFamily; state: CircuitState };
type AgentPhaseMeasurement = { phase: AgentPhase; outcome: PhaseOutcome; durationMs: number };

export type CoreMetrics = {
  memoryOperation?(measurement: { operation: 'retrieve' | 'extract' | 'upsert'; outcome: MetricOutcome; durationMs: number }): void;
  httpServer(measurement: HttpServerMeasurement): void;
  sseConnection(measurement: SseConnectionMeasurement): void;
  sseDisconnect(measurement: SseDisconnectMeasurement): void;
  queueJob(measurement: QueueJobMeasurement): void;
  queueWait(measurement: QueueWaitMeasurement): void;
  outboxDispatch(measurement: { outcome: OutboxDispatchOutcome }): void;
  modelCall(measurement: ModelCallMeasurement): void;
  modelTokens(measurement: ModelTokensMeasurement): void;
  modelCircuit(measurement: CircuitMeasurement): void;
  agentPhase(measurement: AgentPhaseMeasurement): void;
  knowledgeOperation(measurement: KnowledgeRetrievalMeasurement): void;
  toolCall(measurement: ToolCallMeasurement): void;
  knowledgeRetrieval(measurement: KnowledgeRetrievalMeasurement): void;
  telemetryExportFailure(labels: { signal: TelemetrySignal }): void;
};

function enumerated<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function secondsFromMilliseconds(value: unknown): number {
  return nonNegative(value) / 1000;
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeAdd(instrument: { add(value: number, attributes?: Attributes): void }, value: number, attributes?: Attributes): void {
  try { instrument.add(value, attributes); } catch {}
}

function safeRecord(instrument: { record(value: number, attributes?: Attributes): void }, value: number, attributes?: Attributes): void {
  try { instrument.record(value, attributes); } catch {}
}

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'];
const STATUS_CLASSES: readonly HttpStatusClass[] = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'];
const OUTCOMES: readonly MetricOutcome[] = ['success', 'failure', 'cancelled', 'timeout', 'other'];
const SSE_OPERATIONS: readonly SseOperation[] = ['chat', 'events', 'other'];
const SSE_REASONS: readonly SseDisconnectReason[] = ['client', 'server', 'error', 'timeout', 'other'];
const QUEUES: readonly QueueName[] = ['agent-runs', 'knowledge-index', 'knowledge-caption', 'outbox', 'other'];
const JOBS: readonly JobKind[] = ['run', 'resume', 'index', 'reconcile', 'caption', 'other'];
const PROVIDERS: readonly ModelProvider[] = ['openai', 'anthropic', 'google', 'bailian', 'other'];
const MODELS: readonly ModelFamily[] = ['gpt', 'claude', 'gemini', 'qwen', 'other'];
const MODEL_OPERATIONS: readonly ModelOperation[] = ['chat', 'embedding', 'rerank', 'other'];
const TOOLS: readonly ToolName[] = ['sandbox', 'knowledge', 'web', 'other'];
const TOOL_OPERATIONS: readonly ToolOperation[] = ['execute', 'search', 'retrieve', 'other'];
const KNOWLEDGE_OPERATIONS: readonly KnowledgeOperation[] = ['search', 'retrieve', 'index', 'reconcile', 'consume', 'caption', 'other'];
const SIGNALS: readonly TelemetrySignal[] = ['traces', 'metrics', 'logs'];
const DISPATCH_OUTCOMES: readonly OutboxDispatchOutcome[] = ['published', 'failed'];
const CIRCUIT_STATES: readonly CircuitState[] = ['open', 'half_open', 'closed', 'rejected'];
const AGENT_PHASES: readonly AgentPhase[] = [
  'session.lock.acquire',
  'sandbox.acquire',
  'workspace.prepare',
  'agent.resources.upload',
  'agent.runtime.create',
  'agent.execute',
  'persist',
  'cleanup',
  'other',
];
const PHASE_OUTCOMES: readonly PhaseOutcome[] = ['success', 'failure'];

export function createCoreMetrics(meter: Meter): CoreMetrics {
  const httpDuration = meter.createHistogram('http.server.duration', { unit: 's' });
  const httpRequests = meter.createCounter('http.server.requests', { unit: '{request}' });
  const sseActive = meter.createUpDownCounter('sse.connection.active', { unit: '{connection}' });
  const sseDisconnects = meter.createCounter('sse.disconnects.total', { unit: '{disconnect}' });
  const queueStarted = meter.createCounter('queue.jobs.started', { unit: '{job}' });
  const queueCompleted = meter.createCounter('queue.jobs.completed', { unit: '{job}' });
  const queueFailed = meter.createCounter('queue.jobs.failed', { unit: '{job}' });
  const queueDuration = meter.createHistogram('queue.job.duration', { unit: 's' });
  const queueWaitDuration = meter.createHistogram('queue.wait.duration', { unit: 's' });
  const outboxDispatches = meter.createCounter('outbox.dispatch.total', { unit: '{dispatch}' });
  const modelCalls = meter.createCounter('model.calls.total', { unit: '{call}' });
  const modelDuration = meter.createHistogram('model.call.duration', { unit: 's' });
  const modelInputTokens = meter.createCounter('model.tokens.input', { unit: '{token}' });
  const modelOutputTokens = meter.createCounter('model.tokens.output', { unit: '{token}' });
  const modelRetries = meter.createCounter('model.retries.total', { unit: '{retry}' });
  const modelFallbacks = meter.createCounter('model.fallbacks.total', { unit: '{fallback}' });
  const modelCircuitEvents = meter.createCounter('model.circuit.total', { unit: '{event}' });
  const agentPhaseDuration = meter.createHistogram('agent.phase.duration', { unit: 's' });
  const toolCalls = meter.createCounter('tool.calls.total', { unit: '{call}' });
  const toolDuration = meter.createHistogram('tool.call.duration', { unit: 's' });
  const retrievalDuration = meter.createHistogram('knowledge.retrieval.duration', { unit: 's' });
  const knowledgeOperationDuration = meter.createHistogram('knowledge.operation.duration', {
    unit: 's',
  });
  const exportFailures = meter.createCounter('telemetry.export.failures', { unit: '{failure}' });
  const memoryDuration = meter.createHistogram('memory.operation.duration', { unit: 's' });

  return {
    memoryOperation(measurement) {
      safeRecord(memoryDuration, secondsFromMilliseconds(measurement.durationMs), {
        operation: measurement.operation,
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    httpServer(measurement) {
      const labels: Attributes = {
        'http.request.method': enumerated(measurement.method, HTTP_METHODS, 'OTHER'),
        'http.route': normalizeRoute(String(measurement.route)),
        'http.response.status_class': enumerated(measurement.status, STATUS_CLASSES, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      };
      safeRecord(httpDuration, secondsFromMilliseconds(measurement.durationMs), labels);
      safeAdd(httpRequests, 1, labels);
    },
    sseConnection(measurement) {
      safeAdd(sseActive, measurement.delta === -1 ? -1 : 1, {
        operation: enumerated(measurement.operation, SSE_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    sseDisconnect(measurement) {
      safeAdd(sseDisconnects, 1, {
        operation: enumerated(measurement.operation, SSE_OPERATIONS, 'other'),
        reason: enumerated(measurement.reason, SSE_REASONS, 'other'),
      });
    },
    queueJob(measurement) {
      const labels: Attributes = {
        queue: enumerated(measurement.queue, QUEUES, 'other'),
        'job.kind': enumerated(measurement.job, JOBS, 'other'),
      };
      if (measurement.outcome === 'started') safeAdd(queueStarted, 1, labels);
      if (measurement.outcome === 'completed') safeAdd(queueCompleted, 1, labels);
      if (measurement.outcome === 'failed') safeAdd(queueFailed, 1, labels);
      if (measurement.outcome !== 'started') safeRecord(queueDuration, secondsFromMilliseconds(measurement.durationMs), {
        ...labels, outcome: measurement.outcome === 'completed' ? 'success' : 'failure',
      });
    },
    queueWait(measurement) {
      safeRecord(queueWaitDuration, secondsFromMilliseconds(measurement.waitMs), {
        queue: enumerated(measurement.queue, QUEUES, 'other'),
        'job.kind': enumerated(measurement.job, JOBS, 'other'),
      });
    },
    outboxDispatch(measurement) {
      safeAdd(outboxDispatches, 1, {
        outcome: enumerated(measurement.outcome, DISPATCH_OUTCOMES, 'failed'),
      });
    },
    modelCall(measurement) {
      const labels: Attributes = {
        provider: enumerated(measurement.provider, PROVIDERS, 'other'),
        model: enumerated(measurement.model, MODELS, 'other'),
        operation: enumerated(measurement.operation, MODEL_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      };
      safeAdd(modelCalls, 1, labels);
      safeRecord(modelDuration, secondsFromMilliseconds(measurement.durationMs), labels);
      const inputTokens = positiveInteger(measurement.inputTokens);
      const outputTokens = positiveInteger(measurement.outputTokens);
      const retries = positiveInteger(measurement.retries);
      const fallbacks = positiveInteger(measurement.fallbacks);
      if (inputTokens) safeAdd(modelInputTokens, inputTokens, labels);
      if (outputTokens) safeAdd(modelOutputTokens, outputTokens, labels);
      if (retries) safeAdd(modelRetries, retries, labels);
      if (fallbacks) safeAdd(modelFallbacks, fallbacks, labels);
    },
    modelTokens(measurement) {
      const labels: Attributes = {
        provider: enumerated(measurement.provider, PROVIDERS, 'other'),
        model: enumerated(measurement.model, MODELS, 'other'),
        operation: 'chat',
      };
      const inputTokens = positiveInteger(measurement.inputTokens);
      const outputTokens = positiveInteger(measurement.outputTokens);
      if (inputTokens) safeAdd(modelInputTokens, inputTokens, labels);
      if (outputTokens) safeAdd(modelOutputTokens, outputTokens, labels);
    },
    modelCircuit(measurement) {
      safeAdd(modelCircuitEvents, 1, {
        provider: enumerated(measurement.provider, PROVIDERS, 'other'),
        model: enumerated(measurement.model, MODELS, 'other'),
        state: enumerated(measurement.state, CIRCUIT_STATES, 'open'),
      });
    },
    agentPhase(measurement) {
      safeRecord(agentPhaseDuration, secondsFromMilliseconds(measurement.durationMs), {
        phase: enumerated(measurement.phase, AGENT_PHASES, 'other'),
        outcome: enumerated(measurement.outcome, PHASE_OUTCOMES, 'failure'),
      });
    },
    toolCall(measurement) {
      const labels: Attributes = {
        tool: enumerated(measurement.tool, TOOLS, 'other'),
        operation: enumerated(measurement.operation, TOOL_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      };
      safeAdd(toolCalls, 1, labels);
      if (measurement.durationMs !== undefined) {
        safeRecord(toolDuration, secondsFromMilliseconds(measurement.durationMs), labels);
      }
    },
    knowledgeRetrieval(measurement) {
      safeRecord(retrievalDuration, secondsFromMilliseconds(measurement.durationMs), {
        operation: enumerated(measurement.operation, KNOWLEDGE_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    knowledgeOperation(measurement) {
      safeRecord(knowledgeOperationDuration, secondsFromMilliseconds(measurement.durationMs), {
        operation: enumerated(measurement.operation, KNOWLEDGE_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    telemetryExportFailure(labels) {
      safeAdd(exportFailures, 1, { signal: enumerated(labels.signal, SIGNALS, 'metrics') });
    },
  };
}
