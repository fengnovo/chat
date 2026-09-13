import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

const enabled = process.env.RUN_KNOWLEDGE_E2E === '1';
const apiBase = process.env.KNOWLEDGE_E2E_API_URL ?? 'http://127.0.0.1:8002';
const mcpUrl = process.env.KNOWLEDGE_E2E_MCP_URL ?? 'http://127.0.0.1:8090/mcp';
const qdrantUrl = process.env.QDRANT_URL ?? 'http://127.0.0.1:56333';
const tenantId = process.env.DEV_TENANT_ID ?? '00000000-0000-4000-8000-000000000001';
const userId = process.env.DEV_USER_ID ?? tenantId;
const tokenSecret = process.env.GRAPHRAG_TOKEN_SECRET ?? process.env.KNOWLEDGE_TOKEN_SECRET ?? 'local-graphrag-secret-change-me';

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  assert.ok(response.ok, `${init?.method ?? 'GET'} ${url} returned ${response.status}: ${text}`);
  return body;
}

async function runToken(kbId: string) {
  return new SignJWT({ tenantId, userId, sessionId: randomUUID(), runId: randomUUID(), kbIds: [kbId], jti: randomUUID() })
    .setProtectedHeader({ alg: 'HS256' }).setAudience('knowledge-service').setExpirationTime('10m')
    .sign(new TextEncoder().encode(tokenSecret));
}

async function mcpCall(token: string, body: unknown, sessionId?: string) {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `MCP returned ${response.status}: ${text}`);
  const data = text.match(/^data:\s*(.+)$/m)?.[1] ?? text;
  return { body: JSON.parse(data), sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

test('knowledge smoke indexes Markdown, searches citations, and rebuilds vectors without losing graph', { skip: !enabled && 'set RUN_KNOWLEDGE_E2E=1 to run against local services' }, async (t) => {
  const markdown = '# GraphRAG smoke\n\nAlice works with Acme. Acme owns the Knowledge Graph.\n';
  const bytes = Buffer.from(markdown);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const kb = await request(`${apiBase}/api/knowledge-bases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `e2e-${Date.now()}`, description: 'smoke', visibility: 'private' }) });
  const kbId = kb.id ?? kb.data?.id;
  assert.match(kbId, /^[0-9a-f-]{36}$/i);
  t.after(async () => { await fetch(`${apiBase}/api/knowledge-bases/${kbId}`, { method: 'DELETE' }).catch(() => undefined); });

  const upload = await request(`${apiBase}/api/knowledge-bases/${kbId}/documents/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'smoke.md', mime: 'text/markdown', sizeBytes: bytes.byteLength, sha256 }) });
  const documentId = upload.document.id;
  await request(upload.upload.uploadUrl, { method: 'PUT', headers: upload.upload.headers, body: bytes });
  const confirmed = await request(`${apiBase}/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sizeBytes: bytes.byteLength, sha256 }) });
  assert.equal(confirmed.id, documentId);

  let document: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    document = await request(`${apiBase}/api/knowledge-bases/${kbId}/documents/${documentId}`);
    if (document.status === 'ready' || document.status === 'failed') break;
    await delay(1_000);
  }
  assert.equal(document.status, 'ready', `indexing did not become ready: ${document.status}`);

  const token = await runToken(kbId);
  const initialized = await mcpCall(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-smoke', version: '1' } } });
  const search = await mcpCall(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'graphrag_search', arguments: { query: 'Who works with Acme?' } } }, initialized.sessionId);
  const result = search.body.result ?? search.body;
  assert.ok(result.structuredContent?.citations?.length, 'search returned no citations');
  const relationsBefore = result.structuredContent?.relations ?? [];

  const collection = process.env.QDRANT_COLLECTION_PREFIX ? `${process.env.QDRANT_COLLECTION_PREFIX}${kbId}` : kbId;
  await request(`${qdrantUrl}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }, { key: 'kb_id', match: { value: kbId } }] } }) });
  const rebuild = await request(`${apiBase}/api/knowledge-bases/${kbId}/documents/${documentId}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sizeBytes: bytes.byteLength, sha256 }) });
  assert.equal(rebuild.id, documentId, 'confirm should enqueue a real re-embedding job after vector deletion');
  for (let attempt = 0; attempt < 30; attempt++) {
    document = await request(`${apiBase}/api/knowledge-bases/${kbId}/documents/${documentId}`);
    if (document.status === 'ready' || document.status === 'failed') break;
    await delay(1_000);
  }
  assert.equal(document.status, 'ready', `re-embedding did not become ready: ${document.status}`);
  const rebuilt = await mcpCall(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graphrag_search', arguments: { query: 'Who works with Acme?' } } }, initialized.sessionId);
  const rebuiltResult = rebuilt.body.result ?? rebuilt.body;
  assert.ok(rebuiltResult.structuredContent?.citations?.length, 'rebuild search returned no citations');
  assert.deepEqual(rebuiltResult.structuredContent?.relations ?? [], relationsBefore, 'graph relations changed after Qdrant rebuild');
});
