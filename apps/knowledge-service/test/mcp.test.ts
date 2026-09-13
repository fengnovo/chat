import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBoundedEvidence, boundedRetrievalMetadata } from '../src/mcp/server.js';
test('MCP evidence is tagged and bounded, metadata omits passage', () => {
  const result: any = { retrievalId:'r', citations:[{ chunkId:'c', passage:'secret', documentName:'doc', score:1 }], relations:[], stats:{ vectorHits:1, graphHops:0, searchedKbs:1, durationMs:1, truncated:false } };
  const text = formatBoundedEvidence({ ...result, citations: Array.from({length: 100}, (_, i) => ({ ...result.citations[0], chunkId:`c${i}`, passage:'x'.repeat(10000) })) });
  assert.ok(text.includes('[S1]'));
  assert.ok(text.length <= 20_000);
  const metadata = boundedRetrievalMetadata(result) as any;
  assert.deepEqual(Object.keys(metadata).sort(), ['citations','relations','retrievalId','stats']);
  assert.equal('passage' in metadata.citations[0], false);
});
