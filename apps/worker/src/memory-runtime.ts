import type { Job } from 'bullmq';
import { createMemoryQueueProcessor, type startMemoryConsumer } from './memory-consumer.js';

/** Both Redis wake-ups and polling claim PostgreSQL jobs; notification delivery is optional. */
export function startMemoryRuntime(options: Parameters<typeof startMemoryConsumer>[0]) {
  const processQueueJob = createMemoryQueueProcessor(options);
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    // The queue processor deliberately ignores the hint payload and claims durable work.
    active = processQueueJob({ name: 'durable-poll' } as Job)
      .catch((error) => options.logger?.error('memory polling failed', error))
      .finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, options.intervalMs ?? 2_000);
  timer.unref();
  tick();
  return {
    processQueueJob,
    async stop() { stopped = true; clearInterval(timer); await active; },
  };
}
