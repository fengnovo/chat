import { z } from 'zod';
const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8090),
  redisUrl: z.string().url().default('redis://127.0.0.1:6379'),
  postgresUrl: z.string().min(1),
  tokenSecret: z.string().min(16),
  qdrantUrl: z.string().url(),
  embeddingProfile: z.string().min(1),
  extractionModel: z.string().min(1),
  concurrency: z.coerce.number().int().positive().default(2),
  budget: z.coerce.number().positive().default(1),
});
export type KnowledgeServiceConfig = z.infer<typeof configSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): KnowledgeServiceConfig {
  return configSchema.parse({ port: env.KNOWLEDGE_SERVICE_PORT, redisUrl: env.REDIS_URL, postgresUrl: env.DATABASE_URL, tokenSecret: env.GRAPHRAG_TOKEN_SECRET ?? env.KNOWLEDGE_TOKEN_SECRET, qdrantUrl: env.QDRANT_URL, embeddingProfile: env.EMBEDDING_PROFILE, extractionModel: env.EXTRACTION_MODEL, concurrency: env.KNOWLEDGE_CONCURRENCY, budget: env.KNOWLEDGE_BUDGET });
}
