import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { RUN_QUEUE_NAME, runCancellationChannel } from '@repo/contracts';
import { createDatabase, migrateDatabase } from '@repo/db';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { loadWorkerConfig } from './config.js';
import { createRunProcessor } from './processor.js';

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL);
await migrateDatabase(database.pool);

const checkpointer = PostgresSaver.fromConnString(config.DATABASE_URL, {
  schema: 'public',
});
await checkpointer.setup();

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const cancellationSubscriber = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const controllers = new Map<string, AbortController>();

await cancellationSubscriber.psubscribe('agent:run:*:cancel');
cancellationSubscriber.on('pmessage', (_pattern, channel) => {
  const runId = channel.slice('agent:run:'.length, -':cancel'.length);
  controllers.get(runId)?.abort(new Error('Run cancelled by user'));
});

const worker = new Worker(
  RUN_QUEUE_NAME,
  createRunProcessor({
    config,
    repository: database.repository,
    redis: connection,
    publisher,
    checkpointer,
    controllers,
  }),
  {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: 300_000,
  },
);

worker.on('completed', (job) => console.log(`Run job ${job.id} completed`));
worker.on('failed', (job, error) => console.error(`Run job ${job?.id} failed`, error));
worker.on('error', (error) => console.error('Worker error', error));

console.log(
  `Agent worker ready: driver=${config.AGENT_DRIVER}, concurrency=${config.WORKER_CONCURRENCY}`,
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    for (const controller of controllers.values()) {
      controller.abort(new Error('Worker shutting down'));
    }
    await worker.close();
    await cancellationSubscriber.quit();
    await publisher.quit();
    await connection.quit();
    await checkpointer.end();
    await database.repository.close();
    process.exit(0);
  } catch (error) {
    console.error('Worker shutdown failed', error);
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

export { runCancellationChannel };
