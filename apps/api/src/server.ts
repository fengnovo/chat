import { createDatabase, migrateDatabase } from '@repo/db';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);

await migrateDatabase(database.pool);
const app = await buildApp({ config, repository: database.repository });

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
