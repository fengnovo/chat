import { loadConfig, type KnowledgeServiceConfig } from './config.js';
import { createMcpHttpServer } from './mcp/server.js';
import { startConsumer } from './consumer.js';
import { reconcileQueuedJobs } from './reconciler.js';
import { createKnowledgeRuntime } from './runtime.js';

export { createKnowledgeRuntime } from './runtime.js';
export interface CloseableService { close(): Promise<void> }
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
  const worker = runtime.worker ?? startConsumer('knowledge-index', runtime.connection, runtime, config.concurrency);
  const server = runtime.server ?? createMcpHttpServer({ tokenSecret: config.tokenSecret, retriever: runtime.retriever, logger: runtime.logger });
  try {
    await new Promise<void>((resolve, reject) => { server.once?.('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (error) {
    const closeServer = () => new Promise<void>((resolve) => { if (!server.close) return resolve(); server.close(() => resolve()); });
    await Promise.allSettled([worker.close?.(), closeServer(), runtime.queue?.close?.(), runtime.connection?.quit?.()]); throw error;
  }
  const timer = runtime.repository && runtime.queue ? setInterval(() => reconcileQueuedJobs(runtime.repository, runtime.queue).catch((e) => runtime.logger?.error?.(e)), 30_000) : undefined;
  return { close: async () => {
    if (timer) clearInterval(timer);
    const closeHttp = () => new Promise<void>((resolve) => server.close?.(() => resolve()));
    await Promise.allSettled([worker.close?.(), closeHttp(), runtime.queue?.close?.(), runtime.connection?.quit?.()]);
  } };
}
