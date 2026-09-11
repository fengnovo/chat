import { runJobSchema } from '@repo/contracts';
import type { AgentRepository } from '@repo/db';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';

interface OutboxDispatcherOptions {
  repository: AgentRepository;
  queue: Queue;
  logger: FastifyBaseLogger;
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  reconcileIntervalMs: number;
  staleAfterMs: number;
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

      await Promise.all(
        dispatches.map(async (dispatch) => {
          try {
            const job = runJobSchema.parse(dispatch.job);
            await this.options.queue.add(job.kind, job, {
              jobId: dispatch.id,
              attempts: 1,
              removeOnComplete: 500,
              removeOnFail: 1_000,
            });
            await this.options.repository.markDispatchPublished(dispatch.id);
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
          }
        }),
      );

      if (dispatches.length < this.options.batchSize) return;
    }
  }
}
