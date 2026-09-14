import type { Attributes, Meter } from '@opentelemetry/api';
import { normalizeRoute, type NormalizedRoute } from './redaction.js';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'OTHER';
export type HttpStatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';
export type MetricOutcome = 'success' | 'failure' | 'cancelled' | 'timeout' | 'other';
export type SseOperation = 'chat' | 'events' | 'other';
export type SseDisconnectReason = 'client' | 'server' | 'error' | 'timeout' | 'other';
export type QueueName = 'agent-runs' | 'knowledge-index' | 'outbox' | 'other';
export type JobKind = 'run' | 'resume' | 'index' | 'reconcile' | 'other';
export type QueueJobOutcome = 'started' | 'completed' | 'failed';
export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'bailian' | 'other';
export type ModelFamily = 'gpt' | 'claude' | 'gemini' | 'qwen' | 'other';
export type ModelOperation = 'chat' | 'embedding' | 'rerank' | 'other';
export type ToolName = 'sandbox' | 'knowledge' | 'web' | 'other';
export type ToolOperation = 'execute' | 'search' | 'retrieve' | 'other';
export type KnowledgeOperation = 'search' | 'retrieve' | 'index' | 'reconcile' | 'other';
export type TelemetrySignal = 'traces' | 'metrics' | 'logs';

type HttpServerMeasurement = { method: HttpMethod; route: NormalizedRoute; status: HttpStatusClass; outcome: MetricOutcome; durationMs: number };
type SseConnectionMeasurement = { operation: SseOperation; outcome: MetricOutcome; delta: 1 | -1 };
type SseDisconnectMeasurement = { operation: SseOperation; reason: SseDisconnectReason };
type QueueJobMeasurement = { queue: QueueName; job: JobKind; outcome: QueueJobOutcome; durationMs?: number };
type ModelCallMeasurement = {
  provider: ModelProvider; model: ModelFamily; operation: ModelOperation; outcome: MetricOutcome;
  durationMs: number; inputTokens?: number; outputTokens?: number; retries?: number; fallbacks?: number;
};
type ToolCallMeasurement = { tool: ToolName; operation: ToolOperation; outcome: MetricOutcome };
type KnowledgeRetrievalMeasurement = { operation: KnowledgeOperation; outcome: MetricOutcome; durationMs: number };

