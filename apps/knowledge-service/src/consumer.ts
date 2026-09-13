import { Worker } from 'bullmq';
import { IndexPipeline } from '@repo/knowledge-graphrag';
export function startConsumer(queueName: string, connection: any, deps: any, concurrency = 2): Worker {
  const pipeline = deps.pipeline ?? new IndexPipeline(deps);
  const worker = new Worker(queueName, async (job) => {
    try {
      const claimed = await deps.repository.claimIndexJob(job.data.tenantId, job.id!, deps.leaseMs ?? 120_000);
      if (!claimed) return;
      await pipeline.run({ ...job.data, id: job.id, leaseToken: claimed.leaseToken });
    } catch (error) {
      deps.metrics?.indexFailure?.(); deps.logger?.error?.(error); throw error;
    }
  }, { connection, concurrency });
  worker.on('error', (error) => deps.logger?.error?.(error));
  return worker;
}
