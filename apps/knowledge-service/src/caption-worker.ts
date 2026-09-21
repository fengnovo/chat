import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { Worker, type Job } from 'bullmq';
import { extractObservabilityContext, type CoreMetrics } from '@repo/observability';
import type { Pool } from 'pg';

import type { ImageCaptioner } from './caption-provider.js';

export interface CaptionWorkerTelemetry {
  tracer: Tracer;
  metrics: Pick<CoreMetrics, 'queueWait' | 'queueJob' | 'knowledgeOperation'>;
  logger?: { error?(error: unknown): void; warn?(message: string, fields?: unknown): void; info?(message: string, fields?: unknown): void };
}

export interface CaptionWorkerDeps {
  pool: Pick<Pool, 'query'>;
  repository: any;
  /** 取图片 bytes；按 objectKey 拿。 */
  download: (objectKey: string) => Promise<Uint8Array>;
  captioner: ImageCaptioner;
  logger?: CaptionWorkerTelemetry['logger'];
  /** 写完 caption 后，若 asset 已挂到 document，则入队 reindex。注入可传 false 以关闭。 */
  onCaptionReady?: (input: { tenantId: string; kbId: string; documentId: string; assetId: string }) => Promise<void> | void;
  leaseMs?: number;
  modelName: string;
  /** 测试用：注入自定义 Worker 实现，避免依赖 bullmq runtime。 */
  WorkerClass?: new (queueName: string, handler: (job: any) => Promise<unknown>, options?: unknown) => { on: (...args: unknown[]) => unknown; close: () => Promise<void> };
}

function safely(action: () => void): void {
  try { action(); } catch {}
}

/** 计算指数退避：1s, 5s, 30s, 2min, 10min。next_attempt_at 用这个 offset。 */
function backoffMs(attempt: number): number {
  const table = [1_000, 5_000, 30_000, 120_000, 600_000];
  return table[Math.min(attempt, table.length - 1)]!;
}

/**
 * BullMQ consumer：处理 knowledge-caption 队列里的 caption 任务。
 * 每条任务 = 一张图片（asset_id + 上下文）。流程：
 *   claim → 拉 bytes → 调 VLM → 写 knowledge_assets.caption → 若已挂 doc 则 reindex。
 */
