import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextDocument, splitIntoChunks, stableChunkId } from '../src/index.js';

test('splits with bounded overlap and carries heading path', () => {
  const doc = parseTextDocument(new TextEncoder().encode('# A\nabcdefghij'), 'text/markdown');
  const chunks = splitIntoChunks(doc, { size: 8, overlap: 2 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 8));
  assert.deepEqual(chunks[0]?.headingPath, ['A']);
  assert.equal(chunks[1]?.text.slice(0, 2), chunks[0]?.text.slice(-2));
});

test('stable chunk ids are UUID-shaped and deterministic', () => {
  const a = stableChunkId('doc', 0, 'hello');
  assert.equal(a, stableChunkId('doc', 0, 'hello'));
  assert.notEqual(a, stableChunkId('doc', 1, 'hello'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('does not fabricate heading paths when a chunk starts inside a long heading line', () => {
  const doc = parseTextDocument(new TextEncoder().encode('# A heading that is longer than one chunk\nbody'), 'text/markdown');
  const chunks = splitIntoChunks(doc, { size: 8, overlap: 2 });
  assert.ok(chunks.every((chunk) => chunk.headingPath.length === 0 || chunk.headingPath[0] === 'A heading that is longer than one chunk'));
});
