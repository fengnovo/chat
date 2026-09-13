import type { Embedder, EmbeddingProfile } from '../types.js';

export interface OpenAICompatibleEmbedderOptions {
  profile: EmbeddingProfile;
  apiKey: string;
  baseUrl: string;
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
  private readonly endpoint: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleEmbedderOptions) {
    this.profile = options.profile;
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error('Embedding API key is required');
    const baseUrl = options.baseUrl.trim();
    if (!baseUrl) throw new Error('Embedding base URL is required');
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
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
      throw new Error(`Embedding request failed (${response.status}): ${errorMessage(body)}`);
    }

    let data: unknown;
    try {
      data = (JSON.parse(body) as { data?: unknown }).data;
    } catch {
      throw new Error('Embedding response was not valid JSON');
    }
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Embedding response count mismatch: expected ${texts.length}, received ${Array.isArray(data) ? data.length : 0}`);
    }

    const vectors = new Array<number[]>(texts.length);
    for (const raw of data) {
      const item = raw as Partial<EmbeddingResponseItem>;
      if (!Number.isInteger(item.index) || item.index! < 0 || item.index! >= texts.length || vectors[item.index!]) {
        throw new Error('Embedding response contained an invalid index');
      }
      if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`Embedding response at index ${item.index} was not a numeric vector`);
      }
      if (item.embedding.length !== this.profile.dimension) {
        throw new Error(`Embedding dimension mismatch at index ${item.index}: expected ${this.profile.dimension}, received ${item.embedding.length}`);
      }
      vectors[item.index!] = item.embedding;
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
