import type { BaseMessage } from '@langchain/core/messages';
import { mapStoredMessageToChatMessage } from '@langchain/core/messages';
import { initChatModel } from 'langchain/chat_models/universal';
import { createMiddleware } from 'langchain';

import { InMemoryCircuitBreakerStore } from './circuit-breaker.js';
import type { AgentTelemetry, CircuitBreakerStore, ModelRouterEvent, ModelSpec } from './types.js';

/**
 * MCP 工具（如沙箱 read_file 读取 PNG）可能返回图片内容块。mcp-adapters 在
 * useStandardContentBlocks 下产出 LangChain 标准块
 * `{ type: 'image', source_type: 'base64', data, mime_type }`，旧版/直接透传时
 * 还可能是 MCP 原始形状 `{ type: 'image', data, mimeType }`。OpenAI 兼容接口
 * （DeepSeek 等）只认 `{ type: 'image_url' }`，原样发送会被服务端以
 * `unknown variant 'image'` 返回 400，导致整轮 run 失败。
 * 在模型调用边界统一转成 data URL 形式的 image_url。
 */
function toOpenAIImageBlock(block: unknown): unknown | null {
  if (!block || typeof block !== 'object') return null;
  const record = block as Record<string, unknown>;
  if (record.type !== 'image') return null;
  // 标准块带 source_type；只处理 base64 图片，URL 等其他来源不转换。
  if (record.source_type !== undefined && record.source_type !== 'base64') return null;
  const data = typeof record.data === 'string' ? record.data : null;
  if (!data) return null;
  const mimeType =
    (typeof record.mime_type === 'string' && record.mime_type) ||
    (typeof record.mimeType === 'string' && record.mimeType) ||
    'image/png';
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } };
}

export function normalizeImageBlocksForOpenAI(messages: BaseMessage[] | undefined): BaseMessage[] | undefined {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const normalized = messages.map((message) => {
    const { content } = message;
    if (!Array.isArray(content)) return message;
    let messageChanged = false;
    const nextContent = content.map((block) => {
      const replacement = toOpenAIImageBlock(block);
      if (!replacement) return block;
      messageChanged = true;
      return replacement;
    });
    if (!messageChanged) return message;
    changed = true;
    // toDict + mapStoredMessageToChatMessage 保留原消息类型（ToolMessage 等）
    // 及 tool_calls / tool_call_id 等全部字段，避免 instanceof 语义丢失。
    const stored = message.toDict();
    stored.data.content = nextContent as never;
    return mapStoredMessageToChatMessage(stored) as BaseMessage;
  });
  return changed ? normalized : messages;
}

interface RouterOptions {
  models: ModelSpec[];
  circuitBreaker?: CircuitBreakerStore;
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onEvent?: (event: ModelRouterEvent) => void;
  telemetry?: Pick<AgentTelemetry, 'modelCall' | 'event'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecoverableModelError(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = Number(candidate?.status ?? candidate?.statusCode);
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  const code = String(candidate?.code ?? '').toUpperCase();
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) return true;
  const message = errorMessage(error).toLowerCase();
  return /timeout|timed out|connection|rate limit|temporar|unavailable|overloaded/.test(message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

export async function createResilientModelRouter(options: RouterOptions) {
  if (options.models.length === 0) throw new Error('At least one model must be configured.');
  const breaker = options.circuitBreaker ?? new InMemoryCircuitBreakerStore();
  const maxRetries = options.maxRetries ?? 4;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const candidates = await Promise.all(
    options.models.map(async (spec) => ({
      spec,
      instance: await initChatModel(spec.model, {
        modelProvider: spec.provider,
        apiKey: spec.apiKey,
        ...(spec.baseUrl ? { configuration: { baseURL: spec.baseUrl } } : {}),
        temperature: 1,
        maxTokens: spec.maxTokens ?? 16_000,
        timeout: 300_000,
        maxRetries: 0,
        configurableFields: ['temperature', 'maxTokens'],
      }),
    })),
  );
  const primary = candidates[0];
  if (!primary) throw new Error('Primary model initialization failed.');

  const middleware = createMiddleware({
    name: 'ResilientModelRouter',
    wrapModelCall: async (request, handler) => {
      // 归一化在重试/降级之外只做一次（转换幂等），覆盖历史消息里所有图片块。
      const requestMessages = normalizeImageBlocksForOpenAI(request.messages);
      let lastError: unknown;
      let lastSpec: ModelSpec = primary.spec;
      const callStartedAt = Date.now();
      for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
        const candidate = candidates[modelIndex];
        if (!candidate) continue;
        if (!(await breaker.allows(candidate.spec.id))) continue;
        if (modelIndex > 0) {
          options.onEvent?.({
            type: 'model.fallback',
            from: candidates[modelIndex - 1]?.spec.id ?? primary.spec.id,
            to: candidate.spec.id,
            reason: errorMessage(lastError),
          });
          options.telemetry?.event('model.fallback', {
            from: candidates[modelIndex - 1]?.spec.id ?? primary.spec.id,
            to: candidate.spec.id,
          });
        }

        for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
          try {
            const attemptStartedAt = Date.now();
            const response = await handler({ ...request, messages: requestMessages ?? request.messages, model: candidate.instance });
            options.telemetry?.modelCall({
              provider: candidate.spec.provider,
              model: candidate.spec.model,
              outcome: 'success',
              latencyMs: Date.now() - attemptStartedAt,
              ...(attempt > 1 ? { retries: attempt - 1 } : {}),
              ...(modelIndex > 0 ? { fallbacks: modelIndex } : {}),
            });
            await breaker.recordSuccess(candidate.spec.id);
            return response;
          } catch (error) {
            lastError = error;
            lastSpec = candidate.spec;
            if (!isRecoverableModelError(error) || attempt > maxRetries) break;
            const base = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
            const delayMs = Math.max(1, Math.round(base * (0.5 + Math.random() * 0.5)));
            options.onEvent?.({
              type: 'model.retry',
              model: candidate.spec.id,
              attempt,
              delayMs,
              reason: errorMessage(error),
            });
            options.telemetry?.event('model.retry', {
              model: candidate.spec.id,
              attempt,
              delay_ms: delayMs,
            });
            await delay(delayMs, request.runtime.signal);
          }
        }
        await breaker.recordFailure(candidate.spec.id);
      }
      // 全部候选/重试耗尽：按最后一个候选结算一次失败，重试与降级次数随调用带上。
      options.telemetry?.modelCall({
        provider: lastSpec.provider,
        model: lastSpec.model,
        outcome: 'failure',
        latencyMs: Date.now() - callStartedAt,
      });
      throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
    },
  });

  return { primary: primary.instance, middleware };
}
