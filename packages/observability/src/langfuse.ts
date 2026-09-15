import { createHash } from 'node:crypto';

import {
  LangfuseSpanProcessor,
  isDefaultExportSpan,
  type MaskFunction,
} from '@langfuse/otel';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { MAX_LIFECYCLE_TIMEOUT_MS, type ObservabilityConfig } from './config.js';

/**
 * Langfuse 专项导出（方案 3 的"专项"）：
 *
 * - 只把 GenAI/LangChain span 交给 Langfuse；普通 HTTP/PG/Redis/进程 span 只进 Tempo。
 * - 凭据、baseUrl、采样率全部显式 opt-in；生产默认关闭。
 * - 内容（prompt/completion/tool args）默认脱敏，由 OBSERVABILITY_CAPTURE_CONTENT 显式打开。
 * - 任何构造/网络失败都退化为"未启用"，绝不抛出。
 */

export type LangfuseResultConfig = {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  sampleRate: number;
  captureContent: boolean;
  environment: string;
};

export type LangfuseRuntime = {
  readonly enabled: boolean;
  /** 注册到 OTel SDK 上的 GenAI 专用 processor；未启用时不存在。 */
  readonly spanProcessor?: SpanProcessor;
  /**
   * 一次 run 的采样决策。false 表示本次 run 不建 Langfuse callback/trace。
   * 决策本身异常按未命中处理（fail-open 到业务，只是少一份 Langfuse 数据）。
   */
  sampleRun(): boolean;
  flush(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
};

type LangfuseRuntimeInternal = LangfuseRuntime & { readonly config: LangfuseResultConfig };

export function loadLangfuseConfig(
  env: NodeJS.ProcessEnv,
  otel: Pick<ObservabilityConfig, 'environment' | 'captureContent'>,
): LangfuseResultConfig {
  const trimmed = (key: string) => env[key]?.trim() || undefined;
  const parseBoolean = (key: string, fallback: boolean) => {
    const raw = trimmed(key)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return false;
  };
  const sampleRate = (() => {
    const raw = trimmed('LANGFUSE_SAMPLE_RATE');
    if (raw === undefined) return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(1, parsed);
  })();
  const rawBaseUrl = trimmed('LANGFUSE_BASE_URL');
  let baseUrl: string | undefined;
  if (rawBaseUrl !== undefined) {
    try {
      const url = new URL(rawBaseUrl);
      // 凭据不得出现在 URL 里；只允许 scheme/host[:port]/根路径。
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        baseUrl = undefined;
      } else {
        baseUrl = url.toString().replace(/\/+$/, '');
      }
    } catch {
      baseUrl = undefined;
    }
  }
  const publicKey = trimmed('LANGFUSE_PUBLIC_KEY');
  const secretKey = trimmed('LANGFUSE_SECRET_KEY');
  return {
    enabled: parseBoolean('LANGFUSE_ENABLED', false),
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    sampleRate,
    captureContent: otel.captureContent,
    environment: otel.environment,
  };
}

/**
 * 内容字段名（小写结尾匹配）。命中的键值在内容开关关闭时整体替换为占位符，
 * 模型名/provider/token 数量等非内容字段不受影响。
 */
const CONTENT_KEY_PATTERN =
  /(^|[._-])(input|inputs?|output|outputs?|prompt|prompts?|completion|completions?|response|message|messages|query|queries|args?|kwargs|text|passage|content|statusmessage)$/;
const REDACTED = '[redacted]';

function redactValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = CONTENT_KEY_PATTERN.test(childKey.toLowerCase())
        ? REDACTED
        : redactValue(childValue, childKey);
    }
    return output;
  }
  return CONTENT_KEY_PATTERN.test(key.toLowerCase()) ? REDACTED : value;
}

/** 内容开关打开时直接透传；关闭时递归移除 prompt/completion/tool args 等正文。 */
export function createContentMask(captureContent: boolean): MaskFunction {
  return ({ data }) => (captureContent ? data : redactValue(data));
}

/**
 * 用户标识默认不可逆、带部署密钥盐值的伪名，而不是用户名/邮箱/原始 userId。
 * 同一用户在同一部署密钥轮换下保持稳定，便于会话级聚合。
 */
export function pseudonymizeUserId(userId: string, secretKey: string): string {
  const safeUserId = userId.slice(0, 128);
  return `u_${createHash('sha256').update(secretKey).update(':').update(safeUserId).digest('hex').slice(0, 16)}`;
}

