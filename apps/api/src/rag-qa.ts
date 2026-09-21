import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';

import { z } from 'zod';

import { searchKnowledge, type KnowledgeCitation, type KnowledgeSearchResult } from './knowledge-assistant.js';
import type { ApiConfig } from './config.js';

export interface RagQaInput {
  question: string;
  kbId: string;
  tenantId: string;
  userId: string;
  topK?: number | undefined;
  minScore?: number | undefined;
  history?: Array<{ role: 'user' | 'assistant'; content: string }> | undefined;
}

export interface RagQaStep {
  type: 'step';
  step: 'query-analysis' | 'query-expansion' | 'retrieval' | 'source-ranking' | 'answer-generation';
  status: 'running' | 'completed' | 'error';
  title: string;
  detail?: string | undefined;
}

export interface RagQaCitations {
  type: 'citations';
  citations: KnowledgeCitation[];
}

export interface RagQaDelta {
  type: 'delta';
  delta: string;
}

export interface RagQaDone {
  type: 'done';
}

export interface RagQaError {
  type: 'error';
  code: string;
  message: string;
}

export type RagQaChunk = RagQaStep | RagQaCitations | RagQaDelta | RagQaDone | RagQaError;

interface QaModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface RetrievedChunk extends KnowledgeCitation {
  /** 用于多路查询 RRF 融合的累计分数 */
  rrfScore: number;
  /** 命中的原始查询索引 */
  fromQueries: number[];
}

const QUERY_REWRITE_PROMPT = `你是多轮对话查询改写助手。请根据「历史对话」和「当前问题」，把当前问题改写成一个完整、独立、适合知识库检索的问题。

规则：
1. 如果当前问题包含指代、省略或依赖上下文的词（如「它」「这个」「怎么做」「多少钱」等），必须结合历史对话补全实体。
2. 如果当前问题本身已经完整，直接返回原问题。
3. 只输出改写后的问题本身，不要解释、不要加引号。`;

const QUERY_EXPANSION_PROMPT = `你是知识库检索的查询扩展助手。用户的原始问题可能不够完整或使用了口语化表达，请你从多个角度生成 1-3 个检索式，以便从知识库中召回最相关的文档。

要求：
1. 保留原始问题的核心语义（必须作为第一条）。
2. 补充同义词、专业术语、关键实体替换后的变体。
3. 如果问题是多跳/多条件的，拆成更直接的子查询。
4. 只输出 JSON，不要解释。格式：{"queries": ["检索式1", "检索式2", ...]}`;

const ANSWER_SYSTEM_PROMPT = `你是专业的智能客服助手，只能依据下方提供的「参考资料」回答用户问题，使用简体中文。

回答规则：
1. 每条事实必须能在参考资料中找到依据，用 [1]、[2] 等编号引用来源。
2. 如果参考资料不足以回答，必须明确说「根据当前知识库无法回答」。
3. 不要编造参考资料之外的事实、价格、日期、政策。
4. 优先给出结论，再补充必要解释；回答要简洁、专业、适合客服场景。
5. 若涉及多个并列要点，使用列表呈现。`;

const EXPANSION_SCHEMA = z.object({
  queries: z.array(z.string().trim().min(1)).min(1).max(3),
});

function sseFrame(chunk: RagQaChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createSseStream(
  generator: AsyncGenerator<RagQaChunk, void, unknown>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await generator.next();
        if (done) {
          controller.enqueue(encoder.encode(sseFrame({ type: 'done' })));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseFrame(value)));
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            sseFrame({
              type: 'error',
              code: 'STREAM_ERROR',
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      // generator 内部通过 AbortSignal 感知取消，这里无需额外操作。
    },
  });
}

async function rewriteQuery(
  model: QaModelConfig,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!history || history.length === 0) return null;

  const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${model.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: QUERY_REWRITE_PROMPT },
        ...history.slice(-4).flatMap((h) => [
          { role: h.role as 'user' | 'assistant', content: h.content },
        ]),
        { role: 'user', content: `当前问题：${question}` },
      ],
    }),
    signal: signal ?? null,
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rewritten = payload.choices?.[0]?.message?.content?.trim() ?? '';
  if (!rewritten || rewritten === question) return null;
  return rewritten;
}

