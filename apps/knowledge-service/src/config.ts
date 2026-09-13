import { z } from 'zod';

const embeddingProviderSchema = z.enum(['openai', 'bailian', 'openai-compatible'], {
  error: 'EMBEDDING_PROVIDER must be openai, bailian, or openai-compatible',
});

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8090),
  redisUrl: z.string().url().default('redis://127.0.0.1:6379'),
  postgresUrl: z.string().min(1),
  tokenSecret: z.string().min(16),
  qdrantUrl: z.string().url(),
  qdrantCollectionPrefix: z.string().trim().min(1).default('knowledge'),
  embeddingProvider: embeddingProviderSchema,
  embeddingModel: z.string({ error: 'EMBEDDING_MODEL is required' }).trim().min(1, 'EMBEDDING_MODEL is required'),
  embeddingApiKey: z.string({ error: 'EMBEDDING_API_KEY is required' }).trim().min(1, 'EMBEDDING_API_KEY is required'),
  embeddingBaseUrl: z.string({ error: 'EMBEDDING_BASE_URL is required' }).url('EMBEDDING_BASE_URL must be a URL'),
  embeddingDimension: z.coerce.number({ error: 'EMBEDDING_DIM is required' }).int().positive('EMBEDDING_DIM must be positive'),
  embeddingProfile: z.string({ error: 'EMBEDDING_PROFILE is required' }).trim().min(1, 'EMBEDDING_PROFILE is required'),
  extractionModel: z.string().min(1),
  concurrency: z.coerce.number().int().positive().default(2),
  budget: z.coerce.number().positive().default(1),
});
export type KnowledgeServiceConfig = z.infer<typeof configSchema>;

const defaultEmbeddingBaseUrl = (provider: z.infer<typeof embeddingProviderSchema>) => {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'bailian') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KnowledgeServiceConfig {
  const embeddingProvider = embeddingProviderSchema.parse(env.EMBEDDING_PROVIDER ?? 'openai');
  return configSchema.parse({
    port: env.KNOWLEDGE_SERVICE_PORT,
    redisUrl: env.REDIS_URL,
    postgresUrl: env.DATABASE_URL,
    tokenSecret: env.GRAPHRAG_TOKEN_SECRET ?? env.KNOWLEDGE_TOKEN_SECRET,
    qdrantUrl: env.QDRANT_URL,
    qdrantCollectionPrefix: env.QDRANT_COLLECTION_PREFIX,
    embeddingProvider,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingApiKey: env.EMBEDDING_API_KEY,
    embeddingBaseUrl: env.EMBEDDING_BASE_URL ?? defaultEmbeddingBaseUrl(embeddingProvider),
    embeddingDimension: env.EMBEDDING_DIM,
    embeddingProfile: env.EMBEDDING_PROFILE,
    extractionModel: env.EXTRACTION_MODEL,
    concurrency: env.KNOWLEDGE_CONCURRENCY,
    budget: env.KNOWLEDGE_BUDGET,
  });
}
