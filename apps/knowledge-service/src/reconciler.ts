export interface IndexQueue { add(name: string, data: unknown, opts: { jobId: string }): Promise<unknown>; getJob?(id: string): Promise<unknown> }
export interface IndexJobRepository { listQueuedOrStaleIndexJobs(now: Date, limit: number): Promise<any[]> }

/** 找出数据库中 queued/stale、但队列里已不存在的任务（需要补偿入队）。 */
export async function findMissingIndexJobs(
  repo: IndexJobRepository,
  queue: IndexQueue,
  now = new Date(),
  limit = 100,
): Promise<any[]> {
  const jobs = await repo.listQueuedOrStaleIndexJobs(now, limit);
  const missing: any[] = [];
  for (const job of jobs) {
    const existing = queue.getJob ? await queue.getJob(job.id) : null;
    if (!existing) missing.push(job);
  }
  return missing;
}

/** 以数据库 job ID 幂等补投丢失的任务，返回实际入队数量。 */
export async function requeueMissingJobs(jobs: any[], queue: IndexQueue): Promise<number> {
  let count = 0;
  for (const job of jobs) {
    await queue.add('index', job, { jobId: job.id });
    count++;
  }
  return count;
}

export async function reconcileQueuedJobs(repo: IndexJobRepository, queue: IndexQueue, now = new Date(), limit = 100): Promise<number> {
  const missing = await findMissingIndexJobs(repo, queue, now, limit);
  return requeueMissingJobs(missing, queue);
}
