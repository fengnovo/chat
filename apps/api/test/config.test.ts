import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('production refuses development authentication', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'dev' }));
});

test('password mode requires a session secret of at least 32 chars', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'password' }));
  assert.throws(() =>
    loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'password', AUTH_JWT_SECRET: 'too-short' })
  );
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'password',
    AUTH_JWT_SECRET: 'a'.repeat(32),
  });
  assert.equal(config.AUTH_MODE, 'password');
  assert.equal(config.AUTH_JWT_SECRET, 'a'.repeat(32));
});

test('oidc mode requires issuer, audience and JWKS URL', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'oidc' }));
});

test('self signup defaults to the dev tenant and follows the environment gate', () => {
  const development = loadConfig({ NODE_ENV: 'development' });
  assert.equal(development.SIGNUP_ENABLED, true);
  assert.equal(development.SIGNUP_TENANT_ID, development.DEV_TENANT_ID);

  const production = loadConfig({
    NODE_ENV: 'production',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://issuer.example',
    OIDC_AUDIENCE: 'agent',
    OIDC_JWKS_URL: 'https://issuer.example/jwks',
  });
  assert.equal(production.SIGNUP_ENABLED, false);

  const forced = loadConfig({
    NODE_ENV: 'production',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://issuer.example',
    OIDC_AUDIENCE: 'agent',
    OIDC_JWKS_URL: 'https://issuer.example/jwks',
    AUTH_SIGNUP_ENABLED: 'true',
  });
  assert.equal(forced.SIGNUP_ENABLED, true);
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
