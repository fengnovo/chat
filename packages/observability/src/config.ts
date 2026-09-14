export type ObservabilityConfig = {
  enabled: boolean;
  serviceName: string;
  environment: string;
  serviceVersion: string;
  otlpEndpoint?: string;
  tracesSampleRatio: number;
  metricExportIntervalMs: number;
  captureContent: boolean;
  logLevel: string;
  shutdownTimeoutMs: number;
};

export function loadObservabilityConfig(
  env: NodeJS.ProcessEnv,
  defaults: { serviceName: string; serviceVersion: string },
): ObservabilityConfig {
  const value = (key: string) => env[key]?.trim() || undefined;
  const invalid = (key: string): never => { throw new Error(`Invalid observability configuration: ${key}`); };
  const boolean = (key: string, fallback: boolean) => {
    const input = value(key)?.toLowerCase();
    if (input === undefined) return fallback;
    if (input === 'true' || input === '1') return true;
    if (input === 'false' || input === '0') return false;
    return invalid(key);
  };
  const number = (key: string, fallback: number, min: number, max: number, integer = false) => {
    const input = value(key);
    if (input === undefined) return fallback;
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) return invalid(key);
    return parsed;
  };
  const rawEndpoint = value('OTEL_EXPORTER_OTLP_ENDPOINT');
  let otlpEndpoint: string | undefined;
  if (rawEndpoint !== undefined) {
    try {
      const url = new URL(rawEndpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('OTEL_EXPORTER_OTLP_ENDPOINT');
      otlpEndpoint = url.toString().replace(/\/+$/, '');
    } catch { invalid('OTEL_EXPORTER_OTLP_ENDPOINT'); }
  }
  return {
    enabled: boolean('OTEL_ENABLED', false),
    serviceName: value('OTEL_SERVICE_NAME') ?? defaults.serviceName,
    serviceVersion: value('OTEL_SERVICE_VERSION') ?? defaults.serviceVersion,
    environment: value('OTEL_ENVIRONMENT') ?? value('NODE_ENV') ?? 'development',
    ...(otlpEndpoint === undefined ? {} : { otlpEndpoint }),
    tracesSampleRatio: number('OTEL_TRACES_SAMPLER_ARG', 0.1, 0, 1),
    metricExportIntervalMs: number('OTEL_METRIC_EXPORT_INTERVAL', 60000, 1, 2147483647, true),
    captureContent: boolean('OBSERVABILITY_CAPTURE_CONTENT', false),
    logLevel: value('OBSERVABILITY_LOG_LEVEL') ?? 'info',
    shutdownTimeoutMs: number('OBSERVABILITY_SHUTDOWN_TIMEOUT_MS', 5000, 1, 2147483647, true),
  };
}
