import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

export interface KnowledgeCitation {
  chunkId: string;
  documentId: string;
  documentName: string;
  ordinal: number;
  heading?: string;
  score: number;
  via: 'vector' | 'graph' | 'both' | string;
  passage: string;
}

export interface KnowledgeSearchResult {
  retrievalId: string;
  citations: KnowledgeCitation[];
  relations: Array<{ source: string; relation: string; target: string; chunkIds: string[] }>;
  stats?: Record<string, unknown>;
}

interface McpConfig {
  url: string;
  secret: string;
  timeoutMs: number;
}

interface McpTokenContext {
  tenantId: string;
  userId: string;
  kbIds: string[];
}

async function signRunToken(config: McpConfig, context: McpTokenContext): Promise<string> {
  return new SignJWT({
    tenantId: context.tenantId,
    userId: context.userId,
    sessionId: randomUUID(),
    runId: randomUUID(),
    kbIds: context.kbIds,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setJti(randomUUID())
    .setAudience('knowledge-service')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.secret));
}

/** MCP Streamable HTTP 响应可能是 SSE（data: 行）或纯 JSON，统一解出 JSON-RPC body。 */
function parseMcpResponse(text: string): any {
  const line = text.split(/\r?\n/).find((item) => item.startsWith('data:'));
  const payload = line ? line.slice(5).trim() : text.trim();
  return JSON.parse(payload);
}

async function mcpPost(
  config: McpConfig,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ payload: any; sessionId: string | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`knowledge-service HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return {
      payload: parseMcpResponse(text),
      sessionId: response.headers.get('mcp-session-id') ?? sessionId,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 通过 knowledge-service 的 graphrag_search 工具执行真实向量+图谱检索。 */
export async function searchKnowledge(
  config: McpConfig,
  context: McpTokenContext,
  input: { query: string; topK?: number | undefined },
): Promise<KnowledgeSearchResult> {
  const token = await signRunToken(config, context);
  const initialized = await mcpPost(config, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agent-api-knowledge-console', version: '1' },
    },
  });
  const sessionId = initialized.sessionId;
  const search = await mcpPost(
    config,
    token,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'graphrag_search',
        arguments: {
          query: input.query,
          includePassage: true,
          ...(input.topK ? { topK: input.topK } : {}),
        },
      },
    },
    sessionId,
  );
  if (search.payload?.error) {
    throw new Error(`knowledge-service rpc error: ${JSON.stringify(search.payload.error)}`);
  }
  const structured = search.payload?.result?.structuredContent ?? {};
  return {
    retrievalId: structured.retrievalId ?? randomUUID(),
    citations: Array.isArray(structured.citations) ? structured.citations : [],
    relations: Array.isArray(structured.relations) ? structured.relations : [],
    stats: structured.stats,
  };
}

export interface QaModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 用检索命中文本作为上下文调用 OpenAI 兼容 Chat Completions，返回带来源编号的回答。 */
export async function answerWithCitations(
  modelConfig: QaModelConfig,
  input: { question: string; citations: KnowledgeCitation[] },
): Promise<string> {
  const context = input.citations
    .map((citation, index) => `[${index + 1}] 来源：${citation.documentName}\n${citation.passage}`)
    .join('\n\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${modelConfig.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelConfig.model,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              '你是知识库问答助手。只能依据下面提供的参考资料回答问题，使用简体中文。' +
              '若资料不足以回答，请明确说明“根据当前知识库无法回答”。' +
              '回答中引用资料时用 [1]、[2] 这样的编号标注来源，不要编造资料之外的事实。',
          },
          {
            role: 'user',
            content: context
              ? `参考资料：\n${context}\n\n问题：${input.question}`
              : `问题：${input.question}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`chat completions HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() || '根据当前知识库无法回答。';
  } finally {
    clearTimeout(timer);
  }
}
