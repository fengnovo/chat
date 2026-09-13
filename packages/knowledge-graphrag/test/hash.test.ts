import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, assertDocumentBytes } from '../src/indexer/hash.js';

test('computes real SHA-256 and rejects mismatched bytes before embedding', () => {
  const bytes = new TextEncoder().encode('# Hello');
  const hash = sha256Hex(bytes);
  assert.equal(hash, '01c8de44e04d2f7a304f50963545a2aff58c33e9c44a1f33fdcb978fb224cb74');
  assert.doesNotThrow(() => assertDocumentBytes(bytes, hash, bytes.length, 'text/markdown'));
  assert.throws(() => assertDocumentBytes(bytes, '0'.repeat(64), bytes.length, 'text/markdown'), /hash/i);
});