export type CoreMetrics = {
  httpServer(measurement: HttpServerMeasurement): void;
  sseConnection(measurement: SseConnectionMeasurement): void;
  sseDisconnect(measurement: SseDisconnectMeasurement): void;
  queueJob(measurement: QueueJobMeasurement): void;
  modelCall(measurement: ModelCallMeasurement): void;
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

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'];
const STATUS_CLASSES: readonly HttpStatusClass[] = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'];
const OUTCOMES: readonly MetricOutcome[] = ['success', 'failure', 'cancelled', 'timeout', 'other'];
const SSE_OPERATIONS: readonly SseOperation[] = ['chat', 'events', 'other'];
const SSE_REASONS: readonly SseDisconnectReason[] = ['client', 'server', 'error', 'timeout', 'other'];
const QUEUES: readonly QueueName[] = ['agent-runs', 'knowledge-index', 'outbox', 'other'];
const JOBS: readonly JobKind[] = ['run', 'resume', 'index', 'reconcile', 'other'];
const PROVIDERS: readonly ModelProvider[] = ['openai', 'anthropic', 'google', 'bailian', 'other'];
const MODELS: readonly ModelFamily[] = ['gpt', 'claude', 'gemini', 'qwen', 'other'];
const MODEL_OPERATIONS: readonly ModelOperation[] = ['chat', 'embedding', 'rerank', 'other'];
const TOOLS: readonly ToolName[] = ['sandbox', 'knowledge', 'web', 'other'];
const TOOL_OPERATIONS: readonly ToolOperation[] = ['execute', 'search', 'retrieve', 'other'];
const KNOWLEDGE_OPERATIONS: readonly KnowledgeOperation[] = ['search', 'retrieve', 'index', 'reconcile', 'other'];
const SIGNALS: readonly TelemetrySignal[] = ['traces', 'metrics', 'logs'];

export function createCoreMetrics(meter: Meter): CoreMetrics {
  const httpDuration = meter.createHistogram('http.server.duration', { unit: 'ms' });
  const httpRequests = meter.createCounter('http.server.requests', { unit: '{request}' });
  const sseActive = meter.createUpDownCounter('sse.connection.active', { unit: '{connection}' });
  const sseDisconnects = meter.createCounter('sse.disconnects.total', { unit: '{disconnect}' });
  const queueStarted = meter.createCounter('queue.jobs.started', { unit: '{job}' });
  const queueCompleted = meter.createCounter('queue.jobs.completed', { unit: '{job}' });
  const queueFailed = meter.createCounter('queue.jobs.failed', { unit: '{job}' });
  const queueDuration = meter.createHistogram('queue.job.duration', { unit: 'ms' });
  const modelCalls = meter.createCounter('model.calls.total', { unit: '{call}' });
  const modelDuration = meter.createHistogram('model.call.duration', { unit: 'ms' });
  const modelInputTokens = meter.createCounter('model.tokens.input', { unit: '{token}' });
  const modelOutputTokens = meter.createCounter('model.tokens.output', { unit: '{token}' });
  const modelRetries = meter.createCounter('model.retries.total', { unit: '{retry}' });
  const modelFallbacks = meter.createCounter('model.fallbacks.total', { unit: '{fallback}' });
  const toolCalls = meter.createCounter('tool.calls.total', { unit: '{call}' });
  const retrievalDuration = meter.createHistogram('knowledge.retrieval.duration', { unit: 'ms' });
  const exportFailures = meter.createCounter('telemetry.export.failures', { unit: '{failure}' });

  return {
    httpServer(measurement) {
      const labels: Attributes = {
        'http.request.method': enumerated(measurement.method, HTTP_METHODS, 'OTHER'),
        'http.route': normalizeRoute(String(measurement.route)),
        'http.response.status_class': enumerated(measurement.status, STATUS_CLASSES, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      };
      httpDuration.record(nonNegative(measurement.durationMs), labels);
      httpRequests.add(1, labels);
    },
    sseConnection(measurement) {
      sseActive.add(measurement.delta === -1 ? -1 : 1, {
        operation: enumerated(measurement.operation, SSE_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    sseDisconnect(measurement) {
      sseDisconnects.add(1, {
        operation: enumerated(measurement.operation, SSE_OPERATIONS, 'other'),
        reason: enumerated(measurement.reason, SSE_REASONS, 'other'),
      });
    },
    queueJob(measurement) {
      const labels: Attributes = {
        queue: enumerated(measurement.queue, QUEUES, 'other'),
        'job.kind': enumerated(measurement.job, JOBS, 'other'),
      };
      if (measurement.outcome === 'started') queueStarted.add(1, labels);
      if (measurement.outcome === 'completed') queueCompleted.add(1, labels);
      if (measurement.outcome === 'failed') queueFailed.add(1, labels);
      if (measurement.outcome !== 'started') queueDuration.record(nonNegative(measurement.durationMs), {
        ...labels, outcome: measurement.outcome === 'completed' ? 'success' : 'failure',
      });
    },
    modelCall(measurement) {
      const labels: Attributes = {
        provider: enumerated(measurement.provider, PROVIDERS, 'other'),
        model: enumerated(measurement.model, MODELS, 'other'),
        operation: enumerated(measurement.operation, MODEL_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      };
      modelCalls.add(1, labels);
      modelDuration.record(nonNegative(measurement.durationMs), labels);
      const inputTokens = positiveInteger(measurement.inputTokens);
      const outputTokens = positiveInteger(measurement.outputTokens);
      const retries = positiveInteger(measurement.retries);
      const fallbacks = positiveInteger(measurement.fallbacks);
      if (inputTokens) modelInputTokens.add(inputTokens, labels);
      if (outputTokens) modelOutputTokens.add(outputTokens, labels);
      if (retries) modelRetries.add(retries, labels);
      if (fallbacks) modelFallbacks.add(fallbacks, labels);
    },
    toolCall(measurement) {
      toolCalls.add(1, {
        tool: enumerated(measurement.tool, TOOLS, 'other'),
        operation: enumerated(measurement.operation, TOOL_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    knowledgeRetrieval(measurement) {
      retrievalDuration.record(nonNegative(measurement.durationMs), {
        operation: enumerated(measurement.operation, KNOWLEDGE_OPERATIONS, 'other'),
        outcome: enumerated(measurement.outcome, OUTCOMES, 'other'),
      });
    },
    telemetryExportFailure(labels) {
      exportFailures.add(1, { signal: enumerated(labels.signal, SIGNALS, 'metrics') });
    },
  };
}
