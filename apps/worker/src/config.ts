import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOCKER_SANDBOX_WORKSPACE, type ModelSpec } from '@repo/agent-core';
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
  AGENT_DRIVER: z.literal('deep').default('deep'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WORKSPACE_ROOT: z.string().default(path.join(repositoryRoot, 'data/workspaces')),
  SANDBOX_RUNTIME: z.enum(['docker', 'e2b-cloud']).default('docker'),
  DOCKER_SANDBOX_IMAGE: z.string().trim().default('chat-agent-sandbox:latest'),
  DOCKER_SANDBOX_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(180_000),
  DOCKER_SANDBOX_SESSIONS_ROOT: z
    .string()
    .default(path.join(repositoryRoot, 'data/sandboxes')),
  DOCKER_SANDBOX_WORKSPACE_PATH: z
    .string()
    .trim()
    .startsWith('/')
    .default(DOCKER_SANDBOX_WORKSPACE),
  E2B_API_KEY: z.string().trim().optional(),
  E2B_TEMPLATE: z.string().trim().default('base'),
  E2B_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  E2B_WORKSPACE_PATH: z.string().trim().startsWith('/').default('/home/user/workspace'),
  E2B_API_URL: z.string().url().optional(),
  E2B_SANDBOX_URL: z.string().url().optional(),
  MODEL: z.string().default('openai:gpt-4o-mini'),
  MODEL_PROVIDER: z.string().default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  FALLBACK_MODELS: z.string().optional(),
  MODEL_MAX_TOKENS: z.coerce.number().int().min(1_000).max(200_000).default(16_000),
  // 多步编码任务需要数百个 super-step；预算过低会把接近完成的任务判为失败。
  AGENT_RECURSION_LIMIT: z.coerce.number().int().min(50).max(10_000).default(600),
  AGENT_MODEL_CALL_LIMIT: z.coerce.number().int().min(10).max(10_000).default(120),
  MCP_CONFIG_PATH: z.string().optional(),
  KNOWLEDGE_MCP_URL: z.string().url().optional(),
  KNOWLEDGE_MCP_SECRET: z.string().optional(),
  KNOWLEDGE_MCP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  KNOWLEDGE_MCP_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // DeepAgents memory/skills：宿主机路径，Worker 启动时上传到沙箱。
  AGENT_MEMORY_FILE: z.string().optional(),
  AGENT_SKILLS_DIR: z.string().optional(),
  // 历史消息压缩：token 数超过该阈值时自动压缩旧消息，降低 LLM 输入 token 数。
  AGENT_SUMMARIZATION_TRIGGER_TOKENS: z.coerce.number().int().min(5_000).max(200_000).default(50_000),
  AGENT_SUMMARIZATION_KEEP_TOKENS: z.coerce.number().int().min(1_000).max(100_000).default(15_000),
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
    maxTokens: config.MODEL_MAX_TOKENS,
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
  const sandboxSessionsRoot = path.resolve(value.DOCKER_SANDBOX_SESSIONS_ROOT);
  // 相对路径一律按仓库根解析，同一份 .env 在本机（仓库目录）与生产（/opt/chat）都可用。
  const mcpConfigPath = value.MCP_CONFIG_PATH
    ? path.resolve(repositoryRoot, value.MCP_CONFIG_PATH)
    : undefined;
  if (value.SANDBOX_RUNTIME === 'e2b-cloud' && !value.E2B_API_KEY) {
    throw new Error('E2B_API_KEY is required when SANDBOX_RUNTIME=e2b-cloud');
  }
  const models = [value.MODEL, ...(value.FALLBACK_MODELS?.split(',') ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => modelSpec(item, value));
  return {
    ...value,
    DATABASE_URL: databaseUrl,
    WORKSPACE_ROOT: workspaceRoot,
    DOCKER_SANDBOX_SESSIONS_ROOT: sandboxSessionsRoot,
    MCP_CONFIG_PATH: mcpConfigPath,
    models,
  };
}
