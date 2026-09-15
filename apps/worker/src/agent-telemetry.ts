import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import type {
  AgentTelemetry,
  AgentTelemetryOutcome,
  CircuitTelemetryState,
} from '@repo/agent-core';
import type {
  AgentPhase,
  ModelFamily,
  ModelProvider,
  PhaseOutcome,
  ToolName,
  ToolOperation,
} from '@repo/observability';

import type { WorkerObservability } from './observability.js';

/** 遥测调用永不影响 agent 执行。 */
function safely(action: () => void): void {
  try {
    action();
  } catch {}
}

/** 模型名归一到有限 family；未知型号归 other，避免 metric label 基数失控。 */
export function modelFamilyOf(model: string): ModelFamily {
  if (/gpt|^o[0-9]|openai/i.test(model)) return 'gpt';
  if (/claude/i.test(model)) return 'claude';
  if (/gemini/i.test(model)) return 'gemini';
  if (/qwen/i.test(model)) return 'qwen';
  return 'other';
}

function providerOf(provider: string): ModelProvider {
  return provider as ModelProvider;
}

/** ModelSpec.id 形如 `provider:model`；熔断事件只带 model id，需要拆开。 */
export function parseModelId(id: string): { provider: ModelProvider; model: ModelFamily } {
  const separator = id.indexOf(':');
  if (separator <= 0) {
    return { provider: 'other', model: modelFamilyOf(id) };
  }
  return {
    provider: providerOf(id.slice(0, separator)),
    model: modelFamilyOf(id.slice(separator + 1)),
  };
}

const SANDBOX_TOOLS = new Set([
  'execute',
  'write_file',
  'edit_file',
  'read_file',
  'delete',
  'ls',
  'glob',
  'grep',
  'write_todos',
]);

/** 工具名归一到有限枚举；任意自定义/MCP 工具一律归 other。 */
export function classifyTool(name: string): { tool: ToolName; operation: ToolOperation } {
  if (name === 'graphrag_search') return { tool: 'knowledge', operation: 'search' };
  if (name === 'web_search') return { tool: 'web', operation: 'search' };
  if (name === 'web_fetch') return { tool: 'web', operation: 'retrieve' };
  if (SANDBOX_TOOLS.has(name)) return { tool: 'sandbox', operation: 'execute' };
  return { tool: 'other', operation: 'other' };
}

const PHASES = new Set<AgentPhase>([
  'session.lock.acquire',
  'sandbox.acquire',
  'workspace.prepare',
  'agent.resources.upload',
  'agent.runtime.create',
  'agent.execute',
  'persist',
  'cleanup',
]);

function phaseOf(operation: string): AgentPhase {
  return PHASES.has(operation as AgentPhase) ? (operation as AgentPhase) : 'other';
}

/**
 * 把 agent-core 的 AgentTelemetry 端口映射到 OTel span/事件与 CoreMetrics。
 * run_id/user_id 只进 span attribute；metric label 全部走有限枚举归一。
 */
export function createAgentTelemetry(obs: WorkerObservability): AgentTelemetry {
  const tracer = obs.runtime.tracer;
  const metrics = obs.metrics;

  function addSpanEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    safely(() => {
      trace.getActiveSpan()?.addEvent(name, attributes);
    });
  }

  return {
    async runSpan(meta, action) {
      const startedAt = Date.now();
      const parent = context.active();
      const phase = phaseOf(meta.operation);
      const span = tracer.startSpan(
        meta.operation,
        { attributes: { run_id: meta.runId, phase } },
        parent,
      );
      let outcome: PhaseOutcome = 'success';
      try {
        return await context.with(trace.setSpan(parent, span), action);
      } catch (error) {
        outcome = 'failure';
        safely(() => {
          span.setStatus({ code: SpanStatusCode.ERROR });
          if (error instanceof Error) span.recordException(error);
        });
        throw error;
      } finally {
        safely(() => {
          metrics.agentPhase({
            phase,
            outcome,
            durationMs: Date.now() - startedAt,
          });
          span.end();
        });
      }
    },

    modelCall(meta) {
      safely(() => {
        const family = modelFamilyOf(meta.model);
        const outcome: AgentTelemetryOutcome = meta.outcome;
        metrics.modelCall({
          provider: providerOf(meta.provider),
          model: family,
          operation: 'chat',
          outcome,
          durationMs: Math.max(0, meta.latencyMs),
          ...(meta.retries !== undefined ? { retries: meta.retries } : {}),
          ...(meta.fallbacks !== undefined ? { fallbacks: meta.fallbacks } : {}),
        });
        addSpanEvent('model.call', {
          provider: meta.provider,
          model: family,
          outcome,
          ...(meta.retries !== undefined ? { retries: meta.retries } : {}),
          ...(meta.fallbacks !== undefined ? { fallbacks: meta.fallbacks } : {}),
        });
      });
    },

    modelTokens(meta) {
      safely(() => {
        metrics.modelTokens({
          provider: providerOf(meta.provider),
          model: modelFamilyOf(meta.model),
          ...(meta.inputTokens !== undefined ? { inputTokens: meta.inputTokens } : {}),
          ...(meta.outputTokens !== undefined ? { outputTokens: meta.outputTokens } : {}),
        });
      });
    },

    toolCall(meta) {
      safely(() => {
        const { tool, operation } = classifyTool(meta.tool);
        const outcome: AgentTelemetryOutcome = meta.outcome;
        metrics.toolCall({
          tool,
          operation,
          outcome,
          ...(meta.latencyMs !== undefined ? { durationMs: Math.max(0, meta.latencyMs) } : {}),
        });
        addSpanEvent('tool.call', { tool: meta.tool, outcome });
      });
    },

    circuit(meta) {
      safely(() => {
        const { provider, model } = parseModelId(meta.model);
        const state: CircuitTelemetryState = meta.state;
        metrics.modelCircuit({ provider, model, state });
        addSpanEvent('model.circuit', { model: meta.model, state });
      });
    },

    phase(meta) {
      safely(() => {
        const outcome: AgentTelemetryOutcome = meta.outcome;
        metrics.agentPhase({
          phase: phaseOf(meta.operation),
          outcome,
          durationMs: Math.max(0, meta.durationMs),
        });
      });
    },

    event(name, attributes) {
      safely(() => {
        addSpanEvent(name, attributes);
        if (name === 'run.terminal' && attributes?.outcome === 'failed') {
          trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
        }
      });
    },
  };
}
