import { normalizeEntityKey, type GraphExtraction } from '@repo/knowledge-graphrag';

export interface LlmGraphExtractorOptions {
  model: string;
  baseUrl: string;
  apiKey: string;
  maxInputChars?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  logger?: { error?(error: unknown): void; warn?(message: string): void };
}

const SYSTEM_PROMPT = [
  'You extract a concise knowledge graph from a single document passage.',
  'Return ONLY minified JSON, no markdown, no commentary, with this exact shape:',
  '{"entities":[{"name":string,"type":string}],"relationships":[{"source":string,"target":string,"type":string}]}',
  'Rules:',
  '- Use canonical entity names (proper nouns, concepts); merge aliases case-insensitively.',
  '- "type" for relationships is a short verb or predicate (e.g. owns, works_with, located_in).',
  '- Relationship source/target must match an entity name exactly.',
  '- Extract only facts explicitly supported by the passage; at most 30 entities and 60 relationships.',
].join(' ');

const MAX_ENTITIES = 30;
const MAX_RELATIONSHIPS = 60;

function asTrimmedString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, maxLength);
  return text || null;
}

function stripCodeFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? raw).trim();
}

export function parseGraphExtraction(raw: string): GraphExtraction {
  const parsed = JSON.parse(stripCodeFence(raw)) as { entities?: unknown; relationships?: unknown };
  const entities: Array<{ name: string; key: string; type: string }> = [];
  const entityNames = new Set<string>();
  const addEntity = (name: string, type = 'entity') => {
    const key = normalizeEntityKey(name);
    if (entityNames.has(key)) return;
    entityNames.add(key);
    entities.push({ name: name.trim(), key, type: type.trim().slice(0, 80) || 'entity' });
  };

  if (Array.isArray(parsed.entities)) {
    for (const item of parsed.entities.slice(0, MAX_ENTITIES)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const name = asTrimmedString(record.name);
      if (!name) continue;
      addEntity(name, asTrimmedString(record.type) ?? 'entity');
    }
  }

  const relationships: Array<{ source: string; target: string; type: string; sourceKey: string; targetKey: string }> = [];
  const relationKeys = new Set<string>();
  if (Array.isArray(parsed.relationships)) {
    for (const item of parsed.relationships.slice(0, MAX_RELATIONSHIPS)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const source = asTrimmedString(record.source);
      const target = asTrimmedString(record.target);
      const type = asTrimmedString(record.type) ?? asTrimmedString(record.relation);
      if (!source || !target || !type) continue;
      // 端点必须存在；模型漏抽时补成默认实体，保证关系可落库。
      if (!entityNames.has(normalizeEntityKey(source))) addEntity(source);
      if (!entityNames.has(normalizeEntityKey(target))) addEntity(target);
      const sourceKey = normalizeEntityKey(source);
      const targetKey = normalizeEntityKey(target);
      const dedupeKey = `${sourceKey}\u0000${type}\u0000${targetKey}`;
      if (relationKeys.has(dedupeKey)) continue;
      relationKeys.add(dedupeKey);
      relationships.push({ source: source.trim(), target: target.trim(), type: type.trim(), sourceKey, targetKey });
    }
  }
  return { entities: entities as GraphExtraction['entities'], relationships: relationships as GraphExtraction['relationships'] };
}

/**
 * 通过 OpenAI 兼容的 Chat Completions 接口抽取知识图谱。
 * 抽取失败时降级为空图（记录日志），不让单个 chunk 的 LLM 抖动导致整篇文档索引失败。
 */
export function createLlmGraphExtractor(options: LlmGraphExtractorOptions): (text: string) => Promise<GraphExtraction> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxInputChars = options.maxInputChars ?? 8_000;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async function extract(text: string): Promise<GraphExtraction> {
    const passage = text.trim().slice(0, maxInputChars);
    if (!passage) return { entities: [], relationships: [] };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
            body: JSON.stringify({
              model: options.model,
              temperature: 0,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: passage },
              ],
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`extraction LLM HTTP ${response.status}: ${detail.slice(0, 300)}`);
        }
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error('extraction LLM returned empty content');
        return parseGraphExtraction(content);
      } catch (error) {
        lastError = error;
      }
    }
    options.logger?.error?.(lastError);
    options.logger?.warn?.('graph extraction failed for chunk; continuing without graph edges');
    return { entities: [], relationships: [] };
  };
}
