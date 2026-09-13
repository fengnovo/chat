import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { QdrantClient } from '@qdrant/js-client-rest';
import { KnowledgeRepository } from '@repo/db';
import { QdrantChunkStore } from '@repo/knowledge-graphrag';
import { S3ArtifactStore } from '@repo/artifacts';

import { loadConfig } from './config.js';
import { createKnowledgeRuntime } from './runtime.js';
import { startKnowledgeService } from './index.js';
import { startConsumer } from './consumer.js';
import { createLlmGraphExtractor } from './extract.js';
import { createRetriever } from './retriever.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = {
    info: (message: string) => console.log(`[knowledge-service] ${message}`),
    warn: (message: string) => console.warn(`[knowledge-service] ${message}`),
    error: (error: unknown) => console.error('[knowledge-service]', error),
  };

  const pool = new Pool({ connectionString: config.postgresUrl, max: 8 });
  await pool.query('SELECT 1');
  logger.info('postgres connected');

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', (error) => logger.error(error));
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

  const worker = startConsumer('knowledge-index', redis, runtime, config.concurrency);
  const retriever = createRetriever({ pool, embedder: runtime.embedder, vectorStore, repository, logger });

  const service = await startKnowledgeService(config, { ...runtime, worker, retriever, logger });
  logger.info(`listening on :${config.port} (queue knowledge-index, extraction model ${config.extractionModel})`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info(`received ${signal}, shutting down`);
    await service.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[knowledge-service] fatal:', error);
  process.exit(1);
});
