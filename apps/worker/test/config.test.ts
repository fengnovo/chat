import assert from 'node:assert/strict';
import test from 'node:test';

import { loadWorkerConfig } from '../src/config.js';

const requiredKeys = {
  OPENAI_API_KEY: 'test-model-key',
};

for (const NODE_ENV of ['development', 'test', 'production'] as const) {
  test(`${NODE_ENV} defaults to the local Docker sandbox backend`, () => {
    const config = loadWorkerConfig({ NODE_ENV, ...requiredKeys });
    assert.equal(config.AGENT_DRIVER, 'deep');
    assert.equal(config.SANDBOX_RUNTIME, 'docker');
    assert.equal(config.DOCKER_SANDBOX_IMAGE, 'chat-agent-sandbox:latest');
    assert.equal(config.DOCKER_SANDBOX_WORKSPACE_PATH, '/mnt/user-data/workspace');
    assert.equal(config.DOCKER_SANDBOX_COMMAND_TIMEOUT_MS, 180_000);
    assert.ok(config.DOCKER_SANDBOX_SESSIONS_ROOT.endsWith('/data/sandboxes'));
    assert.equal(config.E2B_TIMEOUT_MS, 3_600_000);
    assert.equal(config.E2B_API_URL, undefined);
    assert.equal(config.E2B_SANDBOX_URL, undefined);
  });
}

test('docker sandbox sessions root is resolved to an absolute path', () => {
  const config = loadWorkerConfig({
    ...requiredKeys,
    DOCKER_SANDBOX_SESSIONS_ROOT: './relative-sandboxes',
  });
  assert.ok(config.DOCKER_SANDBOX_SESSIONS_ROOT.startsWith('/'));
});

test('e2b-cloud runtime requires an E2B API key', () => {
  assert.throws(
    () => loadWorkerConfig({ ...requiredKeys, SANDBOX_RUNTIME: 'e2b-cloud' }),
    /E2B_API_KEY/,
  );
  const config = loadWorkerConfig({
    ...requiredKeys,
    SANDBOX_RUNTIME: 'e2b-cloud',
    E2B_API_KEY: 'test-e2b-key',
    E2B_API_URL: 'http://sandbox.internal:10087',
    E2B_SANDBOX_URL: 'http://sandbox.internal:10087',
  });
  assert.equal(config.SANDBOX_RUNTIME, 'e2b-cloud');
  assert.equal(config.E2B_API_URL, 'http://sandbox.internal:10087');
  assert.equal(config.E2B_SANDBOX_URL, 'http://sandbox.internal:10087');
});

test('demo agent configuration is rejected', () => {
  assert.throws(() => loadWorkerConfig({
    ...requiredKeys,
    AGENT_DRIVER: 'demo',
  }));
});
