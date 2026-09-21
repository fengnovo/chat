import { SpanStatusCode } from '@opentelemetry/api';

import { loadConfig, type KnowledgeServiceConfig } from './config.js';
import { createMcpHttpServer } from './mcp/server.js';
import { startConsumer } from './consumer.js';
import { findMissingIndexJobs, requeueMissingJobs } from './reconciler.js';
import { createKnowledgeRuntime } from './runtime.js';

export { createKnowledgeRuntime } from './runtime.js';
export interface CloseableService { close(): Promise<void> }

function safely(action: () => void): void {
  try {
    action();
  } catch {}
}

/**
 * 对账循环：数据库任务状态是事实，遥测只记录尝试/重新入队数量与最终结果。
 * 空轮询（绝大多数情况）只记指标用于心跳与失败率，不产生 trace，避免每 30 秒
 * 向 Langfuse 刷一条 0.01s 的空 span；仅在实际补偿入队或对账失败时才开 span。
 * span 一律回填循环开始时间，保证耗时覆盖「扫描 + 补偿」完整对账尝试。
 */
export async function reconcileOnce(repository: any, queue: any, telemetry: any): Promise<void> {
  const startedAt = Date.now();
  let span: any;
  let outcome: 'success' | 'failure' = 'success';
  let requeued = 0;
  try {
    const missing = await findMissingIndexJobs(repository, queue);
    if (missing.length > 0) {
      span = telemetry?.tracer?.startSpan('knowledge.reconcile', { startTime: startedAt });
      requeued = await requeueMissingJobs(missing, queue);
      safely(() => span?.setAttribute('requeued', requeued));
    }
  } catch (error) {
    outcome = 'failure';
    safely(() => {
      span ??= telemetry?.tracer?.startSpan('knowledge.reconcile', { startTime: startedAt });
      span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.setAttribute(
        'error.type',
        error instanceof Error ? error.constructor.name.slice(0, 40) : 'unknown',
      );
      if (error instanceof Error) span?.recordException(error);
    });
    throw error;
  } finally {
    safely(() => {
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
  const captionWorker = deps.captionWorker as { close?: () => Promise<void> } | undefined;
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
    await Promise.allSettled([worker.close?.(), captionWorker?.close?.(), closeServer(), runtime.queue?.close?.(), runtime.connection?.quit?.()]); throw error;
  }
  const timer = runtime.repository && runtime.queue ? setInterval(() => {
    reconcileOnce(runtime.repository, runtime.queue, deps.telemetry)
      .catch((error) => runtime.logger?.error?.(error));
    // caption 对账：找出 queued / 租约过期的 caption 任务重新投递，依赖 BullMQ 持久化保证重启后仍能恢复。
    if (runtime.repository && deps.captionQueue && typeof reconcileCaptionJobs === 'function') {
      reconcileCaptionJobs(runtime.repository, deps.captionQueue, runtime.logger)
        .catch((error: unknown) => runtime.logger?.error?.(error));
    }
    // caption 孤儿对账：找出「pending 且无任务行」的孤儿资产补一条 caption job。
    // 这条路径专门为 019 迁移之前漏掉的资产和未来可能的 enqueue 失败兜底，
    // 没有这一道，孤儿会永久 pending。共享 30s 节流。
    if (runtime.repository && deps.captionQueue && typeof reconcileOrphanCaptionAssets === 'function') {
      reconcileOrphanCaptionAssets(runtime.repository, runtime.logger)
        .catch((error: unknown) => runtime.logger?.error?.(error));
    }
  }, 30_000) : undefined;
  return { close: async () => {
    if (timer) clearInterval(timer);
    const closeHttp = () => new Promise<void>((resolve) => server.close?.(() => resolve()));
    await Promise.allSettled([worker.close?.(), captionWorker?.close?.(), closeHttp(), runtime.queue?.close?.(), runtime.connection?.quit?.()]);
  } };
}

/**
 * 对账：扫描数据库中尚未被任何 worker claim / 已租赁过期的 caption 任务，重新投递到队列。
 * 与 index 任务的 reconciler 相同模式：DB 是事实，BullMQ 只是事件总线。
 */
export async function reconcileCaptionJobs(repository: any, queue: any, logger: any): Promise<number> {
  if (typeof repository.listQueuedOrStaleCaptionJobs !== 'function') return 0;
  const jobs = await repository.listQueuedOrStaleCaptionJobs(new Date(), 50);
  let requeued = 0;
  for (const job of jobs) {
    try {
      await queue.add(
        'caption-asset',
        { tenantId: job.tenant_id, jobId: job.id },
        { jobId: job.id, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86_400 } },
      );
      requeued++;
    } catch (error) {
      logger?.warn?.(error instanceof Error ? error.message : String(error), { operation: 'caption-reconcile', jobId: job.id });
    }
  }
  return requeued;
}

/**
 * caption 孤儿对账：knowledge_assets 上 caption_status=pending 但
 * knowledge_caption_jobs 里没有对应行的资产，逐条走 enqueueCaptionJob 补一条任务。
 * 复用仓库层的入队逻辑（同样会写 caption_status='queued'），避免单独 SQL 路径
 * 与正常路径的状态机分叉。
 */
export async function reconcileOrphanCaptionAssets(repository: any, logger: any): Promise<number> {
  if (typeof repository.listPendingOrphanCaptionAssets !== 'function') return 0;
  const orphans = await repository.listPendingOrphanCaptionAssets(50);
  let enqueued = 0;
  for (const orphan of orphans) {
    try {
      const result = await repository.enqueueCaptionJob({
        tenantId: orphan.tenantId,
        kbId: orphan.kbId,
        assetId: orphan.id,
      });
      if (result) enqueued++;
    } catch (error) {
      logger?.warn?.(error instanceof Error ? error.message : String(error), {
        operation: 'orphan-caption-reconcile',
        assetId: orphan.id,
      });
    }
  }
  return enqueued;
}
