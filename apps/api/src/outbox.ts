import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import {
  RUN_QUEUE_NAME,
  runJobSchema,
  type RunJob,
} from '@repo/contracts';
import type { CoreMetrics } from '@repo/observability';
import { extractObservabilityContext, injectObservabilityContext } from '@repo/observability';
import type { AgentRepository, DispatchOutboxRecord } from '@repo/db';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';

interface OutboxTelemetry {
  tracer: Tracer;
  metrics: Pick<CoreMetrics, 'outboxDispatch'>;
}

interface OutboxDispatcherOptions {
  repository: AgentRepository;
  queue: Queue;
  logger: FastifyBaseLogger;
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  reconcileIntervalMs: number;
  staleAfterMs: number;
  queueName?: string;
  telemetry?: OutboxTelemetry;
}

export class RunOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private lastReconciledAt = 0;

  constructor(private readonly options: OutboxDispatcherOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.options.pollIntervalMs);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.draining) return;
    this.draining = this.drain()
      .catch((error) => {
        this.options.logger.error({ error }, 'outbox drain failed');
      })
      .finally(() => {
        this.draining = null;
      });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.draining;
  }

  async drainNow(): Promise<void> {
    if (this.draining) await this.draining;
    await this.drain();
  }

  private async publishDispatch(dispatch: DispatchOutboxRecord): Promise<void> {
    const { telemetry, queueName } = this.options;
    const job = runJobSchema.parse(dispatch.job);
    const parent = extractObservabilityContext(job.observability ?? {});
    let span;
    try {
      span = telemetry?.tracer.startSpan(
        'outbox.dispatch',
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            'messaging.system': 'bullmq',
            'messaging.destination.name': queueName ?? RUN_QUEUE_NAME,
            'messaging.operation.name': 'publish',
            'messaging.message.id': dispatch.id,
            'job.kind': job.kind,
            'messaging.operation.attempt': dispatch.attempts,
          },
        },
        parent,
      );
    } catch {
      span = undefined;
    }
    const active = span ? trace.setSpan(parent, span) : parent;
    // Re-inject the producer span context so the Worker consumer can link directly
    // to this dispatch span, while request_id stays associated end to end.
    let payload: RunJob = job;
    try {
      const carrier = injectObservabilityContext(active, job.observability?.requestId);
      payload = { ...job, observability: carrier };
    } catch {
      payload = job;
    }
    try {
      await context.with(active, async () => {
        await this.options.queue.add(job.kind, payload, {
          jobId: dispatch.id,
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 1_000,
        });
      });
      await this.options.repository.markDispatchPublished(dispatch.id);
      try { telemetry?.metrics.outboxDispatch({ outcome: 'published' }); } catch {}
      try {
        span?.setStatus({ code: SpanStatusCode.OK });
      } catch {}
    } catch (error) {
      const retryDelayMs = Math.min(
        30_000,
        250 * 2 ** Math.min(dispatch.attempts - 1, 7),
      );
      await this.options.repository.rescheduleDispatch(
        dispatch.id,
        error instanceof Error ? error.message : String(error),
        retryDelayMs,
      );
      this.options.logger.warn(
        { error, dispatchId: dispatch.id, retryDelayMs },
        'outbox dispatch will be retried',
      );
      try { telemetry?.metrics.outboxDispatch({ outcome: 'failed' }); } catch {}
      try {
        span?.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span?.recordException(error);
      } catch {}
    } finally {
      try { span?.end(); } catch {}
    }
  }

  private async drain(): Promise<void> {
    if (Date.now() - this.lastReconciledAt >= this.options.reconcileIntervalMs) {
      this.lastReconciledAt = Date.now();
      const requeued = await this.options.repository.requeueStaleDispatches(
        this.options.staleAfterMs,
        this.options.batchSize,
      );
      if (requeued > 0) {
        this.options.logger.warn({ requeued }, 'stale outbox dispatches requeued');
      }
    }
    while (true) {
      const dispatches = await this.options.repository.claimDispatches(
        this.options.batchSize,
        this.options.leaseMs,
      );
      if (dispatches.length === 0) return;

      await Promise.all(dispatches.map((dispatch) => this.publishDispatch(dispatch)));

      if (dispatches.length < this.options.batchSize) return;
    }
  }
}
