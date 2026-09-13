import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as service from '../src/index.js';

const config: any = {
  port: 0,
  redisUrl: 'redis://127.0.0.1:6379',
  postgresUrl: 'postgresql://agent:agent@127.0.0.1:5432/agent',
  tokenSecret: '0123456789abcdef',
  qdrantUrl: 'http://127.0.0.1:6333',
  qdrantCollectionPrefix: 'custom',
  embeddingProvider: 'bailian',
  embeddingModel: 'text-embedding-v4',
  embeddingApiKey: 'embedding-only-key',
  embeddingBaseUrl: 'https://dashscope.example/compatible-mode/v1',
  embeddingDimension: 2,
  embeddingProfile: 'bailian-v4',
  extractionModel: 'openai:gpt-4o-mini',
  concurrency: 1,
  budget: 1,
};

test('runtime factory maps embedding config to a prefix-consistent profile and provider request', async () => {
  const createKnowledgeRuntime = (service as Record<string, unknown>).createKnowledgeRuntime as undefined | ((config: any, deps?: any) => any);
  assert.equal(typeof createKnowledgeRuntime, 'function');
  if (!createKnowledgeRuntime) return;

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const runtime = createKnowledgeRuntime(config, {
    fetch: async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.75] }] }), { status: 200 });
    },
  });

  assert.deepEqual(runtime.profile, {
    key: 'bailian-v4',
    model: 'text-embedding-v4',
    dimension: 2,
    collectionName: 'custom_7d2b6e41fdddd9db_2',
  });
  assert.equal(runtime.embedder.profile, runtime.profile);
  assert.deepEqual(await runtime.embedder.embedQuery('question'), [0.25, 0.75]);
  assert.equal(requests[0]?.url, 'https://dashscope.example/compatible-mode/v1/embeddings');
  assert.equal((requests[0]?.init.headers as Record<string, string>).authorization, 'Bearer embedding-only-key');
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    input: ['question'],
    model: 'text-embedding-v4',
    dimensions: 2,
  });
});

test('default service worker runs an IndexPipeline wired to the configured embedder', async () => {
  let processJob: ((job: any) => Promise<void>) | undefined;
  const embeddedInputs: string[][] = [];
  const ensuredProfiles: any[] = [];
  const bytes = new TextEncoder().encode('runtime wiring');

  class FakeWorker {
    constructor(_queue: string, handler: (job: any) => Promise<void>) { processJob = handler; }
    on() { return this; }
    async close() {}
  }
  class FakeServer extends EventEmitter {
    listen(_port: number, callback: () => void) { callback(); return this; }
    close(callback: () => void) { callback(); }
  }

  const runtimeService = await service.startKnowledgeService(config, {
    WorkerClass: FakeWorker,
    connection: {},
    server: new FakeServer(),
    repository: {
      claimIndexJob: async () => ({ leaseToken: 'lease' }),
      markIndexStage: async () => true,
      replaceDocumentChunks: async () => {},
      replaceDocumentGraph: async () => {},
      completeIndexJob: async () => true,
      failIndexJob: async () => true,
    },
    download: async () => bytes,
    vectorStore: {
      ensureCollection: async (profile: any) => { ensuredProfiles.push(profile); },
      deleteByDocument: async () => {},
      upsert: async () => {},
    },
    extract: async () => ({ entities: [], relationships: [] }),
    fetch: async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      embeddedInputs.push(input);
      return new Response(JSON.stringify({
        data: input.map((_text, index) => ({ index, embedding: [index, index + 1] })),
      }), { status: 200 });
    },
  });

  try {
    assert.ok(processJob, 'default worker did not register a job processor');
    await processJob!({
      id: 'job-1',
      data: {
        tenantId: 'tenant-1',
        kbId: 'kb-1',
        documentId: 'document-1',
        objectKey: 'object-1',
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        mime: 'text/plain',
        chunkSize: 100,
        chunkOverlap: 0,
      },
    });
    assert.deepEqual(embeddedInputs, [['runtime wiring']]);
    assert.equal(ensuredProfiles[0]?.collectionName, 'custom_7d2b6e41fdddd9db_2');
  } finally {
    await runtimeService.close();
  }
});

test('default runtime reports missing external adapters before starting a worker', async () => {
  await assert.rejects(
    () => service.startKnowledgeService(config, { server: new EventEmitter() }),
    /default runtime requires.*connection.*repository.*download.*vectorStore.*extract/i,
  );
});

test('executable entry invokes the default runtime and reports its missing adapters', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', 'src/main.ts'], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: config.postgresUrl,
      KNOWLEDGE_TOKEN_SECRET: config.tokenSecret,
      QDRANT_URL: config.qdrantUrl,
      QDRANT_COLLECTION_PREFIX: config.qdrantCollectionPrefix,
      EMBEDDING_PROVIDER: config.embeddingProvider,
      EMBEDDING_MODEL: config.embeddingModel,
      EMBEDDING_API_KEY: config.embeddingApiKey,
      EMBEDDING_BASE_URL: config.embeddingBaseUrl,
      EMBEDDING_DIM: String(config.embeddingDimension),
      EMBEDDING_PROFILE: config.embeddingProfile,
      EXTRACTION_MODEL: config.extractionModel,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /default runtime requires dependencies: connection, repository, download, vectorStore, extract/i);
});

test('package start script runs the executable emitted by the build', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const build = spawn('pnpm', ['build'], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  let buildError = '';
  build.stderr.setEncoding('utf8');
  build.stderr.on('data', (chunk) => { buildError += chunk; });
  const buildExitCode = await new Promise<number | null>((resolve) => build.once('close', resolve));
  assert.equal(buildExitCode, 0, buildError);

  const child = spawn('pnpm', ['start'], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: config.postgresUrl,
      KNOWLEDGE_TOKEN_SECRET: config.tokenSecret,
      QDRANT_URL: config.qdrantUrl,
      QDRANT_COLLECTION_PREFIX: config.qdrantCollectionPrefix,
      EMBEDDING_PROVIDER: config.embeddingProvider,
      EMBEDDING_MODEL: config.embeddingModel,
      EMBEDDING_API_KEY: config.embeddingApiKey,
      EMBEDDING_BASE_URL: config.embeddingBaseUrl,
      EMBEDDING_DIM: String(config.embeddingDimension),
      EMBEDDING_PROFILE: config.embeddingProfile,
      EXTRACTION_MODEL: config.extractionModel,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /default runtime requires dependencies: connection, repository, download, vectorStore, extract/i);
});
