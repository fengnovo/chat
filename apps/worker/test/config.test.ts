import assert from 'node:assert/strict';
import test from 'node:test';

import { loadWorkerConfig } from '../src/config.js';

const requiredKeys = {
  E2B_API_KEY: 'test-e2b-key',
  OPENAI_API_KEY: 'test-model-key',
};

for (const NODE_ENV of ['development', 'test', 'production'] as const) {
  test(`${NODE_ENV} defaults to the E2B backend`, () => {
    const config = loadWorkerConfig({ NODE_ENV, ...requiredKeys });
    assert.equal(config.AGENT_DRIVER, 'deep');
    assert.equal(config.CODE_AGENT_BACKEND, 'e2b');
    assert.equal(config.E2B_WORKSPACE_PATH, '/home/user/workspace');
    assert.equal(config.E2B_TIMEOUT_MS, 3_600_000);
  });
}

test('non-E2B backend configuration is rejected', () => {
  assert.throws(() => loadWorkerConfig({
    ...requiredKeys,
    CODE_AGENT_BACKEND: 'local',
  }));
});

test('demo agent configuration is rejected', () => {
  assert.throws(() => loadWorkerConfig({
    ...requiredKeys,
    AGENT_DRIVER: 'demo',
  }));
});

test('E2B credentials are always required', () => {
  assert.throws(
    () => loadWorkerConfig({ OPENAI_API_KEY: 'test-model-key' }),
    /E2B_API_KEY/,
  );
});
