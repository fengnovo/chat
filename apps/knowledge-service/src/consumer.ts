import { Worker } from 'bullmq';
import { IndexPipeline } from '@repo/knowledge-graphrag';
export function startConsumer(queueName: string, connection: any, deps: any, concurrency = 2): Worker {
  const pipeline = deps.pipeline ?? new IndexPipeline(deps);
  const WorkerClass: any = deps.WorkerClass ?? Worker;
  const worker = new WorkerClass(queueName, async (job: any) => {
    let claimed: any;
    try {
      claimed = await deps.repository.claimIndexJob(job.data.tenantId, job.id!, deps.leaseMs ?? 120_000);
      if (!claimed) return;
      await pipeline.run({ ...job.data, id: job.id, leaseToken: claimed.leaseToken });
    } catch (error) {
      if (claimed) await deps.repository.failIndexJob?.(job.data.tenantId, job.id!, claimed.leaseToken, error);
      deps.metrics?.indexFailure?.(); deps.logger?.error?.(error); throw error;
    }
  }, { connection, concurrency });
  worker.on('error', (error: unknown) => deps.logger?.error?.(error));
  return worker;
}
