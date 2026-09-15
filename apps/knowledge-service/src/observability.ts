import {
  createCoreMetrics,
  createObservabilityLogger,
  loadObservabilityConfig,
  type CoreMetrics,
  type ObservabilityLogger,
  type ObservabilityRuntime,
} from '@repo/observability';

export type KnowledgeObservability = {
  config: ReturnType<typeof loadObservabilityConfig>;
  runtime: ObservabilityRuntime;
  metrics: CoreMetrics;
  logger: ObservabilityLogger;
};

/**
 * Knowledge Service 观测面：独立 OTel SDK（或复用 register 预载的单例），
 * 指标集合与结构化日志与 API/Worker 同源。任何构造失败都退化为 no-op。
 */
export function createKnowledgeObservability(
  runtime: ObservabilityRuntime,
  options: { serviceVersion: string },
): KnowledgeObservability {
  const config = loadObservabilityConfig(process.env, {
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'knowledge-service',
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
