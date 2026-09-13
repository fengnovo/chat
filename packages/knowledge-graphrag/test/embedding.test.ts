import assert from 'node:assert/strict';
import test from 'node:test';

import * as graphrag from '../src/index.js';

type CreateEmbedder = (options: Record<string, unknown>) => {
  profile: { key: string; model: string; dimension: number; collectionName: string };
  embedTexts(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

const createEmbedder = (graphrag as Record<string, unknown>).createOpenAICompatibleEmbedder as CreateEmbedder | undefined;
const buildProfile = (graphrag as Record<string, unknown>).buildEmbeddingProfile as ((options: Record<string, unknown>) => any) | undefined;

test('embedding factory builds a Qdrant-ready profile and sends a batched OpenAI-compatible request', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const profile = buildProfile({ key: 'bailian-v4', model: 'text-embedding-v4', dimension: 3, collectionPrefix: 'kb' });
  const embedder = createEmbedder({
    profile,
    apiKey: 'embedding-key',
    baseUrl: 'https://dashscope.example/compatible-mode/v1/',
    fetch,
  });

  assert.deepEqual(await embedder.embedTexts(['alpha', 'beta']), [[1, 2, 3], [4, 5, 6]]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://dashscope.example/compatible-mode/v1/embeddings');
  assert.equal(requests[0]?.init.method, 'POST');
  assert.equal((requests[0]?.init.headers as Record<string, string>).authorization, 'Bearer embedding-key');
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    input: ['alpha', 'beta'],
    model: 'text-embedding-v4',
    dimensions: 3,
  });
  assert.match(profile.collectionName, /^kb_[a-f0-9]{16}_3$/);
  assert.equal(embedder.profile, profile);
});

test('embedQuery uses the same endpoint and returns one vector', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), { status: 200 });
  const embedder = createEmbedder({
    profile: buildProfile({ key: 'query', model: 'model', dimension: 2 }),
    apiKey: 'key',
    baseUrl: 'https://embeddings.example/v1',
    fetch,
  });
  assert.deepEqual(await embedder.embedQuery('question'), [0.1, 0.2]);
});

test('embedding responses with the wrong vector dimension are rejected', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 });
  const embedder = createEmbedder({
    profile: buildProfile({ key: 'bad-dimension', model: 'model', dimension: 3 }),
    apiKey: 'key',
    baseUrl: 'https://embeddings.example/v1',
    fetch,
  });
  await assert.rejects(() => embedder.embedTexts(['text']), /dimension.*expected 3.*received 2/i);
});

test('embedding HTTP errors surface status and provider message', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
  const embedder = createEmbedder({
    profile: buildProfile({ key: 'error', model: 'model', dimension: 2 }),
    apiKey: 'key',
    baseUrl: 'https://embeddings.example/v1',
    fetch,
  });
  await assert.rejects(() => embedder.embedTexts(['text']), /429.*quota exceeded/i);
});

test('defaults to provider-safe batches of at most ten inputs', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;

  const batches: string[][] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const input = JSON.parse(String(init?.body)).input as string[];
    batches.push(input);
    return new Response(JSON.stringify({
      data: input.map((text, index) => ({ index, embedding: [Number(text)] })),
    }), { status: 200 });
  };
  const embedder = createEmbedder({
    profile: buildProfile({ key: 'default-batches', model: 'text-embedding-v4', dimension: 1 }),
    apiKey: 'key',
    baseUrl: 'https://embeddings.example/v1',
    fetch,
  });
  const texts = Array.from({ length: 11 }, (_, index) => String(index));

  assert.deepEqual(await embedder.embedTexts(texts), texts.map((text) => [Number(text)]));
  assert.deepEqual(batches.map((batch) => batch.length), [10, 1]);
});

test('merges configured batches in original order when each response is unordered', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;

  const batches: string[][] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const input = JSON.parse(String(init?.body)).input as string[];
    batches.push(input);
    return new Response(JSON.stringify({
      data: input.map((text, index) => ({ index, embedding: [Number(text), Number(text) + 0.5] })).reverse(),
    }), { status: 200 });
  };
  const embedder = createEmbedder({
    profile: buildProfile({ key: 'configured-batches', model: 'model', dimension: 2 }),
    apiKey: 'key',
    baseUrl: 'https://embeddings.example/v1',
    batchSize: 3,
    fetch,
  });

  assert.deepEqual(await embedder.embedTexts(['0', '1', '2', '3', '4']), [
    [0, 0.5],
    [1, 1.5],
    [2, 2.5],
    [3, 3.5],
    [4, 4.5],
  ]);
  assert.deepEqual(batches, [['0', '1', '2'], ['3', '4']]);
});

test('rejects the entire embedding operation when a later batch returns an HTTP error', async () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;

  let requestCount = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requestCount++;
    if (requestCount === 2) {
      return new Response(JSON.stringify({ error: { message: 'second batch failed' } }), { status: 503 });
    }
    const input = JSON.parse(String(init?.body)).input as string[];
    return new Response(JSON.stringify({
      data: input.map((_text, index) => ({ index, embedding: [index] })),
    }), { status: 200 });
  };
  const embedder = createEmbedder({
    profile: buildProfile({ key: 'failed-batch', model: 'model', dimension: 1 }),
    apiKey: 'key',
    baseUrl: 'https://embeddings.example/v1',
    batchSize: 2,
    fetch,
  });

  await assert.rejects(
    () => embedder.embedTexts(['a', 'b', 'c']),
    /batch 2.*503.*second batch failed/i,
  );
  assert.equal(requestCount, 2);
});

test('rejects invalid embedding batch sizes before issuing requests', () => {
  assert.equal(typeof createEmbedder, 'function');
  assert.equal(typeof buildProfile, 'function');
  if (!createEmbedder || !buildProfile) return;

  for (const batchSize of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createEmbedder({
      profile: buildProfile({ key: 'invalid-batch', model: 'model', dimension: 1 }),
      apiKey: 'key',
      baseUrl: 'https://embeddings.example/v1',
      batchSize,
    }), /batch size.*positive integer/i);
  }
});
