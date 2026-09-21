import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

/** 命中切片关联的知识库资源（图）。assetId 用于换取 api 侧的代理访问地址。 */
export interface KnowledgeCitationImage {
  assetId: string;
  name: string;
  mime: string;
  alt: string;
  relPath: string;
}

export interface KnowledgeCitation {
  chunkId: string;
  documentId: string;
  documentName: string;
  ordinal: number;
  heading?: string;
  score: number;
  via: 'vector' | 'graph' | 'both' | string;
  passage: string;
  images?: KnowledgeCitationImage[];
}

/**
 * 知识库资源（图）在 api 侧的代理访问地址。必须与 web 端 `getKnowledgeAssetContentUrl`
 * 保持一致：走相对路径，浏览器会自动带上同源 Cookie 完成鉴权。
 */
export function knowledgeAssetContentUrl(kbId: string, assetId: string): string {
  return `/api/knowledge-bases/${kbId}/assets/${assetId}/content`;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/**
 * 追加到各问答提示词的图片输出规则。上下文里的图片地址是 api 代理地址，模型必须原样
 * 照抄才能被前端渲染；同时禁止退化成 `./000.jpg` 这类既看不到又点不动的纯文本路径。
 */
export const IMAGE_ANSWER_RULE =
  '参考资料中若出现 markdown 图片（形如 ![说明](/api/knowledge-bases/.../assets/.../content)）或「配图」清单，说明该资料确实附有图片。' +
  '请把这些图片 markdown 原样写进回答里，地址必须一字不差地照抄（不要加反引号、不要转义、不要删减路径），让用户能直接看到图片。' +
  '禁止用 `./000.jpg`、`01.jpeg` 这类相对路径或纯文件名代替图片，也不要声称自己无法发送或展示图片。';

/**
 * 把 passage 里的 markdown 图片（如 `![成品图](./000.jpg)`）替换成可访问的代理地址。
 * 不改写的话模型只会看到 `./000.jpg` 这种文件系统相对路径，于是复述成纯文本，
 * 用户既看不到图也点不动。
 */
export function inlineCitationImageUrls(
  passage: string,
  images: KnowledgeCitationImage[] | undefined,
  kbId: string,
): string {
  if (!passage || !images?.length) return passage;
  const byName = new Map<string, string>();
  for (const image of images) {
    const base = image.relPath.split('/').pop();
    if (base) byName.set(base.toLowerCase(), knowledgeAssetContentUrl(kbId, image.assetId));
  }
  if (byName.size === 0) return passage;
  return passage.replace(MARKDOWN_IMAGE_RE, (match, alt: string, src: string) => {
    const base = src.split('/').pop()?.toLowerCase() ?? '';
    const url = byName.get(base);
    if (!url) return match;
    return `![${alt || '配图'}](${url})`;
  });
}

/**
 * 把命中切片拼成模型上下文。除正文外，为带图切片补一条 markdown 图片清单，
 * 让模型知道「这条资料附带哪些图、图片地址是什么」，从而直接输出可渲染的图片。
 */
export function buildCitationContext(citations: KnowledgeCitation[], kbId: string): string {
  return citations
    .map((citation, index) => {
      const header = `[${index + 1}] 来源：${citation.documentName}${citation.heading ? ` / ${citation.heading}` : ''}`;
      const passage = inlineCitationImageUrls(citation.passage, citation.images, kbId);
      // 正文里已内联过的图不再重复列出，避免模型把同一张图输出两遍。
      const remaining = (citation.images ?? []).filter(
        (image) => !passage.includes(knowledgeAssetContentUrl(kbId, image.assetId)),
      );
      const imageList = remaining.length
        ? `\n配图：${remaining
            .map((image) => `![${image.alt || image.name}](${knowledgeAssetContentUrl(kbId, image.assetId)})`)
            .join(' ')}`
        : '';
      return `${header}${imageList}\n${passage}`;
    })
    .join('\n\n');
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
  input: { question: string; citations: KnowledgeCitation[]; kbId?: string },
): Promise<string> {
  const context = input.kbId
    ? buildCitationContext(input.citations, input.kbId)
    : input.citations
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
              '回答中引用资料时用 [1]、[2] 这样的编号标注来源，不要编造资料之外的事实。' +
              IMAGE_ANSWER_RULE,
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
