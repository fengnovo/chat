import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryIndexer } from '../src/memory-index.js';

test('memory indexer stays disabled unless complete embedding config is present', () => {
  assert.equal(createMemoryIndexer({}), undefined);
});
