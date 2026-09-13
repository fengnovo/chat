import { createDatabase, KnowledgeRepository, migrateDatabase } from '@repo/db';
import { buildEmbeddingProfile } from '@repo/knowledge-graphrag';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);

if (!config.KNOWLEDGE_EMBEDDING_PROFILE) {
  throw new Error('Knowledge embedding profile is required to create knowledge bases');
}
const embeddingProfile = buildEmbeddingProfile(config.KNOWLEDGE_EMBEDDING_PROFILE);

await migrateDatabase(database.pool);
const app = await buildApp({
  config,
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
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, 'API shutdown failed');
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
