import { Worker } from 'bullmq';
import { IndexPipeline } from '@repo/knowledge-graphrag';

export function startConsumer(queueName: string, connection: any, deps: any, concurrency = 2): Worker {
  const pipeline = deps.pipeline ?? new IndexPipeline(deps);
  const WorkerClass: any = deps.WorkerClass ?? Worker;
  const worker = new WorkerClass(queueName, async (job: any) => {
    let claimed: { jobId: string; leaseToken: string } | null = null;
    try {
      const tenantId = String(job.data?.tenantId ?? job.data?.tenant_id ?? '');
      const kbId = String(job.data?.kbId ?? job.data?.kb_id ?? '');
      const documentId = String(job.data?.documentId ?? job.data?.document_id ?? '');
      claimed = await deps.repository.claimIndexJob(tenantId, job.id!, deps.leaseMs ?? 120_000);
      if (!claimed) return;
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
          leaseToken: claimed.leaseToken,
        };
      } else {
        // host-adapter / 测试路径：调用方在任务里直接内联完整索引参数。
        input = { ...job.data, id: job.id, tenantId, leaseToken: claimed.leaseToken };
      }
      await pipeline.run(input);
    } catch (error) {
      if (claimed) await deps.repository.failIndexJob?.(job.data?.tenantId ?? job.data?.tenant_id, job.id!, claimed.leaseToken, error);
      deps.metrics?.indexFailure?.(); deps.logger?.error?.(error); throw error;
    }
  }, { connection, concurrency });
  worker.on('error', (error: unknown) => deps.logger?.error?.(error));
  return worker;
}
