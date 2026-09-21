import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHttpServer } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT } from 'jose';
import { formatBoundedEvidence, boundedRetrievalMetadata } from '../src/mcp/server.js';
test('formatBoundedEvidence inlines image URLs into the LLM text and adds 配图 list for images not yet referenced', () => {
  const kbId = '00000000-0000-4000-8000-000000000001';
  const assetId = '00000000-0000-4000-8000-000000000002';
  const extraAssetId = '99999999-9999-4000-8000-000000000099';
  const result: any = {
    retrievalId: 'r',
    citations: [{
      chunkId: 'c',
      kbId,
      passage: '质地控制标准如下：![成品图](待整理/000.jpg)',
      documentName: 'MyKB/catalog.md',
      ordinal: 1,
      score: 1,
      via: 'vector',
      images: [
        { assetId, name: '000.jpg', mime: 'image/jpeg', alt: '成品图', relPath: 'MyKB/待整理/000.jpg' },
        { assetId: extraAssetId, name: '图2.jpg', mime: 'image/jpeg', alt: '', relPath: 'MyKB/待整理/图2.jpg' },
      ],
    }],
    relations: [],
    stats: { vectorHits: 1, graphHops: 0, searchedKbs: 1, durationMs: 1, truncated: false },
  };
  const text = formatBoundedEvidence(result);
  // 正文里的图：相对路径被换成可访问代理地址，模型直接照抄即可渲染。
  assert.ok(text.includes(`![成品图](/api/knowledge-bases/${kbId}/assets/${assetId}/content)`));
  assert.equal(text.includes('./000.jpg'), false);
  assert.equal(text.includes('待整理/000.jpg'), false);
  // 正文没引用的图走「配图」清单（用 asset 的 alt 或 name）
  assert.match(text, /配图：/);
  assert.ok(text.includes(`assets/${extraAssetId}/content`));
  // 已内联的图不会再列一次（避免模型输出重复图）
  const occurrences = text.split(`assets/${assetId}/content`).length - 1;
  assert.equal(occurrences, 1);
});

test('boundedRetrievalMetadata passes images through but caps to 20 per citation', () => {
  const images = Array.from({ length: 25 }, (_, i) => ({
    assetId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `${i}.jpg`,
    mime: 'image/jpeg',
    alt: '',
    relPath: `${i}.jpg`,
  }));
  const result: any = {
    retrievalId: 'r',
    citations: [{
      chunkId: 'c',
      kbId: '00000000-0000-4000-8000-000000000001',
      documentId: '00000000-0000-4000-8000-000000000002',
      documentName: 'doc',
      ordinal: 0,
      score: 1,
      via: 'vector',
      passage: 'x',
      images,
    }],
    relations: [],
    stats: { vectorHits: 1, graphHops: 0, searchedKbs: 1, durationMs: 1, truncated: false },
  };
  const metadata = boundedRetrievalMetadata(result, { includePassage: true }) as any;
  assert.equal(metadata.citations[0].images.length, 20);
  assert.ok('passage' in metadata.citations[0]);
});

test('formatBoundedEvidence leaves unknown image references unchanged', () => {
  const result: any = {
    retrievalId: 'r',
    citations: [{
      chunkId: 'c',
      kbId: '00000000-0000-4000-8000-000000000001',
      passage: '![别处的图](./unknown.png)',
      documentName: 'doc',
      ordinal: 0,
      score: 1,
      via: 'vector',
      images: [{
        assetId: '00000000-0000-4000-8000-000000000002',
        name: '000.jpg',
        mime: 'image/jpeg',
        alt: '',
        relPath: '000.jpg',
      }],
    }],
    relations: [],
    stats: { vectorHits: 1, graphHops: 0, searchedKbs: 1, durationMs: 1, truncated: false },
  };
  const text = formatBoundedEvidence(result);
  // 未知图片保持原 markdown 写法，不强行换成代理地址（否则会指向空文件）
  assert.ok(text.includes('![别处的图](./unknown.png)'));
});

test('MCP evidence is tagged and bounded, metadata omits passage', () => {
  const result: any = { retrievalId:'r', citations:[{ chunkId:'c', passage:'secret', documentName:'doc', score:1 }], relations:[], stats:{ vectorHits:1, graphHops:0, searchedKbs:1, durationMs:1, truncated:false } };
  const text = formatBoundedEvidence({ ...result, citations: Array.from({length: 100}, (_, i) => ({ ...result.citations[0], chunkId:`c${i}`, passage:'x'.repeat(10000) })) });
  assert.ok(text.includes('[S1]'));
  assert.ok(text.length <= 20_000);
  const metadata = boundedRetrievalMetadata(result) as any;
  assert.deepEqual(Object.keys(metadata).sort(), ['citations','relations','retrievalId','stats']);
  assert.equal('passage' in metadata.citations[0], false);
  const fullMetadata = boundedRetrievalMetadata(result, { includePassage: true }) as any;
  assert.equal(fullMetadata.citations[0].passage, 'secret');
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
