import { existsSync } from 'node:fs';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { closeSharedMcpClients, getSharedMcpToolsForConfigPath } from '@repo/agent-core';
import { S3ArtifactStore } from '@repo/artifacts';
import { MEMORY_INDEX_QUEUE_NAME, MEMORY_QUEUE_NAME, RUN_QUEUE_NAME, runCancellationChannel } from '@repo/contracts';
import { createDatabase, migrateDatabase } from '@repo/db';
import { registeredObservability } from '@repo/observability/register';
import { redactTelemetryValue } from '@repo/observability';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { loadWorkerConfig } from './config.js';
import { createWorkerObservability } from './observability.js';
import { createWorkerLangfuse } from './langfuse.js';
import { createRunProcessor } from './processor.js';
import { createMemoryQueueProcessor } from './memory-consumer.js';
import { createMemoryIndexer } from './memory-index.js';

const runtime = await registeredObservability;
const observability = createWorkerObservability(runtime, { serviceVersion: '0.1.0' });
const { logger } = observability;
// Langfuse 只在 Worker 装配；processor 挂在共享 tracer provider 上，
// 因此 shutdown 时由 runtime.forceFlush/shutdown 统一覆盖 5s 上限，不单独等待。
const langfuse = createWorkerLangfuse({
  shutdownTimeoutMs: observability.config.shutdownTimeoutMs,
});

const config = loadWorkerConfig();
// MCP 配置文件不存在属于部署/配置错误，不会自愈——直接启动失败，避免"跑着一个没有工具的 worker"。
if (config.MCP_CONFIG_PATH && !existsSync(config.MCP_CONFIG_PATH)) {
  throw new Error(
    `MCP_CONFIG_PATH points to a missing file: ${config.MCP_CONFIG_PATH}. ` +
      'Set a repo-relative path (e.g. packages/ai-cli/mcp/mcp.json) or an absolute path that exists.',
  );
}

// 启动时预热 base MCP 共享连接，把公网握手成本移出首个对话；失败只告警不退出，
// 缓存条目会被清理，之后每轮对话自动重试，恢复后无需重启 worker。
if (config.MCP_CONFIG_PATH) {
  try {
    const shared = await getSharedMcpToolsForConfigPath(config.MCP_CONFIG_PATH);
    logger.info(
      { operation: 'worker.mcp.warmup', reason: 'ready', tools: shared.tools.length },
      `base MCP ready (${shared.status}): ${config.MCP_CONFIG_PATH}`,
    );
  } catch (error) {
    logger.error(
      { error: redactTelemetryValue(error), operation: 'worker.mcp.warmup', reason: 'failed' },
      `base MCP warmup failed: ${config.MCP_CONFIG_PATH}; runs will start without MCP tools and retry connecting each turn`,
    );
  }
} else {
  logger.warn(
    { operation: 'worker.mcp.warmup', reason: 'not-configured' },
    'MCP_CONFIG_PATH is not set; worker runs without base MCP tools',
  );
}

const database = createDatabase(config.DATABASE_URL);
await migrateDatabase(database.pool);

const checkpointer = PostgresSaver.fromConnString(config.DATABASE_URL, {
  schema: 'public',
});
await checkpointer.setup();
const memoryStore = PostgresStore.fromConnString(config.DATABASE_URL, {
  schema: 'public',
});
await memoryStore.setup();

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

const memoryIndexer = createMemoryIndexer({
  ...(config.MEMORY_QDRANT_URL ? { qdrantUrl: config.MEMORY_QDRANT_URL } : {}),
  ...(config.MEMORY_QDRANT_API_KEY ? { qdrantApiKey: config.MEMORY_QDRANT_API_KEY } : {}),
  ...(config.MEMORY_EMBEDDING_URL ? { embeddingUrl: config.MEMORY_EMBEDDING_URL } : {}),
  ...(config.MEMORY_EMBEDDING_API_KEY ? { embeddingApiKey: config.MEMORY_EMBEDDING_API_KEY } : {}),
  ...(config.MEMORY_EMBEDDING_MODEL ? { embeddingModel: config.MEMORY_EMBEDDING_MODEL } : {}),
  ...(config.MEMORY_EMBEDDING_DIM ? { embeddingDimension: config.MEMORY_EMBEDDING_DIM } : {}),
});

