import { initChatModel } from 'langchain/chat_models/universal';
import { createMiddleware } from 'langchain';

import { InMemoryCircuitBreakerStore } from './circuit-breaker.js';
import type { CircuitBreakerStore, ModelRouterEvent, ModelSpec } from './types.js';

interface RouterOptions {
  models: ModelSpec[];
  circuitBreaker?: CircuitBreakerStore;
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onEvent?: (event: ModelRouterEvent) => void;
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
      let lastError: unknown;
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
        }

        for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
          try {
            const response = await handler({ ...request, model: candidate.instance });
            await breaker.recordSuccess(candidate.spec.id);
            return response;
          } catch (error) {
            lastError = error;
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
            await delay(delayMs, request.runtime.signal);
          }
        }
        await breaker.recordFailure(candidate.spec.id);
      }
      throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
    },
  });

  return { primary: primary.instance, middleware };
}
