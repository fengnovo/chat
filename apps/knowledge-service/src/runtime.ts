import {
  buildEmbeddingProfile,
  createOpenAICompatibleEmbedder,
  IndexPipeline,
  type Embedder,
  type EmbeddingProfile,
} from '@repo/knowledge-graphrag';

import type { KnowledgeServiceConfig } from './config.js';

export interface KnowledgeRuntimeDependencies {
  pipeline?: { run(job: unknown): Promise<void> };
  embedder?: Embedder;
  fetch?: typeof globalThis.fetch;
  [key: string]: unknown;
}

export interface KnowledgeRuntime extends KnowledgeRuntimeDependencies {
  profile?: EmbeddingProfile;
  embedder?: Embedder;
  pipeline: { run(job: unknown): Promise<void> };
}

export function createKnowledgeRuntime(
  config: KnowledgeServiceConfig,
  deps: KnowledgeRuntimeDependencies = {},
): KnowledgeRuntime {
  if (deps.pipeline) return { ...deps, pipeline: deps.pipeline };

  const profile = buildEmbeddingProfile({
    key: config.embeddingProfile,
    model: config.embeddingModel,
    dimension: config.embeddingDimension,
    collectionPrefix: config.qdrantCollectionPrefix,
  });
  const embedder = deps.embedder ?? createOpenAICompatibleEmbedder({
    profile,
    apiKey: config.embeddingApiKey,
    baseUrl: config.embeddingBaseUrl,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (embedder.profile.collectionName !== profile.collectionName) {
    throw new Error(
      `Embedding profile collection mismatch: expected ${profile.collectionName}, received ${embedder.profile.collectionName}`,
    );
  }

  return {
    ...deps,
    profile,
    embedder,
    pipeline: new IndexPipeline({ ...deps, embedder }),
  };
}
