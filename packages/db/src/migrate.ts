import { createDatabase, migrateDatabase } from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://agent:agent@127.0.0.1:55432/agent';
const database = createDatabase(databaseUrl);

try {
  await migrateDatabase(database.pool);
  console.log('Database migration completed.');
} finally {
  await database.repository.close();
}
