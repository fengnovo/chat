import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelSpec } from '@repo/agent-core';
import { z } from 'zod';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string()
    .default('postgresql://agent:agent@127.0.0.1:55432/agent'),
  REDIS_URL: z.string().default('redis://127.0.0.1:56379'),
  S3_ENDPOINT: z.string().url().default('http://127.0.0.1:59000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('agent-artifacts'),
  S3_ACCESS_KEY: z.string().default('agent'),
  S3_SECRET_KEY: z.string().default('agent-local-secret'),
  AGENT_DRIVER: z.enum(['demo', 'deep']).default('demo'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WORKSPACE_ROOT: z.string().default(path.join(repositoryRoot, 'data/workspaces')),
  MODEL: z.string().default('openai:gpt-4o-mini'),
  MODEL_PROVIDER: z.string().default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  FALLBACK_MODELS: z.string().optional(),
  MCP_CONFIG_PATH: z.string().optional(),
});

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

function modelSpec(raw: string, config: z.infer<typeof schema>): ModelSpec {
  const separator = raw.indexOf(':');
  const provider = separator > 0 ? raw.slice(0, separator) : config.MODEL_PROVIDER;
  const model = separator > 0 ? raw.slice(separator + 1) : raw;
  const apiKey = provider === 'anthropic' ? config.ANTHROPIC_API_KEY : config.OPENAI_API_KEY;
  if (!apiKey) throw new Error(`Missing API key for model provider ${provider}`);
  return {
    id: `${provider}:${model}`,
    model,
    provider,
    apiKey,
    ...(provider === 'openai' && config.OPENAI_BASE_URL
      ? { baseUrl: config.OPENAI_BASE_URL }
      : {}),
  };
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(environment);
  const databaseUrl =
    environment.DATABASE_URL ??
    (value.NODE_ENV === 'test'
      ? 'postgresql://agent:agent@127.0.0.1:55433/agent_test'
      : value.DATABASE_URL);
  const workspaceRoot = path.resolve(value.WORKSPACE_ROOT);
  const models =
    value.AGENT_DRIVER === 'deep'
      ? [value.MODEL, ...(value.FALLBACK_MODELS?.split(',') ?? [])]
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => modelSpec(item, value))
      : [];
  return {
    ...value,
    DATABASE_URL: databaseUrl,
    WORKSPACE_ROOT: workspaceRoot,
    models,
  };
}
