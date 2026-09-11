import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactObjectKey } from '../src/index.js';

test('artifact keys stay under the tenant and run prefix', () => {
  const key = artifactObjectKey('tenant', 'run', 'artifact', '../../secret log.txt');
  assert.equal(key, 'tenants/tenant/runs/run/artifact/secret-log.txt');
  assert.equal(key.includes('..'), false);
});
