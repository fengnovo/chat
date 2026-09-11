import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AgentRepository } from './repository.js';
import * as schema from './schema.js';

export type AgentDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  pool: Pool;
  db: AgentDatabase;
  repository: AgentRepository;
}

export function createDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString, max: 20 });
  return {
    pool,
    db: drizzle(pool, { schema }),
    repository: new AgentRepository(pool),
  };
}

export async function migrateDatabase(pool: Pool): Promise<void> {
  const candidates = [
    fileURLToPath(new URL('../migrations', import.meta.url)),
    path.resolve(process.cwd(), 'packages/db/migrations'),
    path.resolve(process.cwd(), '../../packages/db/migrations'),
  ];
  let migrationDirectory: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      migrationDirectory = candidate;
      break;
    } catch {
      // Try the next layout (source, repository root, or workspace package cwd).
    }
  }
  if (!migrationDirectory) throw new Error('Database migration directory was not found.');

  const client = await pool.connect();
  const migrationLock = 'node-agent-platform:migrations';
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [migrationLock]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1',
        [file],
      );
      if (applied.rowCount) continue;
      const migration = await readFile(path.join(migrationDirectory, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLock]);
    client.release();
  }
}

export * from './repository.js';
export * from './schema.js';
