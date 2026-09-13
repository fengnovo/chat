import { loadConfig, type KnowledgeServiceConfig } from './config.js';
import { createMcpHttpServer } from './mcp/server.js';
import { startConsumer } from './consumer.js';
import { reconcileQueuedJobs } from './reconciler.js';
export interface CloseableService { close(): Promise<void> }
export async function startKnowledgeService(config: KnowledgeServiceConfig = loadConfig(), deps: any = {}): Promise<CloseableService> {
  const worker = deps.worker ?? startConsumer('knowledge-index', deps.connection, deps, config.concurrency);
  const server = deps.server ?? createMcpHttpServer({ tokenSecret: config.tokenSecret, retriever: deps.retriever, logger: deps.logger });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const timer = deps.repository && deps.queue ? setInterval(() => reconcileQueuedJobs(deps.repository, deps.queue).catch((e) => deps.logger?.error?.(e)), 30_000) : undefined;
  return { close: async () => { if (timer) clearInterval(timer); await worker.close(); await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve())); } };
}
