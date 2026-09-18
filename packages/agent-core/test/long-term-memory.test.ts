import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLongTermMemoryBackend } from '../src/index.js';

test('buildLongTermMemoryBackend mounts a persistent store under /memories', () => {
  const backend = buildLongTermMemoryBackend({
    defaultBackend: {} as never,
    store: {} as never,
    namespace: ['keen-ai', 'v1', 'tenant-a', 'user-a', 'chat', 'global'],
  });
  assert.deepEqual(backend.routePrefixes, ['/memories/']);
  assert.equal(typeof backend.execute, 'function');
});
