import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryGraphStore } from '../src/index.js';

const extraction = (entities: string[], relations: Array<[string, string, string]>) => ({
  entities: entities.map((name) => ({ name })),
  relationships: relations.map(([source, type, target]) => ({ source, type, target })),
});

test('traverses demo-style three-hop relationships in both directions', () => {
  const graph = new InMemoryGraphStore();
  graph.addExtraction('d', 'c1', extraction(['Alice', 'Bob'], [['Alice', 'knows', 'Bob']]));
  graph.addExtraction('d', 'c2', extraction(['Bob', 'Carol'], [['Bob', 'knows', 'Carol']]));
  graph.addExtraction('d', 'c3', extraction(['Carol', 'Drew'], [['Carol', 'knows', 'Drew']]));
  const result = graph.traverse(['alice'], { maxHops: 3, maxFanout: 8, maxRelations: 8 });
  assert.deepEqual(result.relations.map((r) => r.type), ['knows', 'knows', 'knows']);
  assert.deepEqual(new Set(result.entityKeys), new Set(['alice', 'bob', 'carol', 'drew']));
});

test('merges duplicate relation sources and applies traversal bounds', () => {
  const graph = new InMemoryGraphStore();
  graph.addExtraction('d', 'c1', extraction(['A', 'B'], [['A', 'links', 'B']]));
  graph.addExtraction('d', 'c2', extraction(['A', 'B'], [['A', 'links', 'B']]));
  graph.addExtraction('d', 'c3', extraction(['A', 'C'], [['A', 'links', 'C']]));
  const result = graph.traverse(['a'], { maxHops: 1, maxFanout: 1, maxRelations: 1 });
  assert.equal(result.relations.length, 1);
  assert.deepEqual(result.relations[0]?.sourceChunkIds, ['c1', 'c2']);
});

test('applies hop, fan-out, and relation caps independently', () => {
  const graph = new InMemoryGraphStore();
  graph.addExtraction('d', 'c1', extraction(['A', 'B'], [['A', 'r', 'B']]));
  graph.addExtraction('d', 'c2', extraction(['B', 'C'], [['B', 'r', 'C']]));
  graph.addExtraction('d', 'c3', extraction(['A', 'D'], [['A', 'r', 'D']]));
  assert.equal(graph.traverse(['a'], { maxHops: 0, maxFanout: 10, maxRelations: 10 }).relations.length, 0);
  assert.equal(graph.traverse(['a'], { maxHops: 1, maxFanout: 1, maxRelations: 10 }).relations.length, 1);
  assert.equal(graph.traverse(['a'], { maxHops: 10, maxFanout: 10, maxRelations: 1 }).relations.length, 1);
});

test('rejects invalid graph limits', () => {
  const graph = new InMemoryGraphStore();
  for (const field of ['maxHops', 'maxFanout', 'maxRelations'] as const) {
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const limits = { maxHops: 1, maxFanout: 1, maxRelations: 1 };
      limits[field] = value;
      assert.throws(() => graph.traverse(['a'], limits), /limit/, `${field}=${value}`);
    }
  }
});
