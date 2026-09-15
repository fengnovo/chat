import { SpanStatusCode } from '@opentelemetry/api';

import { loadConfig, type KnowledgeServiceConfig } from './config.js';
import { createMcpHttpServer } from './mcp/server.js';
import { startConsumer } from './consumer.js';
import { reconcileQueuedJobs } from './reconciler.js';
import { createKnowledgeRuntime } from './runtime.js';

export { createKnowledgeRuntime } from './runtime.js';
export interface CloseableService { close(): Promise<void> }

function safely(action: () => void): void {
  try {
    action();
  } catch {}
}

/** 对账循环：数据库任务状态是事实，遥测只记录尝试/重新入队数量与最终结果。 */
async function reconcileOnce(repository: any, queue: any, telemetry: any): Promise<void> {
  const startedAt = Date.now();
  const span = telemetry?.tracer?.startSpan('knowledge.reconcile');
  let outcome: 'success' | 'failure' = 'success';
  let requeued = 0;
  try {
    requeued = await reconcileQueuedJobs(repository, queue);
  } catch (error) {
    outcome = 'failure';
    safely(() => {
      span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.setAttribute(
        'error.type',
        error instanceof Error ? error.constructor.name.slice(0, 40) : 'unknown',
      );
    });
    throw error;
  } finally {
    safely(() => {
      span?.setAttribute('requeued', requeued);
      telemetry?.metrics?.knowledgeOperation?.({
        operation: 'reconcile',
        outcome,
        durationMs: Date.now() - startedAt,
      });
      span?.end();
    });
  }
}

export async function startKnowledgeService(config: KnowledgeServiceConfig = loadConfig(), deps: any = {}): Promise<CloseableService> {
  const runtime = deps.worker ? deps : createKnowledgeRuntime(config, deps);
  const missing = deps.worker ? [] : [
    ...(!deps.connection ? ['connection'] : []),
    ...(!deps.repository ? ['repository'] : []),
    ...(!deps.pipeline && !deps.download ? ['download'] : []),
    ...(!deps.pipeline && !deps.vectorStore ? ['vectorStore'] : []),
    ...(!deps.pipeline && !deps.extract ? ['extract'] : []),
  ];
  if (missing.length) {
    throw new Error(`Knowledge service default runtime requires dependencies: ${missing.join(', ')}`);
  }
  if (!runtime.retriever && !runtime.server) throw new Error('retriever dependency required');
  const worker = runtime.worker ?? startConsumer('knowledge-index', runtime.connection, runtime, config.concurrency, deps.telemetry);
  const server = runtime.server ?? createMcpHttpServer({
    tokenSecret: config.tokenSecret,
    retriever: runtime.retriever,
    logger: runtime.logger,
    ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
    ...(deps.readiness ? { readiness: deps.readiness } : {}),
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once?.('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (error) {
    const closeServer = () => new Promise<void>((resolve) => { if (!server.close) return resolve(); server.close(() => resolve()); });
    await Promise.allSettled([worker.close?.(), closeServer(), runtime.queue?.close?.(), runtime.connection?.quit?.()]); throw error;
  }
  const timer = runtime.repository && runtime.queue ? setInterval(() => {
    reconcileOnce(runtime.repository, runtime.queue, deps.telemetry)
      .catch((error) => runtime.logger?.error?.(error));
  }, 30_000) : undefined;
  return { close: async () => {
    if (timer) clearInterval(timer);
    const closeHttp = () => new Promise<void>((resolve) => server.close?.(() => resolve()));
    await Promise.allSettled([worker.close?.(), closeHttp(), runtime.queue?.close?.(), runtime.connection?.quit?.()]);
  } };
}
