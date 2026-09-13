import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyRunToken } from '../run-token.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
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
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  const makeSession = async () => {
    const server = new McpServer({ name: 'knowledge-service', version: '0.1.0' });
    server.registerTool('graphrag_search', { description: 'Search authorized knowledge bases', inputSchema: { query: z.string().trim().min(1).max(10_000) } }, async ({ query }, extra) => {
      const headers: any = extra.requestInfo?.headers;
      const authorization = headers && typeof headers.get === 'function' ? headers.get('authorization') : headers?.authorization;
      const claims = await verifyRunToken(authorization, opts.tokenSecret);
      const result = await opts.retriever.retrieve({ tenantId: claims.tenantId, knowledgeBaseIds: claims.kbIds, query, userId: claims.userId, sessionId: claims.sessionId, runId: claims.runId });
      return { content: [{ type: 'text', text: formatBoundedEvidence(result) }], structuredContent: boundedRetrievalMetadata(result) };
    });
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id: string): void => { sessions.set(id, { server, transport }); } });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport as any);
    return { server, transport };
  };
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true})); return; }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if ((req.method === 'GET' || req.method === 'DELETE') && !existing) { res.writeHead(404); res.end(); return; }
      const current = existing ?? await makeSession();
      await current.transport.handleRequest(req, res, body);
    } catch (error) { opts.logger?.error?.(error); respond(res, { error:{ code:-32001, message:'request failed' } }, String(error).includes('401') ? 401 : 500); }
  });
}
function respond(res: ServerResponse, body: any, status = 200) { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); }
