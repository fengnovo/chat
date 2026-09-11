import assert from 'node:assert/strict';
import test from 'node:test';

import { RepositoryNotFoundError } from '../src/index.js';

test('repository not-found errors carry a stable resource code', () => {
  const error = new RepositoryNotFoundError('run');
  assert.equal(error.resource, 'run');
  assert.equal(error.message, 'run not found');
});
