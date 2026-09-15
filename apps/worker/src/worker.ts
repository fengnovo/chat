import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { closeSharedMcpClients } from '@repo/agent-core';
import { S3ArtifactStore } from '@repo/artifacts';
import { RUN_QUEUE_NAME, runCancellationChannel } from '@repo/contracts';
import { createDatabase, migrateDatabase } from '@repo/db';
import { registeredObservability } from '@repo/observability/register';
import { redactTelemetryValue } from '@repo/observability';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { loadWorkerConfig } from './config.js';
import { createWorkerObservability } from './observability.js';
import { createWorkerLangfuse } from './langfuse.js';
import { createRunProcessor } from './processor.js';

const runtime = await registeredObservability;
const observability = createWorkerObservability(runtime, { serviceVersion: '0.1.0' });
const { logger } = observability;
// Langfuse 只在 Worker 装配；processor 挂在共享 tracer provider 上，
// 因此 shutdown 时由 runtime.forceFlush/shutdown 统一覆盖 5s 上限，不单独等待。
const langfuse = createWorkerLangfuse({
  shutdownTimeoutMs: observability.config.shutdownTimeoutMs,
});

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
  enableReadyCheck: false,
});
const controllers = new Map<string, AbortController>();
const artifacts = new S3ArtifactStore({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKey: config.S3_ACCESS_KEY,
  secretKey: config.S3_SECRET_KEY,
});
await artifacts.ensureBucket();

await cancellationSubscriber.psubscribe('agent:run:*:cancel');
cancellationSubscriber.on('pmessage', (_pattern, channel) => {
  const runId = channel.slice('agent:run:'.length, -':cancel'.length);
  controllers.get(runId)?.abort(new Error('Run cancelled by user'));
});
cancellationSubscriber.on('error', (error) => {
  logger.error(
    { error: redactTelemetryValue(error), operation: 'cancellation.subscriber' },
    'cancellation subscriber error',
  );
});

const worker = new Worker(
  RUN_QUEUE_NAME,
  createRunProcessor(
    {
      config,
      repository: database.repository,
      redis: connection,
      publisher,
      checkpointer,
      artifacts,
      controllers,
    },
    observability,
    langfuse,
  ),
  {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: 300_000,
  },
);

worker.on('completed', (job) =>
  logger.info({ operation: 'worker.job', reason: 'completed' }, `run job ${job.id ?? ''} completed`),
);
worker.on('failed', (job, error) =>
  logger.error(
    { error: redactTelemetryValue(error), operation: 'worker.job', reason: 'failed' },
    `run job ${job?.id ?? ''} failed`,
  ),
);
worker.on('error', (error) =>
  logger.error({ error: redactTelemetryValue(error), operation: 'worker' }, 'worker error'),
);

const sandboxDetail =
  config.SANDBOX_RUNTIME === 'docker'
    ? ` (${config.DOCKER_SANDBOX_IMAGE})`
    : config.E2B_API_URL
      ? ` (${config.E2B_API_URL})`
      : '';
logger.info(
  {
    operation: 'worker.startup',
    reason: 'ready',
  },
  `agent worker ready: driver=${config.AGENT_DRIVER}, sandbox=${config.SANDBOX_RUNTIME}${sandboxDetail}, concurrency=${config.WORKER_CONCURRENCY}`,
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ operation: 'worker.shutdown' }, 'worker shutdown started');
  try {
    // 1. 停止领取新任务。
    await worker.pause();
    // 2. 通知在途任务尽快收尾。
    for (const controller of controllers.values()) {
      controller.abort(new Error('Worker shutting down'));
    }
    // 3. 等待在途任务退出（abort 后很快结束）。
    await worker.close();
    // 4. 关闭业务资源（含进程级共享的 base MCP client）。
    await closeSharedMcpClients();
    await cancellationSubscriber.quit();
    await publisher.quit();
    await connection.quit();
    await checkpointer.end();
    artifacts.destroy();
    await database.repository.close();
    // 5. flush 遥测后退出，超时只告警不阻塞进程。
    await runtime.forceFlush(observability.config.shutdownTimeoutMs);
    await runtime.shutdown(observability.config.shutdownTimeoutMs);
    process.exit(0);
  } catch (error) {
    logger.error(
      { error: redactTelemetryValue(error), operation: 'worker.shutdown' },
      'worker shutdown failed',
    );
    await runtime.shutdown(observability.config.shutdownTimeoutMs).catch(() => undefined);
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

export { runCancellationChannel };