async function* expandQueries(
  model: QaModelConfig,
  question: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${model.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model.model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: QUERY_EXPANSION_PROMPT },
        { role: 'user', content: question },
      ],
    }),
    signal: signal ?? null,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`query expansion failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  let parsed: { queries?: string[] };
  try {
    parsed = JSON.parse(content) as { queries?: string[] };
  } catch {
    // 模型偶尔在 JSON 外包裹 markdown code block，兜底提取
    const match = content.match(/\{[\s\S]*\}/);
    parsed = match ? (JSON.parse(match[0]) as { queries?: string[] }) : {};
  }
  const queries = EXPANSION_SCHEMA.safeParse(parsed).success
    ? EXPANSION_SCHEMA.parse(parsed).queries
    : [question];

  // 确保原始问题一定在首位
  const normalized = queries.includes(question) ? queries : [question, ...queries];
  for (const query of normalized.slice(0, 3)) {
    yield query;
  }
}

async function retrieveMultipleQueries(
  mcp: NonNullable<ApiConfig['KNOWLEDGE_MCP']>,
  input: RagQaInput,
  queries: string[],
  signal?: AbortSignal,
): Promise<KnowledgeSearchResult[]> {
  const results: KnowledgeSearchResult[] = [];
  for (const query of queries) {
    const result = await searchKnowledge(
      mcp,
      { tenantId: input.tenantId, userId: input.userId, kbIds: [input.kbId] },
      { query, topK: input.topK ?? 20 },
    );
    results.push(result);
    if (signal?.aborted) break;
  }
  return results;
}

function fuseWithRrf(results: KnowledgeSearchResult[]): RetrievedChunk[] {
  const k = 60;
  const byChunkId = new Map<string, RetrievedChunk>();

  results.forEach((result, queryIndex) => {
    result.citations.forEach((citation, rank) => {
      const existing = byChunkId.get(citation.chunkId);
      const score = 1 / (k + rank + 1);
      if (existing) {
        existing.rrfScore += score;
        if (!existing.fromQueries.includes(queryIndex)) {
          existing.fromQueries.push(queryIndex);
        }
      } else {
        byChunkId.set(citation.chunkId, {
          ...citation,
          rrfScore: score,
          fromQueries: [queryIndex],
        });
      }
    });
  });

  return [...byChunkId.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, 10);
}

async function* streamAnswer(
  model: QaModelConfig,
  question: string,
  citations: KnowledgeCitation[],
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const context = citations
    .map((c, index) => `[${index + 1}] 来源：${c.documentName}${c.heading ? ` / ${c.heading}` : ''}\n${c.passage}`)
    .join('\n\n');

  const messages = [
    { role: 'system', content: ANSWER_SYSTEM_PROMPT },
    ...history.flatMap((h) => [
      { role: h.role as 'user' | 'assistant', content: h.content },
    ]),
    {
      role: 'user',
      content: context
        ? `参考资料：\n${context}\n\n问题：${question}`
        : `问题：${question}`,
    },
  ];

  const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${model.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model.model,
      temperature: 0.3,
      stream: true,
      messages,
    }),
    signal: signal ?? null,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`answer generation failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('answer generation response has no body');

  const decoder = new TextDecoder('utf8');
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        const json = trimmed.slice(6);
        let chunk: unknown;
        try {
          chunk = JSON.parse(json);
        } catch {
          continue;
        }
        const delta = (chunk as { choices?: Array<{ delta?: { content?: string } }> })?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield delta;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function* runRagQa(
  input: RagQaInput,
  mcp: NonNullable<ApiConfig['KNOWLEDGE_MCP']>,
  model: QaModelConfig,
  signal?: AbortSignal,
): AsyncGenerator<RagQaChunk, void, unknown> {
  const step = (
    step: RagQaStep['step'],
    status: RagQaStep['status'],
    title: string,
    detail?: string,
  ): RagQaStep => ({ type: 'step', step, status, title, detail });

  try {
    // 1. 查询分析（含多轮指代消解）
    yield step('query-analysis', 'running', '正在理解您的问题');
    let searchQuestion = input.question;
    if (input.history && input.history.length > 0) {
      const rewritten = await rewriteQuery(model, input.question, input.history, signal);
      if (rewritten) {
        searchQuestion = rewritten;
        yield step('query-analysis', 'completed', '已理解问题', `结合上下文改写为：${rewritten}`);
      } else {
        yield step('query-analysis', 'completed', '已理解问题');
      }
    } else {
      yield step('query-analysis', 'completed', '已理解问题');
    }

    // 2. 查询扩展
    yield step('query-expansion', 'running', '正在扩展检索式');
    const expandedQueries: string[] = [];
    try {
      for await (const query of expandQueries(model, searchQuestion, signal)) {
        expandedQueries.push(query);
      }
      yield step(
        'query-expansion',
        'completed',
        '检索式扩展完成',
        `将使用 ${expandedQueries.length} 个检索式并行检索`,
      );
    } catch (error) {
      // 查询扩展失败时回退到单查询，不要中断整个流程
      expandedQueries.push(input.question);
      yield step(
        'query-expansion',
        'completed',
        '检索式扩展完成',
        `扩展失败，使用原问题检索：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 3. 多路检索
    yield step('retrieval', 'running', '正在检索相关知识', expandedQueries.join(' / '));
    const rawResults = await retrieveMultipleQueries(mcp, input, expandedQueries, signal);
    if (signal?.aborted) return;

    yield step(
      'retrieval',
      'completed',
      '检索完成',
      `召回 ${rawResults.reduce((sum, r) => sum + r.citations.length, 0)} 条候选`,
    );

    // 4. 结果融合/重排序
    yield step('source-ranking', 'running', '正在评估资料相关性');
    const ranked = fuseWithRrf(rawResults);
    const filtered = input.minScore !== undefined
      ? ranked.filter((c) => c.score >= input.minScore!)
      : ranked;

    yield {
      type: 'citations',
      citations: filtered.map(({ rrfScore: _s, fromQueries: _f, ...rest }) => rest),
    };
    yield step(
      'source-ranking',
      'completed',
      '资料排序完成',
      `融合后保留 ${filtered.length} 条最相关来源`,
    );

    if (signal?.aborted) return;

    // 5. 生成回答
    yield step('answer-generation', 'running', '正在生成回答');
    for await (const delta of streamAnswer(
      model,
      input.question,
      filtered,
      input.history ?? [],
      signal,
    )) {
      yield { type: 'delta', delta };
    }
    yield step('answer-generation', 'completed', '回答已生成');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: 'error', code: 'RAG_QA_FAILED', message };
  }
}

export interface RagQaServices {
  config: ApiConfig;
}

export function createRagQaService(services: RagQaServices) {
  const mcp = services.config.KNOWLEDGE_MCP;
  const model = services.config.KNOWLEDGE_QA_MODEL;

  return {
    isAvailable(): boolean {
      return Boolean(mcp && model);
    },

    stream(input: RagQaInput, signal?: AbortSignal): ReadableStream<Uint8Array> {
      if (!mcp || !model) {
        const encoder = new TextEncoder();
        return new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                sseFrame({
                  type: 'error',
                  code: 'RAG_NOT_CONFIGURED',
                  message: 'Knowledge MCP or QA model is not configured',
                }),
              ),
            );
            controller.close();
          },
        });
      }
      const generator = runRagQa(input, mcp, model, signal);
      return createSseStream(generator);
    },

    // 同步非流式接口，供测试和评估脚本使用
    async answer(input: RagQaInput): Promise<{ answer: string; citations: KnowledgeCitation[] }> {
      if (!mcp || !model) {
        throw new Error('RAG QA service is not configured');
      }
      const chunks: RagQaChunk[] = [];
      for await (const chunk of runRagQa(input, mcp, model)) {
        chunks.push(chunk);
      }
      const answer = chunks
        .filter((c): c is RagQaDelta => c.type === 'delta')
        .map((c) => c.delta)
        .join('');
      const citations = chunks.find((c): c is RagQaCitations => c.type === 'citations')?.citations ?? [];
      return { answer, citations };
    },
  };
}

export { sseFrame };
