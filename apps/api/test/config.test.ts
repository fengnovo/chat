import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('production refuses development authentication', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'dev' }));
});

test('development config has local infrastructure defaults', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.API_PORT, 8000);
  assert.equal(
    config.DATABASE_URL,
    'postgresql://agent:agent@127.0.0.1:55433/agent_test',
  );
});

test('API exposes only the non-sensitive embedding profile inputs', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    EMBEDDING_PROFILE: 'bailian-v4',
    EMBEDDING_MODEL: 'text-embedding-v4',
    EMBEDDING_DIM: '1024',
    QDRANT_COLLECTION_PREFIX: 'knowledge',
    EMBEDDING_API_KEY: 'knowledge-service-only',
  });

  assert.deepEqual(config.KNOWLEDGE_EMBEDDING_PROFILE, {
    key: 'bailian-v4',
    model: 'text-embedding-v4',
    dimension: 1024,
    collectionPrefix: 'knowledge',
  });
  assert.equal('EMBEDDING_API_KEY' in config, false);
});
