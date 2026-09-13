import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHttpServer } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT } from 'jose';
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

test('MCP Streamable HTTP initializes, lists and calls authorized tool without caller KB expansion', async () => {
  const secret = '01234567890123456789012345678901';
  const kb = '00000000-0000-4000-8000-000000000006';
  const token = await new SignJWT({ tenantId:'00000000-0000-4000-8000-000000000001', userId:'00000000-0000-4000-8000-000000000002', sessionId:'00000000-0000-4000-8000-000000000003', runId:'00000000-0000-4000-8000-000000000004', kbIds:[kb], jti:'00000000-0000-4000-8000-000000000005' }).setProtectedHeader({alg:'HS256'}).setAudience('knowledge-service').setExpirationTime('5m').sign(new TextEncoder().encode(secret));
  let received: any;
  const http = createMcpHttpServer({ tokenSecret: secret, retriever: { retrieve: async (input: any) => { received = input; return { retrievalId:'r', citations:[{ passage:'x'.repeat(10000), documentName:'doc' }], relations:[], stats:{ vectorHits:1, graphHops:0, searchedKbs:1, durationMs:1, truncated:false } }; } } });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const address = http.address() as any;
  const client = new Client({ name:'test-client', version:'1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization:`Bearer ${token}` } } });
  try {
    await client.connect(transport as any);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'graphrag_search'));
    const result: any = await client.callTool({ name:'graphrag_search', arguments:{ query:'hello', kbIds:['00000000-0000-4000-8000-000000000099'] } });
    assert.deepEqual(received.knowledgeBaseIds, [kb]);
    assert.ok(result.content[0].text.includes('[S1]'));
    assert.ok(result.content[0].text.length <= 20_000);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['citations','relations','retrievalId','stats']);
    assert.equal('passage' in result.structuredContent.citations[0], false);
  } finally { await client.close(); await new Promise<void>((resolve) => http.close(() => resolve())); }
});
