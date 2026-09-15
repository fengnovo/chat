import {
  createCoreMetrics,
  createObservabilityLogger,
  loadObservabilityConfig,
  type CoreMetrics,
  type ObservabilityLogger,
  type ObservabilityRuntime,
} from '@repo/observability';

export type WorkerObservability = {
  config: ReturnType<typeof loadObservabilityConfig>;
  runtime: ObservabilityRuntime;
  metrics: CoreMetrics;
  logger: ObservabilityLogger;
};

/**
 * Worker 观测面：与 API 共用同一套 OTel SDK，但由 Worker 进程单独建立
 * 指标集合与结构化日志。任何构造失败都退化为 no-op，不阻断任务消费。
 */
export function createWorkerObservability(
  runtime: ObservabilityRuntime,
  options: { serviceVersion: string },
): WorkerObservability {
  const config = loadObservabilityConfig(process.env, {
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'agent-worker',
    serviceVersion: options.serviceVersion,
  });
  const metrics = createCoreMetrics(runtime.meter);
  const logger = createObservabilityLogger(runtime, {
    service: config.serviceName,
    environment: config.environment,
    level: config.logLevel,
  });
  return { config, runtime, metrics, logger };
}
