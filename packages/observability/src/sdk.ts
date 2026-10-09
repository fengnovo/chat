import { context, createNoopMeter, metrics, propagation, ProxyTracerProvider, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { MAX_LIFECYCLE_TIMEOUT_MS, type ObservabilityConfig } from './config.js';
import { createObservabilityResource } from './resource.js';

export type ObservabilityRuntime = {
  tracer: Tracer;
  meter: Meter;
  shutdown(timeoutMs?: number): Promise<void>;
  forceFlush(timeoutMs?: number): Promise<void>;
};

/** 自定义导出器也支持未部署 OTLP 收集器的内嵌式部署。 */
export type ObservabilityOptions = {
  spanExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  /**
   * 额外的 SpanProcessor（例如 Langfuse 专项导出器）。只参与导出，
   * 不改变采样决策；追加失败不得影响 OTLP 主管线。
   */
  extraSpanProcessors?: SpanProcessor[];
};

function noopRuntime(): ObservabilityRuntime {
  return {
    tracer: new ProxyTracerProvider().getTracer('@repo/observability'),
    meter: createNoopMeter(),
    async shutdown() {},
    async forceFlush() {},
  };
}

function timeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value) || 1, 2147483647) : fallback;
}

function lifecycleTimeout(value: number | undefined, fallback = MAX_LIFECYCLE_TIMEOUT_MS): number {
  return Math.min(timeout(value, fallback), MAX_LIFECYCLE_TIMEOUT_MS);
}

