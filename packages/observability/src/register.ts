import { loadObservabilityConfig } from './config.js';
import { startObservability, type ObservabilityRuntime } from './sdk.js';

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
  const runtime = startObservability(
    loadObservabilityConfig(environment, preloadDefaults(environment)),
  );
  registry[REGISTRATION_KEY] = runtime;
  return runtime;
}

export function getRegisteredObservability(): Promise<ObservabilityRuntime> | undefined {
  const registered = registry[REGISTRATION_KEY];
  return registered instanceof Promise
    ? registered as Promise<ObservabilityRuntime>
    : undefined;
}

/** Importing this module with Node --import initializes telemetry before app code. */
export const registeredObservability = await registerObservability();
