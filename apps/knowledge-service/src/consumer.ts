import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { Worker } from 'bullmq';
import { IndexPipeline } from '@repo/knowledge-graphrag';
import {
  extractObservabilityContext,
  type CoreMetrics,
} from '@repo/observability';

export interface IndexConsumerTelemetry {
  tracer: Tracer;
  metrics: Pick<CoreMetrics, 'queueWait' | 'queueJob' | 'knowledgeOperation'>;
  logger?: { error?(error: unknown): void };
}

function safely(action: () => void): void {
  try {
    action();
  } catch {}
}

export function startConsumer(
  queueName: string,
  connection: any,
  deps: any,
  concurrency = 2,
  telemetry?: IndexConsumerTelemetry,
): Worker {
  const pipeline = deps.pipeline ?? new IndexPipeline(deps);
  const WorkerClass: any = deps.WorkerClass ?? Worker;
  const worker = new WorkerClass(queueName, async (job: any) => {
    // 索引任务由 API 入队时携带 trace 上下文；reconciler 补偿入队的旧任务没有上下文，
    // consumer 作为独立 root trace，用 link 关联上游。
    const producerContext = extractObservabilityContext(job.data?.observability ?? {});
    const producerSpanContext = trace.getSpan(producerContext)?.spanContext();
    const links = producerSpanContext && trace.isSpanContextValid(producerSpanContext)
      ? [{ context: producerSpanContext, attributes: { 'link.name': 'knowledge.enqueue' } }]
      : [];
    const waitMs =
      typeof job.timestamp === 'number' && typeof job.processedOn === 'number'
        ? Math.max(0, job.processedOn - job.timestamp)
        : undefined;
    const startedAt = Date.now();
    const span = telemetry?.tracer.startSpan(
      'knowledge.job.execute',
      {
        kind: SpanKind.CONSUMER,
        links,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': queueName,
          'messaging.operation.name': 'process',
          ...(job.id ? { 'messaging.message.id': String(job.id) } : {}),
          'job.kind': 'index',
          ...(waitMs !== undefined ? { 'queue.wait.ms': waitMs } : {}),
        },
      },
      ROOT_CONTEXT,
    );
    if (waitMs !== undefined && telemetry) {
      safely(() => telemetry.metrics.queueWait({ queue: 'knowledge-index', job: 'index', waitMs }));
    }

    let claimed: { jobId: string; leaseToken: string } | null = null;
    let claimedOnce = false;
    const activeContext = span
      ? trace.setSpan(ROOT_CONTEXT, span)
      : context.active();
    let outcome: 'completed' | 'failed' = 'completed';
    try {
      await context.with(activeContext, async () => {
        const indexStartedAt = Date.now();
        let indexOutcome: 'success' | 'failure' = 'success';
        try {
          const tenantId = String(job.data?.tenantId ?? job.data?.tenant_id ?? '');
          const kbId = String(job.data?.kbId ?? job.data?.kb_id ?? '');
          const documentId = String(job.data?.documentId ?? job.data?.document_id ?? '');
          claimed = await deps.repository.claimIndexJob(tenantId, job.id!, deps.leaseMs ?? 120_000);
          if (!claimed) return;
          claimedOnce = true;
          let input: Record<string, unknown>;
          if (typeof deps.repository.getDocumentForIndex === 'function') {
            // 生产路径：队列里只存任务行（snake_case），文档与切片配置一律以数据库当前状态为准。
            const document = await deps.repository.getDocumentForIndex(tenantId, kbId, documentId);
            if (!document) throw new Error(`Index document not found: ${documentId}`);
            const knowledgeBase = await deps.repository.getKnowledgeBaseForIndex(tenantId, kbId);
            if (!knowledgeBase) throw new Error(`Knowledge base not found: ${kbId}`);
            input = {
              id: job.id,
              tenantId,
              kbId,
              documentId,
              objectKey: document.object_key,
              contentHash: document.content_hash,
              sizeBytes: Number(document.size_bytes),
              mime: document.mime,
              chunkSize: Number(knowledgeBase.chunk_size),
              chunkOverlap: Number(knowledgeBase.chunk_overlap),
              leaseToken: claimed!.leaseToken,
            };
          } else {
            // host-adapter / 测试路径：调用方在任务里直接内联完整索引参数。
            input = { ...job.data, id: job.id, tenantId, leaseToken: claimed!.leaseToken };
          }
          await pipeline.run(input);
          // 文档索引完成后，把同目录下尚未挂载的资源绑到本文档，便于检索时按 (document_id, rel_path) 命中。
          if (typeof deps.repository.attachAssetsToDocument === 'function') {
            safely(() => deps.repository.attachAssetsToDocument(tenantId, kbId, documentId));
          }
        } catch (error) {
          indexOutcome = 'failure';
          throw error;
        } finally {
          // 未抢到租约的任务是正常跳过，不结算 index 指标，避免虚增成功率分母。
          if (claimedOnce) {
            safely(() =>
              telemetry?.metrics.knowledgeOperation({
                operation: 'index',
                outcome: indexOutcome,
                durationMs: Date.now() - indexStartedAt,
              }),
            );
          }
        }
      });
    } catch (error) {
      outcome = 'failed';
      const claimedLease = claimed as { jobId: string; leaseToken: string } | null;
      if (claimedLease) await deps.repository.failIndexJob?.(job.data?.tenantId ?? job.data?.tenant_id, job.id!, claimedLease.leaseToken, error);
      deps.metrics?.indexFailure?.();
      deps.logger?.error?.(error);
      safely(() => {
        telemetry?.logger?.error?.(error);
        span?.setStatus({ code: SpanStatusCode.ERROR });
        span?.setAttribute(
          'error.type',
          error instanceof Error ? error.constructor.name.slice(0, 40) : 'unknown',
        );
      });
      throw error;
    } finally {
      safely(() => {
        // consume 覆盖整个任务处理（含加载/租约），index 只覆盖索引段。
        if (claimedOnce) {
          telemetry?.metrics.knowledgeOperation({
            operation: 'consume',
            outcome: outcome === 'completed' ? 'success' : 'failure',
            durationMs: Date.now() - startedAt,
          });
        }
        telemetry?.metrics.queueJob({
          queue: 'knowledge-index',
          job: 'index',
          outcome,
          durationMs: Date.now() - startedAt,
        });
        span?.end();
      });
    }
  }, { connection, concurrency });
  worker.on('error', (error: unknown) => {
    deps.logger?.error?.(error);
    safely(() => telemetry?.logger?.error?.(error));
  });
  return worker;
}
