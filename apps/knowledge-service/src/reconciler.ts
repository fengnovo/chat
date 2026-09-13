export interface IndexQueue { add(name: string, data: unknown, opts: { jobId: string }): Promise<unknown> }
export interface IndexJobRepository { listQueuedOrStaleIndexJobs(now: Date, limit: number): Promise<any[]> }
export async function reconcileQueuedJobs(repo: IndexJobRepository, queue: IndexQueue, now = new Date(), limit = 100): Promise<number> {
  const jobs = await repo.listQueuedOrStaleIndexJobs(now, limit);
  let count = 0;
  for (const job of jobs) {
    const existing = (queue as any).getJob ? await (queue as any).getJob(job.id) : null;
    if (existing) continue;
    await queue.add('index', job, { jobId: job.id }); count++;
  }
  return count;
}
