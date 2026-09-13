import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

const required = {
  DATABASE_URL: 'postgresql://agent:agent@127.0.0.1:5432/agent',
  KNOWLEDGE_TOKEN_SECRET: '0123456789abcdef',
  QDRANT_URL: 'http://127.0.0.1:6333',
  EMBEDDING_PROFILE: 'bailian-v4',
  EMBEDDING_DIM: '1024',
  EMBEDDING_MODEL: 'text-embedding-v4',
  EXTRACTION_MODEL: 'openai:gpt-4o-mini',
} satisfies NodeJS.ProcessEnv;

test('Bailian embeddings remain isolated from the OpenAI main model credentials', () => {
  const config = loadConfig({
    ...required,
    MODEL: 'openai:gpt-4o-mini',
    OPENAI_API_KEY: 'main-model-key',
    OPENAI_BASE_URL: 'https://api.openai.example/v1',
    EMBEDDING_PROVIDER: 'bailian',
    EMBEDDING_API_KEY: 'embedding-only-key',
  });

  assert.equal(config.embeddingProvider, 'bailian');
  assert.equal(config.embeddingApiKey, 'embedding-only-key');
  assert.equal(config.embeddingBaseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(config.embeddingModel, 'text-embedding-v4');
  assert.equal(config.embeddingDimension, 1024);
  assert.equal(config.embeddingProfile, 'bailian-v4');
});

test('OpenAI-compatible embeddings require an explicit base URL', () => {
  assert.throws(
    () => loadConfig({
      ...required,
      EMBEDDING_PROVIDER: 'openai-compatible',
      OPENAI_API_KEY: 'must-not-be-reused',
      EMBEDDING_API_KEY: 'embedding-key',
    }),
    /EMBEDDING_BASE_URL/,
  );
});

test('known embedding providers reject missing embedding credentials', () => {
  assert.throws(
    () => loadConfig({ ...required, EMBEDDING_PROVIDER: 'openai' }),
    /EMBEDDING_API_KEY/,
  );
});

test('embedding dimensions must be positive integers', () => {
  assert.throws(
    () => loadConfig({ ...required, EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'key', EMBEDDING_DIM: '0' }),
    /EMBEDDING_DIM/,
  );
});

test('unsupported embedding providers are rejected', () => {
  assert.throws(
    () => loadConfig({ ...required, EMBEDDING_PROVIDER: 'unsupported', EMBEDDING_API_KEY: 'key' }),
    /EMBEDDING_PROVIDER/,
  );
});
