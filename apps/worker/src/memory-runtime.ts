import type { Job } from 'bullmq';
import { createMemoryQueueProcessor, type startMemoryConsumer } from './memory-consumer.js';

/** Redis 唤醒和轮询都会领取 PostgreSQL 任务；通知投递是可选的。 */
export function startMemoryRuntime(options: Parameters<typeof startMemoryConsumer>[0]) {
  const processQueueJob = createMemoryQueueProcessor(options);
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    // 队列处理器会有意忽略提示载荷，改为领取持久化任务。
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
