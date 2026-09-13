import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyRunToken } from '../run-token.js';
export const MAX_CONTENT_CHARS = 20_000;
export const MAX_EVIDENCE_CHARS = 2_000;
export function formatBoundedEvidence(result: any): string {
  const citations = Array.isArray(result?.citations) ? result.citations : [];
  let out = citations.map((c: any, i: number) => `[S${i + 1}] ${String(c.passage ?? c.text ?? c.documentName ?? '').slice(0, MAX_EVIDENCE_CHARS)}`).join('\n');
  if (out.length > MAX_CONTENT_CHARS) out = out.slice(0, MAX_CONTENT_CHARS);
  return out;
}
export function boundedRetrievalMetadata(result: any): any {
  const strip = (x: any) => { const y = { ...x }; delete y.passage; delete y.text; return y; };
  return { retrievalId: result.retrievalId, citations: (result.citations ?? []).slice(0, 20).map(strip), relations: (result.relations ?? []).slice(0, 20).map(strip), stats: result.stats };
}
export function createMcpHttpServer(opts: { tokenSecret: string; retriever: any; logger?: any }) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true})); return; }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.method === 'tools/list') return respond(res, { tools: [{ name:'graphrag_search', inputSchema:{ type:'object', properties:{query:{type:'string'}}, required:['query'], additionalProperties:false } }] });
      if (body.method === 'tools/call' && body.params?.name === 'graphrag_search') {
        const query = String(body.params.arguments?.query ?? '').trim(); if (!query || query.length > 10_000) return respond(res, { error:{ code:-32602, message:'invalid query' } }, 400);
        const claims = await verifyRunToken(req.headers.authorization, opts.tokenSecret);
        const result = await opts.retriever.retrieve({ tenantId: claims.tenantId, knowledgeBaseIds: claims.kbIds, query });
        return respond(res, { content:[{type:'text', text:formatBoundedEvidence(result)}], structuredContent:boundedRetrievalMetadata(result) });
      }
      respond(res, { result:{} });
    } catch (error) { opts.logger?.error?.(error); respond(res, { error:{ code:-32001, message:'request failed' } }, String(error).includes('401') ? 401 : 500); }
  });
}
function respond(res: ServerResponse, body: any, status = 200) { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); }
