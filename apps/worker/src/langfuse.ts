import { trace } from '@opentelemetry/api';
import { CallbackHandler } from '@langfuse/langchain';

import {
  getRegisteredLangfuseRuntime,
  loadLangfuseConfig,
  pseudonymizeUserId,
  registerLangfuse,
  shortRunId,
  type LangfuseRuntime,
} from '@repo/observability';

/**
 * Worker 专用 Langfuse 适配（Task 8）：
 *
 * - 只有 Worker 会创建 GenAI callback；API / Knowledge Service 永远不建。
 * - 采样按 run 粒度决策，命中才 new CallbackHandler（一次 run 最多一个）。
 * - traceMetadata 是固定 allow-list，绝不包含 prompt/completion/tool args/userId 原值；
 *   正文由 LangfuseSpanProcessor 的 mask 在导出口二次拦截。
 * - 所有调用 fail-open：handler 构造失败 = 本次 run 不写 Langfuse，业务不受影响。
 */

export type LangfuseRunMeta = {
  runId: string;
  sessionId: string;
  userId: string;
  /** RunJob.kind，仅用于打固定枚举标签，不直接透传原始值。 */
  runKind: 'start' | 'resume-approval' | 'resume-question';
  provider?: string;
  model?: string;
  modelFamily?: string;
};

export interface WorkerLangfuse {
  readonly enabled: boolean;
  /** 采样命中时返回恰好一个 LangChain callback；未命中或任何异常返回空数组。 */
  runCallbacks(meta: LangfuseRunMeta): readonly unknown[];
  flush(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export type WorkerLangfuseOptions = {
  /** OTel 关闭超时；Langfuse flush 共用同一 5s 上限。 */
  shutdownTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：替换真实 CallbackHandler，参数即最终传给 handler 的构造参数。 */
  callbackFactory?: (params: {
    userId: string;
    sessionId: string;
    tags: string[];
    traceMetadata: Record<string, string>;
  }) => unknown;
  runtime?: LangfuseRuntime;
};

const RUN_KIND_TAGS: Record<LangfuseRunMeta['runKind'], string> = {
  start: 'run:start',
  'resume-approval': 'run:resume-approval',
  'resume-question': 'run:resume-question',
};

/** 标签/metadata 只允许稳定短值，超长或含异常字符直接丢弃，避免用户内容借字段混入。 */
function boundedLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,40}$/.test(trimmed) ? trimmed : undefined;
}

export function createWorkerLangfuse(options: WorkerLangfuseOptions): WorkerLangfuse {
  const env = options.env ?? process.env;
  const otelConfig = {
    environment: env.OTEL_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'development',
    captureContent: env.OBSERVABILITY_CAPTURE_CONTENT?.trim().toLowerCase() === 'true',
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  };
  const runtime =
    options.runtime ??
    getRegisteredLangfuseRuntime() ??
    registerLangfuse(env, otelConfig);
  const lfConfig = loadLangfuseConfig(env, otelConfig);

  if (!runtime.enabled) {
    return {
      enabled: false,
      runCallbacks: () => [],
      flush: async () => {},
      shutdown: async () => {},
    };
  }

  const factory = options.callbackFactory ??
    ((params) =>
      new CallbackHandler({
        userId: params.userId,
        sessionId: params.sessionId,
        tags: params.tags,
        traceMetadata: params.traceMetadata,
      }));

  return {
    enabled: true,
    runCallbacks(meta) {
      try {
        if (!runtime.sampleRun()) return [];
        if (!lfConfig.secretKey) return [];
        const activeSpan = trace.getActiveSpan();
        const spanContext = activeSpan?.spanContext();
        const tags = Array.from(
          new Set(
            [
              boundedLabel(lfConfig.environment),
              RUN_KIND_TAGS[meta.runKind],
              boundedLabel(meta.modelFamily),
            ].filter((value): value is string => Boolean(value)),
          ),
        );
        // 固定 allow-list；run_id 仅短引用，userId 为带部署盐的不可逆伪名。
        const traceMetadata: Record<string, string> = {
          run_id: shortRunId(meta.runId),
          run_kind: meta.runKind,
          environment: boundedLabel(lfConfig.environment) ?? 'development',
          ...(spanContext && spanContext.traceId
            ? { tempo_trace_id: spanContext.traceId }
            : {}),
          ...(boundedLabel(meta.provider) ? { provider: boundedLabel(meta.provider)! } : {}),
          ...(boundedLabel(meta.model) ? { model: boundedLabel(meta.model)! } : {}),
          ...(boundedLabel(meta.modelFamily)
            ? { model_family: boundedLabel(meta.modelFamily)! }
            : {}),
        };
        const callback = factory({
          userId: pseudonymizeUserId(meta.userId, lfConfig.secretKey),
          sessionId: meta.sessionId,
          tags,
          traceMetadata,
        });
        return callback ? [callback] : [];
      } catch {
        return [];
      }
    },
    flush(timeoutMs = options.shutdownTimeoutMs) {
      return runtime.flush(timeoutMs);
    },
    shutdown(timeoutMs = options.shutdownTimeoutMs) {
      return runtime.shutdown(timeoutMs);
    },
  };
}