/** 吞掉同步抛错、Promise 拒绝和未完成的 Promise，避免暴露错误信息。 */
async function bounded(operation: () => Promise<unknown>, timeoutMs: number, warn: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(warn),
      new Promise<void>(resolve => { timer = setTimeout(() => { warn(); resolve(); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** 确认已丢弃的批次，避免 OTel 记录未处理的导出器异常。 */
function safeExport<T>(run: (items: T, callback: (result: ExportResult) => void) => void, timeoutMs: number, warn: () => void) {
  return (items: T, callback: (result: ExportResult) => void): void => {
    let done = false;
    const finish = (failed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (failed) warn();
      callback({ code: ExportResultCode.SUCCESS });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    try { run(items, result => finish(result.code !== ExportResultCode.SUCCESS)); }
    catch { finish(true); }
  };
}

export async function startObservability(config: ObservabilityConfig, options: ObservabilityOptions = {}): Promise<ObservabilityRuntime> {
  if (!config.enabled) return noopRuntime();
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    // 此消息中不得包含异常、URL、载荷或授权标头。
    try { console.warn('[observability] Telemetry export failed or exceeded its deadline; telemetry may be dropped.'); } catch {}
  };
  const shutdownTimeoutMs = lifecycleTimeout(config.shutdownTimeoutMs);
  const exportTimeoutMs = Math.min(1000, shutdownTimeoutMs, timeout(config.metricExportIntervalMs, 60000));
  let tracerProvider: BasicTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let ownsTrace = false;
  let ownsMeter = false;
  let ownsContext = false;
  let ownsPropagation = false;
  const contextManager = new AsyncLocalStorageContextManager();
  const unregister = () => {
    if (ownsTrace) trace.disable();
    if (ownsMeter) metrics.disable();
    if (ownsPropagation) propagation.disable();
    if (ownsContext) { context.disable(); contextManager.disable(); }
    ownsTrace = ownsMeter = ownsPropagation = ownsContext = false;
  };
  try {
    const resource = createObservabilityResource(config);
    // 已安装的 OTLP HTTP 传输会对临时错误进行带抖动重试（最多重试 5 次）。
    // 导出截止时间限制了重试预算；这里不再添加第二层重试循环。
    // 标头由标准环境变量 OTEL_EXPORTER_OTLP[_SIGNAL]_HEADERS 处理。
    const spanExporter = options.spanExporter ?? new OTLPTraceExporter({
      ...(config.otlpEndpoint ? { url: `${config.otlpEndpoint}/v1/traces` } : {}),
      timeoutMillis: exportTimeoutMs, concurrencyLimit: 1,
    });
    const metricExporter = options.metricExporter ?? new OTLPMetricExporter({
      ...(config.otlpEndpoint ? { url: `${config.otlpEndpoint}/v1/metrics` } : {}),
      timeoutMillis: exportTimeoutMs, concurrencyLimit: 1,
    });
    tracerProvider = new BasicTracerProvider({
      resource,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.tracesSampleRatio) }),
      spanLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 4096, eventCountLimit: 64, linkCountLimit: 32 },
      spanProcessors: [new BatchSpanProcessor({
        export: safeExport(spanExporter.export.bind(spanExporter), exportTimeoutMs, warn),
        shutdown: () => bounded(() => spanExporter.shutdown(), exportTimeoutMs, warn),
      }, { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5000, exportTimeoutMillis: exportTimeoutMs + 100 }), ...(options.extraSpanProcessors ?? [])],
    });
    const safeMetricExporter: PushMetricExporter = {
      export: safeExport(metricExporter.export.bind(metricExporter), exportTimeoutMs, warn),
      forceFlush: () => bounded(() => metricExporter.forceFlush(), exportTimeoutMs, warn),
      shutdown: () => bounded(() => metricExporter.shutdown(), exportTimeoutMs, warn),
      ...(metricExporter.selectAggregationTemporality ? { selectAggregationTemporality: metricExporter.selectAggregationTemporality.bind(metricExporter) } : {}),
      ...(metricExporter.selectAggregation ? { selectAggregation: metricExporter.selectAggregation.bind(metricExporter) } : {}),
    };
    meterProvider = new MeterProvider({
      resource,
      views: [{ instrumentName: '*', aggregationCardinalityLimit: 2000 }],
      readers: [new PeriodicExportingMetricReader({
        exporter: safeMetricExporter,
        exportIntervalMillis: timeout(config.metricExportIntervalMs, 60000),
        exportTimeoutMillis: exportTimeoutMs,
      })],
    });
    ownsContext = context.setGlobalContextManager(contextManager);
    if (ownsContext) contextManager.enable();
    ownsTrace = trace.setGlobalTracerProvider(tracerProvider);
    ownsMeter = metrics.setGlobalMeterProvider(meterProvider);
    ownsPropagation = propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const spans = tracerProvider;
    const meters = meterProvider;
    let shutdownPromise: Promise<void> | undefined;
    const flush = () => Promise.all([spans.forceFlush(), meters.forceFlush()]);
    return {
      tracer: spans.getTracer('@repo/observability', config.serviceVersion),
      meter: meters.getMeter('@repo/observability', config.serviceVersion),
      forceFlush(timeoutMs) {
        if (shutdownPromise) return shutdownPromise;
        return bounded(flush, lifecycleTimeout(timeoutMs, shutdownTimeoutMs), warn);
      },
      shutdown(timeoutMs) {
        if (shutdownPromise) return shutdownPromise;
        const budget = lifecycleTimeout(timeoutMs, shutdownTimeoutMs);
        const deadline = performance.now() + budget;
        shutdownPromise = (async () => {
          await bounded(flush, budget, warn);
          // 即使 flush 已耗尽整个截止时间，也始终启动清理流程。
          unregister();
          const cleanup = () => Promise.all([spans.shutdown(), meters.shutdown()]);
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            // 超过截止时间后不再让调用方额外等待。导出器适配器仍会单独限制清理时长，
            // 且所有延迟到达的拒绝都会被处理。
            void Promise.resolve().then(cleanup).catch(warn);
            return;
          }
          await bounded(cleanup, remaining, warn);
        })();
        return shutdownPromise;
      },
    };
  } catch {
    warn();
    unregister();
    await bounded(() => Promise.all([tracerProvider?.shutdown(), meterProvider?.shutdown()]), shutdownTimeoutMs, warn);
    return noopRuntime();
  }
}