const memoryQueue = new Queue(MEMORY_QUEUE_NAME, { connection });
const memoryProcessorOptions = {
  repository: database.repository,
  models: config.models,
  ...(memoryIndexer ? { index: memoryIndexer } : {}),
  metrics: observability.metrics,
};
const memoryWorker = new Worker(MEMORY_QUEUE_NAME, createMemoryQueueProcessor(memoryProcessorOptions), {
  connection,
  concurrency: 1,
});
const memoryIndexWorker = new Worker(MEMORY_INDEX_QUEUE_NAME, async (job) => {
  if (!memoryIndexer) return;
  if (job.name === 'delete') return memoryIndexer.remove(String(job.data.memoryId));
  const memory = job.data.memory as Record<string, unknown>;
  return memoryIndexer.upsert({
    id: String(memory.id), tenantId: String(memory.tenantId), userId: String(memory.userId),
    content: String(memory.content), normalizedKey: String(memory.normalizedKey),
    kind: String(memory.kind), importance: Number(memory.importance), confidence: Number(memory.confidence),
    projectId: memory.projectId ? String(memory.projectId) : null, scope: String(memory.scope),
  });
}, { connection, concurrency: 1 });
const worker = new Worker(
  RUN_QUEUE_NAME,
  createRunProcessor(
    {
      config,
      repository: database.repository,
      memoryStore,
      memoryQueue,
      memoryMetrics: observability.metrics,
      ...(memoryIndexer?.search ? { memoryIndex: memoryIndexer } : {}),
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

// 孤儿聊天附件清理：选中即传但最终没点发送（或传到一半放弃）的附件
// 超过 24h 仍未关联 run 时，先删对象存储再删数据库行。每小时扫一批（100 个）。
const ORPHAN_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ORPHAN_ATTACHMENT_BATCH = 100;

async function cleanupOrphanAttachments(): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_ATTACHMENT_MAX_AGE_MS);
  const stale = await database.repository.listStaleUnlinkedAttachments(
    cutoff,
    ORPHAN_ATTACHMENT_BATCH,
  );
  for (const item of stale) {
    await artifacts.deleteObject(item.objectKey).catch(() => undefined);
    await database.repository.deleteChatAttachment(item.id).catch(() => undefined);
  }
  if (stale.length > 0) {
    logger.info(
      { count: stale.length, operation: 'worker.attachments.cleanup' },
      `removed ${stale.length} orphan chat attachments`,
    );
  }
}

const orphanCleanupTimer = setInterval(() => {
  cleanupOrphanAttachments().catch((error) =>
    logger.error(
      { error: redactTelemetryValue(error), operation: 'worker.attachments.cleanup' },
      'orphan attachment cleanup failed',
    ),
  );
}, ORPHAN_ATTACHMENT_CLEANUP_INTERVAL_MS);
orphanCleanupTimer.unref();
// 启动 1 分钟后先跑一次，避免长期没重启时上一批孤儿要多等一个周期。
const orphanCleanupKickoff = setTimeout(() => {
  cleanupOrphanAttachments().catch(() => undefined);
}, 60_000);
orphanCleanupKickoff.unref();

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
    await memoryWorker.close();
    await memoryIndexWorker.close();
    await memoryQueue.close();
    // 4. 关闭业务资源（含进程级共享的 base MCP client）。
    await closeSharedMcpClients();
    await cancellationSubscriber.quit();
    await publisher.quit();
    await connection.quit();
    await checkpointer.end();
    await memoryStore.stop();
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
