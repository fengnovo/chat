import { loadConfig, type KnowledgeServiceConfig } from './config.js';
import { createMcpHttpServer } from './mcp/server.js';
import { startConsumer } from './consumer.js';
import { reconcileQueuedJobs } from './reconciler.js';
export interface CloseableService { close(): Promise<void> }
export async function startKnowledgeService(config: KnowledgeServiceConfig = loadConfig(), deps: any = {}): Promise<CloseableService> {
  if (!deps.worker && (!deps.connection || !deps.repository || !deps.pipeline)) throw new Error('knowledge service dependencies required');
  if (!deps.retriever && !deps.server) throw new Error('retriever dependency required');
  const worker = deps.worker ?? startConsumer('knowledge-index', deps.connection, deps, config.concurrency);
  const server = deps.server ?? createMcpHttpServer({ tokenSecret: config.tokenSecret, retriever: deps.retriever, logger: deps.logger });
  try {
    await new Promise<void>((resolve, reject) => { server.once?.('error', reject); server.listen(config.port, resolve); });
  } catch (error) {
    await Promise.allSettled([worker.close?.(), server.close?.()]); throw error;
  }
  const timer = deps.repository && deps.queue ? setInterval(() => reconcileQueuedJobs(deps.repository, deps.queue).catch((e) => deps.logger?.error?.(e)), 30_000) : undefined;
  return { close: async () => {
    if (timer) clearInterval(timer);
    const closeHttp = () => new Promise<void>((resolve) => server.close?.(() => resolve()));
    await Promise.allSettled([worker.close?.(), closeHttp(), deps.queue?.close?.(), deps.connection?.quit?.()]);
  } };
}
