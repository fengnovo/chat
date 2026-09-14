import { createDatabase, KnowledgeRepository, migrateDatabase } from '@repo/db';
import { buildEmbeddingProfile } from '@repo/knowledge-graphrag';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadObservabilityConfig, redactTelemetryValue } from '@repo/observability';
import { registeredObservability } from '@repo/observability/register';
import { createApiObservability } from './observability.js';

const config = loadConfig();
const telemetryConfig = loadObservabilityConfig(process.env, {
  serviceName: 'agent-api', serviceVersion: config.API_VERSION,
});
const runtime = await registeredObservability;
const observability = createApiObservability(runtime, {
  enabled: telemetryConfig.enabled,
  serviceVersion: telemetryConfig.serviceVersion,
  exporter: telemetryConfig.enabled ? 'configured' : 'disabled',
});
const database = createDatabase(config.DATABASE_URL);

if (!config.KNOWLEDGE_EMBEDDING_PROFILE) {
  throw new Error('Knowledge embedding profile is required to create knowledge bases');
}
const embeddingProfile = buildEmbeddingProfile(config.KNOWLEDGE_EMBEDDING_PROFILE);

await migrateDatabase(database.pool);
const app = await buildApp({
  config,
  observability,
  repository: database.repository,
  knowledgeRepository: new KnowledgeRepository(database.pool, { embeddingProfile }),
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
    await database.repository.close();
    await runtime.shutdown();
    process.exit(0);
  } catch (error) {
    await runtime.shutdown();
    app.log.error({ error: redactTelemetryValue(error) }, 'API shutdown failed');
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
