import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { QdrantClient } from '@qdrant/js-client-rest';
import { KnowledgeRepository } from '@repo/db';
import { QdrantChunkStore } from '@repo/knowledge-graphrag';
import { S3ArtifactStore } from '@repo/artifacts';
import { redactTelemetryValue } from '@repo/observability';
import { registeredObservability } from '@repo/observability/register';

import { loadConfig } from './config.js';
import { createKnowledgeRuntime } from './runtime.js';
import { startKnowledgeService } from './index.js';
import { startConsumer } from './consumer.js';
import { createKnowledgeObservability } from './observability.js';
import { createLlmGraphExtractor } from './extract.js';
import { createRetriever } from './retriever.js';

async function main(): Promise<void> {
  const observabilityRuntime = await registeredObservability;
  const obs = createKnowledgeObservability(observabilityRuntime, { serviceVersion: '0.1.0' });
  const { logger } = obs;
  const telemetry = { tracer: observabilityRuntime.tracer, metrics: obs.metrics, logger };

  const config = loadConfig();

  const pool = new Pool({ connectionString: config.postgresUrl, max: 8 });
  await pool.query('SELECT 1');
  logger.info({ operation: 'knowledge.startup' }, 'postgres connected');

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', (error) =>
    logger.error(
      { error: redactTelemetryValue(error), operation: 'knowledge.redis' },
      'redis error',
    ),
  );
  const queue = new Queue('knowledge-index', { connection: redis });

  const qdrant = new QdrantClient({ url: config.qdrantUrl });
  await qdrant.getCollections();
  const vectorStore = new QdrantChunkStore(qdrant as any, { prefix: config.qdrantCollectionPrefix });

  const artifacts = new S3ArtifactStore({
    endpoint: config.s3Endpoint,
    ...(config.s3PublicEndpoint ? { publicEndpoint: config.s3PublicEndpoint } : {}),
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKey: config.s3AccessKey,
    secretKey: config.s3SecretKey,
  });
  await artifacts.ensureBucket();

  const repository = new KnowledgeRepository(pool);
  const extract = createLlmGraphExtractor({
    model: config.extractionModel,
    baseUrl: config.extractionBaseUrl,
    apiKey: config.extractionApiKey,
    logger,
  });

  const runtime = createKnowledgeRuntime(config, {
    connection: redis,
    queue,
    repository,
    vectorStore,
    download: (objectKey: string) => artifacts.getObjectBytes(objectKey),
    extract,
    logger,
    leaseMs: config.leaseMs,
  });
  if (!runtime.embedder) throw new Error('embedder was not initialized');

  const worker = startConsumer('knowledge-index', redis, runtime, config.concurrency, telemetry);
  const retriever = createRetriever({ pool, embedder: runtime.embedder, vectorStore, repository, logger, tracer: observabilityRuntime.tracer });

  // /ready 探针：只暴露每类依赖的布尔状态，不输出连接串、错误细节等敏感信息。
  const readiness = async (): Promise<Record<string, boolean>> => {
    const checks: Record<string, Promise<boolean>> = {
      postgres: pool.query('SELECT 1').then(() => true).catch(() => false),
      redis: redis.ping().then(() => true).catch(() => false),
      qdrant: qdrant.getCollections().then(() => true).catch(() => false),
      s3: artifacts.ping().then(() => true).catch(() => false),
      consumer:
        typeof (worker as { isRunning?: () => boolean }).isRunning === 'function'
          ? Promise.resolve((worker as { isRunning(): boolean }).isRunning()).catch(() => false)
          : Promise.resolve(true),
    };
    const result = await Promise.all(
      Object.entries(checks).map(async ([name, probe]) => [name, await probe] as const),
    );
    return Object.fromEntries(result);
  };

  const service = await startKnowledgeService(config, { ...runtime, worker, retriever, logger, telemetry, readiness });
  logger.info(
    { operation: 'knowledge.startup', reason: 'ready' },
    `listening on :${config.port} (queue knowledge-index, extraction model ${config.extractionModel})`,
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ operation: 'knowledge.shutdown' }, `received ${signal}, shutting down`);
    // 先停业务面（HTTP、消费者、队列、Redis），再停 PG，最后 flush/关闭遥测。
    await service.close();
    await pool.end().catch(() => undefined);
    try {
      await observabilityRuntime.forceFlush(obs.config.shutdownTimeoutMs);
      await observabilityRuntime.shutdown(obs.config.shutdownTimeoutMs);
    } catch (error) {
      logger.error(
        { error: redactTelemetryValue(error), operation: 'knowledge.shutdown' },
        'observability shutdown failed',
      );
      await observabilityRuntime.shutdown(obs.config.shutdownTimeoutMs).catch(() => undefined);
      process.exit(1);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[knowledge-service] fatal:', error);
  process.exit(1);
});
