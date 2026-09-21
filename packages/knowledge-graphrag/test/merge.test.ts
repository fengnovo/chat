import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates, DEFAULT_RRF_K } from '../src/index.js';

test('deduplicates vector and graph evidence by chunk and retains selected relation provenance', () => {
  const result = mergeCandidates(
    [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }],
    {
      entityKeys: ['a', 'b'],
      relations: [{ id: 'r1', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c3'], hop: 1 }],
      chunkIds: ['c3', 'c4'],
    },
    { maxCandidates: 3 },
  );
  // RRF 排序下，c3 (graph, rank=0) 的得分 1/61 会高于 c2 (vector, rank=1) 的 1/62，
  // 因此新顺序是 c1 (vector rank=0) > c3 (graph rank=0) > c2 (vector rank=1)。
  // c1/c2 都只被向量命中（关系里只提到 c3），所以 via 仍为 'vector'；c3 是 'graph'。
  assert.deepEqual(result.map((x) => x.chunkId), ['c1', 'c3', 'c2']);
  assert.equal(result[0]?.via, 'vector');
  assert.equal(result[1]?.via, 'graph');
  assert.equal(result[2]?.via, 'vector');
  assert.deepEqual(result[1]?.sourceChunkIds, ['c3']);
  assert.ok(!result.some((x) => x.chunkId === 'c4'));
  // RRF 分数应当落在合理区间，便于后续做相关性阈值。
  const k = DEFAULT_RRF_K;
  const c1Score = 1 / (k + 0 + 1); // vector rank 0 only
  const c2Score = 1 / (k + 1 + 1); // vector rank 1 only
  const c3Score = 1 / (k + 0 + 1); // graph rank 0 only
  assert.ok(Math.abs(result[0]!.score - c1Score) < 1e-9);
  assert.ok(Math.abs(result[1]!.score - c3Score) < 1e-9);
  assert.ok(Math.abs(result[2]!.score - c2Score) < 1e-9);
});

test('unions vector and selected graph relation provenance deterministically', () => {
  const result = mergeCandidates(
    [{ chunkId: 'c1', score: 0.9, sourceChunkIds: ['c1', 'v'] }],
    {
      entityKeys: [],
      relations: [{ id: 'r', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c1', 'g', 'v'], hop: 1 }],
      chunkIds: [],
    },
    { maxCandidates: 2 },
  );
  assert.equal(result[0]?.via, 'vector+graph');
  assert.deepEqual(result[0]?.sourceChunkIds, ['c1', 'v', 'g']);
});

test('ranks graph-only chunks above low-ranked vector chunks when their hop is smaller', () => {
  // c1 vector rank 5 (远低于 c3 的图谱 rank 0) → RRF 让图谱命中的 c3 排到 c1 之前。
  const vectorHits = Array.from({ length: 10 }, (_, idx) => ({
    chunkId: idx === 0 ? 'c0' : idx === 4 ? 'c1' : `v${idx}`,
    score: 1 - idx * 0.01,
  }));
  const result = mergeCandidates(
    vectorHits,
    {
      entityKeys: ['seed'],
      relations: [{ id: 'rg', source: 'seed', target: 'other', type: 'related', sourceChunkIds: ['c3'], hop: 1 }],
      chunkIds: ['c3'],
    },
    { maxCandidates: 10 },
  );
  const c1Idx = result.findIndex((x) => x.chunkId === 'c1');
  const c3Idx = result.findIndex((x) => x.chunkId === 'c3');
  assert.ok(c1Idx >= 0 && c3Idx >= 0);
  assert.ok(c3Idx < c1Idx, `expected c3 (graph, hop=1, rank0) < c1 (vector, rank5), got c1Idx=${c1Idx}, c3Idx=${c3Idx}`);
});

test('orders relations within the same hop by appearance order', () => {
  const result = mergeCandidates(
    [],
    {
      entityKeys: [],
      relations: [
        { id: 'r1', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c1'], hop: 1 },
        { id: 'r2', source: 'a', target: 'c', type: 'uses', sourceChunkIds: ['c2'], hop: 1 },
        { id: 'r3', source: 'a', target: 'd', type: 'uses', sourceChunkIds: ['c3'], hop: 2 },
      ],
      chunkIds: [],
    },
    { maxCandidates: 10 },
  );
  assert.deepEqual(result.map((x) => x.chunkId), ['c1', 'c2', 'c3']);
  // 跳数越小的关系 rank 越小 → 分数越高。
  assert.ok(result[0]!.score > result[1]!.score);
  assert.ok(result[1]!.score > result[2]!.score);
});

test('respects custom rrfK', () => {
  const withDefault = mergeCandidates(
    [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }],
    {
      entityKeys: [],
      relations: [{ id: 'r', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c3'], hop: 1 }],
      chunkIds: [],
    },
    { maxCandidates: 3 },
  );
  const withSmallerK = mergeCandidates(
    [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }],
    {
      entityKeys: [],
      relations: [{ id: 'r', source: 'a', target: 'b', type: 'uses', sourceChunkIds: ['c3'], hop: 1 }],
      chunkIds: [],
    },
    { maxCandidates: 3, rrfK: 1 },
  );
  assert.notEqual(withDefault[0]!.score, withSmallerK[0]!.score);
});

test('rejects invalid candidate limits', () => {
  for (const value of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mergeCandidates([], { entityKeys: [], relations: [], chunkIds: [] }, { maxCandidates: value }), /limit/, `maxCandidates=${value}`);
  }
});