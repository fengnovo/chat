import { loadObservabilityConfig } from './config.js';
import { startObservability, type ObservabilityRuntime } from './sdk.js';
import { registerLangfuse } from './langfuse.js';

const REGISTRATION_KEY = Symbol.for('@repo/observability/runtime');
const registry = globalThis as typeof globalThis & Record<PropertyKey, unknown>;

function preloadDefaults(environment: NodeJS.ProcessEnv) {
  return {
    serviceName: environment.OTEL_SERVICE_NAME?.trim() || environment.npm_package_name || 'chat-service',
    serviceVersion: environment.OTEL_SERVICE_VERSION?.trim() || environment.npm_package_version || '0.1.0',
  };
}

export function registerObservability(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ObservabilityRuntime> {
  const existing = registry[REGISTRATION_KEY];
  if (existing instanceof Promise) return existing as Promise<ObservabilityRuntime>;
  const config = loadObservabilityConfig(environment, preloadDefaults(environment));
  // Langfuse 专项导出随预载一起装配；仅 gen_ai span 会被导出，其他服务挂载无害。
  const langfuse = registerLangfuse(environment, config);
  const runtime = startObservability(config, {
    ...(langfuse.spanProcessor ? { extraSpanProcessors: [langfuse.spanProcessor] } : {}),
  });
  registry[REGISTRATION_KEY] = runtime;
  return runtime;
}

export function getRegisteredObservability(): Promise<ObservabilityRuntime> | undefined {
  const registered = registry[REGISTRATION_KEY];
  return registered instanceof Promise
    ? registered as Promise<ObservabilityRuntime>
    : undefined;
}

/**
 * 通过 Node --import 导入此模块，可在应用代码之前初始化遥测。
 * 直接导出该 Promise，确保 getRegisteredObservability() 与此绑定是同一个可复用值；
 * 调用方需要等待该 Promise 完成。
 */
export const registeredObservability: Promise<ObservabilityRuntime> = registerObservability();