/** run_id 只保留短引用（前 8 位），足够去重关联但不可回溯原值。 */
export function shortRunId(runId: string): string {
  return /^[A-Za-z0-9_-]{8,}$/.test(runId) ? runId.slice(0, 8) : 'unknown';
}

export function createLangfuseSpanProcessor(config: LangfuseResultConfig): SpanProcessor | undefined {
  if (!config.enabled) return undefined;
  if (!config.publicKey || !config.secretKey) return undefined;
  try {
    return new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      environment: config.environment,
      timeout: Math.ceil(MAX_LIFECYCLE_TIMEOUT_MS / 1000),
      // 默认过滤器只认 gen_ai / langfuse-sdk scope 的 span；
      // 但 @langfuse/langchain v5 的 CallbackHandler 通过全局 OTel
      // TracerProvider 建 span（scope 非 langfuse-sdk），属性前缀为
      // langfuse.* 而非 gen_ai.*。补充 langfuse.* 属性检测，确保
      // CallbackHandler 产出的 span 也能导出到 Langfuse。
      shouldExportSpan: (span) => {
        const s = span.otelSpan;
        if (isDefaultExportSpan(s)) return true;
        return Object.keys(s.attributes ?? {}).some((key) => key.startsWith('langfuse.'));
      },
      mask: createContentMask(config.captureContent),
    });
  } catch {
    return undefined;
  }
}

/**
 * register 预载时调用：只在配置完整且 processor 可构造时启用，
 * 其它情况返回静默 disabled runtime（任何失败都不阻断启动）。
 */
export function registerLangfuseRuntime(
  env: NodeJS.ProcessEnv,
  otelConfig: Pick<ObservabilityConfig, 'environment' | 'captureContent' | 'shutdownTimeoutMs'>,
  options?: { processorFactory?: (config: LangfuseResultConfig) => SpanProcessor | undefined },
): LangfuseRuntimeInternal {
  const config = loadLangfuseConfig(env, otelConfig);
  const buildProcessor = options?.processorFactory ?? createLangfuseSpanProcessor;
  const spanProcessor = buildProcessor(config);
  const enabled = Boolean(config.enabled && config.publicKey && config.secretKey && spanProcessor);
  const deadline = () =>
    Number.isFinite(otelConfig.shutdownTimeoutMs) && otelConfig.shutdownTimeoutMs > 0
      ? Math.min(MAX_LIFECYCLE_TIMEOUT_MS, Math.floor(otelConfig.shutdownTimeoutMs))
      : MAX_LIFECYCLE_TIMEOUT_MS;
  const withDeadline = (action: () => Promise<void>): Promise<void> => {
    if (!spanProcessor) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.resolve()
        .then(action)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          warnOnce(`langfuse lifecycle call exceeded deadline, telemetry dropped`);
          resolve();
        }, deadline());
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
  let warned = false;
  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    try { console.warn(`[@repo/observability] ${message}`); } catch {}
  };
  const runtime: LangfuseRuntimeInternal = {
    config,
    enabled,
    ...(spanProcessor ? { spanProcessor } : {}),
    sampleRun() {
      if (!enabled) return false;
      try {
        return Math.random() < config.sampleRate;
      } catch {
        return false;
      }
    },
    flush: (timeoutMs = deadline()) => withDeadline(() => spanProcessor!.forceFlush()),
    shutdown: (timeoutMs = deadline()) => withDeadline(() => spanProcessor!.shutdown()),
  };
  if (config.enabled && (!config.publicKey || !config.secretKey || !spanProcessor)) {
    warnOnce('Langfuse enabled but unavailable (missing keys or failed initialization); disabling Langfuse export.');
  }
  return runtime;
}

/** register 与后续业务代码共享同一个 runtime，避免重复 processor 双写。 */
let registeredRuntime: LangfuseRuntimeInternal | undefined;

export function registerLangfuse(
  env: NodeJS.ProcessEnv,
  otelConfig: Pick<ObservabilityConfig, 'environment' | 'captureContent' | 'shutdownTimeoutMs'>,
): LangfuseRuntime {
  registeredRuntime ??= registerLangfuseRuntime(env, otelConfig);
  return registeredRuntime;
}

export function getRegisteredLangfuseRuntime(): LangfuseRuntime | undefined {
  return registeredRuntime;
}
