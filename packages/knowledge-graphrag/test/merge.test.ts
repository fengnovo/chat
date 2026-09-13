import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates } from '../src/index.js';

test('deduplicates vector and graph evidence by chunk and retains selected relation provenance', () => {
  const result = mergeCandidates(
    [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }],
    { entityKeys: ['a', 'b'], relations: [{ id: 'r1', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c3'] }], chunkIds: ['c3', 'c4'] },
    { maxCandidates: 3 },
  );
  assert.deepEqual(result.map((x) => x.chunkId), ['c1', 'c2', 'c3']);
  assert.equal(result[2]?.via, 'graph');
  assert.deepEqual(result[2]?.sourceChunkIds, ['c3']);
  assert.ok(!result.some((x) => x.chunkId === 'c4'));
});

test('unions vector and selected graph relation provenance deterministically', () => {
  const result = mergeCandidates(
    [{ chunkId: 'c1', score: 0.9, sourceChunkIds: ['c1', 'v'] }],
    { entityKeys: [], relations: [{ id: 'r', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c1', 'g', 'v'] }], chunkIds: [] },
    { maxCandidates: 2 },
  );
  assert.equal(result[0]?.via, 'vector+graph');
  assert.deepEqual(result[0]?.sourceChunkIds, ['c1', 'v', 'g']);
});

test('rejects invalid candidate limits', () => {
  for (const value of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mergeCandidates([], { entityKeys: [], relations: [], chunkIds: [] }, { maxCandidates: value }), /limit/, `maxCandidates=${value}`);
  }
});
