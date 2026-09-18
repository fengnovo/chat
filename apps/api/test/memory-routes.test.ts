import assert from 'node:assert/strict';
import test from 'node:test';

import { isSensitiveMemory } from '@repo/memory-core';
import { memoryUpdateInputSchema } from '../src/routes.js';

test('memory route update schema trims and bounds content', () => {
  assert.equal(memoryUpdateInputSchema.parse({ content: '  prefers concise answers  ' }).content, 'prefers concise answers');
  assert.throws(() => memoryUpdateInputSchema.parse({ content: '' }));
  assert.throws(() => memoryUpdateInputSchema.parse({ content: 'x'.repeat(2_001) }));
});

test('memory route rejects credential-shaped content before persistence', () => {
  assert.equal(isSensitiveMemory('api_key=sk-test-123456789012'), true);
});
