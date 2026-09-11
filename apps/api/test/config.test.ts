import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('production refuses development authentication', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'dev' }));
});

test('development config has local infrastructure defaults', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.API_PORT, 8000);
  assert.match(config.DATABASE_URL, /postgresql:/);
});