export function startCaptionWorker(
  queueName: string,
  connection: any,
  deps: CaptionWorkerDeps,
  concurrency = 2,
  telemetry?: CaptionWorkerTelemetry,
): Worker {
  const leaseMs = deps.leaseMs ?? 180_000;
  const modelName = deps.modelName;
  const WorkerClass: any = (deps as any).WorkerClass ?? Worker;
  const worker = new WorkerClass(queueName, async (job: Job<{ tenantId: string; jobId: string }>) => {
    const producerContext = extractObservabilityContext((job as any).data?.observability ?? {});
    const producerSpanContext = trace.getSpan(producerContext)?.spanContext();
    const links = producerSpanContext && trace.isSpanContextValid(producerSpanContext)
      ? [{ context: producerSpanContext, attributes: { 'link.name': 'knowledge.caption.enqueue' } }]
      : [];
    const waitMs = typeof job.timestamp === 'number' && typeof job.processedOn === 'number'
      ? Math.max(0, job.processedOn - job.timestamp)
      : undefined;
    const startedAt = Date.now();
    const span = telemetry?.tracer.startSpan(
      'knowledge.caption.execute',
      {
        kind: SpanKind.CONSUMER,
        links,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': queueName,
          'messaging.operation.name': 'process',
          ...(job.id ? { 'messaging.message.id': String(job.id) } : {}),
          'job.kind': 'caption',
          ...(waitMs !== undefined ? { 'queue.wait.ms': waitMs } : {}),
        },
      },
      ROOT_CONTEXT,
    );
    if (waitMs !== undefined && telemetry) {
      safely(() => telemetry.metrics.queueWait({ queue: 'knowledge-caption', job: 'caption', waitMs }));
    }
    const activeContext = span ? trace.setSpan(ROOT_CONTEXT, span) : context.active();

    let claimed: { jobId: string; leaseToken: string } | null = null;
    let outcome: 'completed' | 'failed' | 'skipped' = 'completed';
    try {
      await context.with(activeContext, async () => {
        const opStartedAt = Date.now();
        let opOutcome: 'success' | 'failure' = 'success';
        try {
          const tenantId = job.data?.tenantId;
          const jobId = job.data?.jobId ?? job.id;
          if (!tenantId || !jobId) throw new Error('caption job missing tenantId or jobId');
          claimed = await deps.repository.claimCaptionJob(tenantId, jobId, leaseMs);
          if (!claimed) return;
          const jobRow = await deps.repository.getCaptionJob(tenantId, jobId);
          if (!jobRow) throw new Error(`caption job row missing: ${jobId}`);
          const asset = await deps.repository.getAssetForCaption(tenantId, jobRow.asset_id);
          if (!asset) {
            await deps.repository.completeCaptionJob(tenantId, jobId, claimed.leaseToken, {
              caption: null, model: modelName, status: 'skipped', error: { code: 'asset_missing', message: 'asset deleted or moved' },
            });
            outcome = 'skipped';
            return;
          }
          if (asset.caption_status === 'disabled') {
            await deps.repository.completeCaptionJob(tenantId, jobId, claimed.leaseToken, {
              caption: null, model: modelName, status: 'skipped',
            });
            outcome = 'skipped';
            return;
          }
          const bytes = await deps.download(asset.object_key);
          const caption = await deps.captioner({ bytes, mime: asset.mime, hint: asset.name });
          if (caption === null) {
            // 模型拒答 / 拿到空内容：归类为 skipped，不计入失败重试（已 ready 没意义，跳过即可）。
            await deps.repository.completeCaptionJob(tenantId, jobId, claimed.leaseToken, {
              caption: null, model: modelName, status: 'skipped', error: { code: 'empty_response', message: 'captioner returned empty content' },
            });
            outcome = 'skipped';
            return;
          }
          await deps.repository.completeCaptionJob(tenantId, jobId, claimed.leaseToken, {
            caption, model: modelName, status: 'completed',
          });
          // 资产已挂到文档则触发再索引，把 caption 嵌入向量空间。
          if (asset.document_id) {
            try {
              await deps.onCaptionReady?.({
                tenantId, kbId: asset.kb_id, documentId: asset.document_id, assetId: asset.id,
              });
            } catch (error) {
              deps.logger?.error?.(error);
              deps.logger?.warn?.('caption ready but reindex trigger failed', { assetId: asset.id });
            }
          }
        } catch (error) {
          opOutcome = 'failure';
          // 重试判定：用已累计 attempts 决定。
          const tenantId = job.data?.tenantId;
          const jobId = job.data?.jobId ?? job.id;
          if (claimed && tenantId && jobId) {
            const jobRow = await deps.repository.getCaptionJob(tenantId, jobId);
            const attempts = Number(jobRow?.attempts ?? 1);
            const maxAttempts = Number(jobRow?.max_attempts ?? 3);
            const code = error instanceof Error ? error.constructor.name : 'caption_failed';
            const message = error instanceof Error ? error.message : String(error);
            const { requeued } = await deps.repository.failCaptionJobWithRetry(
              tenantId, jobId, claimed.leaseToken, { code, message },
              backoffMs(attempts),
              { attempts, maxAttempts },
            );
            if (requeued) outcome = 'failed';
            else { outcome = 'skipped'; deps.logger?.warn?.('caption retries exhausted, marked skipped', { jobId, code, message }); }
          } else {
            outcome = 'failed';
          }
          throw error;
        } finally {
          safely(() =>
            telemetry?.metrics.knowledgeOperation({
              operation: 'caption',
              outcome: opOutcome,
              durationMs: Date.now() - opStartedAt,
            }),
          );
        }
      });
    } catch (error) {
      deps.logger?.error?.(error);
      safely(() => {
        span?.setStatus({ code: SpanStatusCode.ERROR });
        span?.setAttribute('error.type', error instanceof Error ? error.constructor.name.slice(0, 40) : 'unknown');
      });
    } finally {
      safely(() => {
        telemetry?.metrics.queueJob({
          queue: 'knowledge-caption',
          job: 'caption',
          outcome: outcome,
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

/**
 * 简化版 enqueue：API 进程只需把 { tenantId, jobId } 投到队列。
 * jobId 用 knowledge_caption_jobs.id（UUID）—— caption worker 自行拉详情。
 */
export async function findOrCreateCaptionJob(
  repository: any,
  input: { tenantId: string; kbId: string; assetId: string; maxAttempts?: number },
): Promise<{ id: string } | null> {
  const result = await repository.enqueueCaptionJob(input);
  return result ? { id: result.id } : null;
}