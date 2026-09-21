import type { Embedder, EmbeddingProfile } from '../types.js';

export interface OpenAICompatibleEmbedderOptions {
  profile: EmbeddingProfile;
  apiKey: string;
  baseUrl: string;
  batchSize?: number;
  fetch?: typeof globalThis.fetch;
}

interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string' && message.trim()) return message;
  } catch {
    // A non-JSON response is still useful diagnostic context.
  }
  return body.trim() || 'unknown provider error';
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly profile: EmbeddingProfile;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly endpoint: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleEmbedderOptions) {
    this.profile = options.profile;
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error('Embedding API key is required');
    const baseUrl = options.baseUrl.trim();
    if (!baseUrl) throw new Error('Embedding base URL is required');
    this.batchSize = options.batchSize ?? 10;
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error('Embedding batch size must be a positive integer');
    }
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      vectors.push(...await this.embedBatch(batch, offset / this.batchSize + 1));
    }
    return vectors;
  }

  private async embedBatch(texts: string[], batchNumber: number): Promise<number[][]> {
    const response = await this.request(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.profile.model,
        dimensions: this.profile.dimension,
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Embedding batch ${batchNumber} request failed (${response.status}): ${errorMessage(body)}`);
    }

    let data: unknown;
    try {
      data = (JSON.parse(body) as { data?: unknown }).data;
    } catch {
      throw new Error(`Embedding batch ${batchNumber} response was not valid JSON`);
    }
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Embedding batch ${batchNumber} response count mismatch: expected ${texts.length}, received ${Array.isArray(data) ? data.length : 0}`);
    }

    const vectors = new Array<number[]>(texts.length);
    const items = data as Partial<EmbeddingResponseItem>[];
    // 某些兼容实现（如 dashscope qwen embedding flash）批量返回的 index 恒为 0，
    // 实际按输入顺序返回向量；此时退化为按顺序对应，其余错序仍视为错误。
    const first = items[0];
    const sequentialFallback =
      texts.length > 1 && first !== undefined && items.every((item) => item.index === first.index);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) {
        throw new Error(`Embedding batch ${batchNumber} response was missing an entry`);
      }
      const index = sequentialFallback ? i : item.index;
      if (!Number.isInteger(index) || index! < 0 || index! >= texts.length || vectors[index!]) {
        throw new Error(`Embedding batch ${batchNumber} response contained an invalid index`);
      }
      if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`Embedding batch ${batchNumber} response at index ${index} was not a numeric vector`);
      }
      if (item.embedding.length !== this.profile.dimension) {
        throw new Error(`Embedding batch ${batchNumber} dimension mismatch at index ${index}: expected ${this.profile.dimension}, received ${item.embedding.length}`);
      }
      vectors[index!] = item.embedding;
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedTexts([text]);
    if (!vector) throw new Error('Embedding response did not contain a query vector');
    return vector;
  }
}

export function createOpenAICompatibleEmbedder(
  options: OpenAICompatibleEmbedderOptions,
): OpenAICompatibleEmbedder {
  return new OpenAICompatibleEmbedder(options);
}

export const createEmbedder = createOpenAICompatibleEmbedder;
