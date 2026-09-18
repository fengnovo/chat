import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const DEFAULT_TRUST_PROXY_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
].join(',');

function parseTrustedProxyCidrs(value: string): string[] {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error('TRUST_PROXY_CIDRS must contain at least one CIDR');
  }
  for (const entry of entries) {
    const match = entry.match(/^(.+)\/(\d+)$/);
    const address = match?.[1];
    const prefix = Number(match?.[2]);
    const family = address ? isIP(address) : 0;
    const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (maximum < 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`Invalid TRUST_PROXY_CIDRS entry: ${entry}`);
    }
  }
  return entries;
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().positive().default(8000),
    API_VERSION: z.string().trim().min(1).max(64).default('0.1.0'),
    TRUST_PROXY_CIDRS: z.string().default(DEFAULT_TRUST_PROXY_CIDRS),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z
      .string()
      .default('postgresql://agent:agent@127.0.0.1:55432/agent'),
    REDIS_URL: z.string().default('redis://127.0.0.1:56379'),
    S3_ENDPOINT: z.string().url().default('http://127.0.0.1:59000'),
    S3_PUBLIC_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('agent-artifacts'),
    S3_ACCESS_KEY: z.string().default('agent'),
    S3_SECRET_KEY: z.string().default('agent-local-secret'),
    ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().default(100_000_000),
    PROJECT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20_000_000),
    KNOWLEDGE_DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(20_000_000),
    EMBEDDING_PROFILE: z.string().trim().min(1).optional(),
    EMBEDDING_MODEL: z.string().trim().min(1).optional(),
    EMBEDDING_DIM: z.coerce.number().int().positive().optional(),
    QDRANT_COLLECTION_PREFIX: z.string().trim().min(1).default('knowledge'),
    RATE_LIMIT_REQUESTS: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(500),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
    OUTBOX_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
    OUTBOX_STALE_AFTER_MS: z.coerce.number().int().min(5_000).default(30_000),
    AUTH_MODE: z.enum(['dev', 'password', 'oidc']).default('dev'),
    AUTH_JWT_SECRET: z.string().min(32).optional(),
    DEV_TENANT_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
    DEV_USER_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
    // 自助注册加入的租户；缺省时加入 DEV_TENANT_ID 指向的默认（seed）租户。
    SIGNUP_TENANT_ID: z.uuid().optional(),
    // 公开自助注册开关；未显式配置时仅开发/测试环境开放，生产默认关闭。
    AUTH_SIGNUP_ENABLED: z.enum(['true', 'false']).optional(),
    OIDC_ISSUER: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    OIDC_AUDIENCE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    OIDC_JWKS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    // OAuth2 社交登录（GitHub / Google）：与 AUTH_MODE 正交，password 模式下可叠加使用。
    OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
    OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
    OAUTH_CALLBACK_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    OAUTH_STATE_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
    WORKSPACE_ROOT: z.string().default(path.join(repositoryRoot, 'data/workspaces')),
    // 与 worker 的沙箱配置保持一致：删除会话时需要级联清理沙箱文件目录。
    SANDBOX_RUNTIME: z.enum(['docker', 'e2b-cloud']).default('docker'),
    // 优先专用变量；本地沿用 .env 里 worker 的 DOCKER_SANDBOX_SESSIONS_ROOT。
    SANDBOX_SESSIONS_ROOT: z.string().optional(),
    DOCKER_SANDBOX_SESSIONS_ROOT: z.string().optional(),
    // 知识检索/问答通过 knowledge-service MCP 完成（API 不持有 embedding/Qdrant 凭证）。
    KNOWLEDGE_MCP_URL: z.string().url().optional(),
    KNOWLEDGE_MCP_SECRET: z.string().min(8).optional(),
    KNOWLEDGE_TOKEN_SECRET: z.string().min(8).optional(),
    KNOWLEDGE_MCP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    // 知识问答使用的 OpenAI 兼容 Chat Completions 接口（本地为 DeepSeek）。
    OPENAI_BASE_URL: z.string().url().optional(),
    OPENAI_API_KEY: z.string().optional(),
    MODEL: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.AUTH_MODE === 'dev') {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'AUTH_MODE=dev is forbidden in production',
      });
    }
    if (value.AUTH_MODE === 'password' && !value.AUTH_JWT_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'AUTH_JWT_SECRET (min 32 chars) is required when AUTH_MODE=password',
      });
    }
    if (
      value.AUTH_MODE === 'oidc' &&
      (!value.OIDC_ISSUER || !value.OIDC_AUDIENCE || !value.OIDC_JWKS_URL)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL are required',
      });
    }
  });

export type ApiConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(environment);
  const databaseUrl =
    environment.DATABASE_URL ??
    (value.NODE_ENV === 'test'
      ? 'postgresql://agent:agent@127.0.0.1:55433/agent_test'
      : value.DATABASE_URL);
  const embeddingInputs = [value.EMBEDDING_PROFILE, value.EMBEDDING_MODEL, value.EMBEDDING_DIM];
  const hasCompleteEmbeddingProfile = embeddingInputs.every((item) => item !== undefined);
  if (!hasCompleteEmbeddingProfile && embeddingInputs.some((item) => item !== undefined)) {
    throw new Error('EMBEDDING_PROFILE, EMBEDDING_MODEL and EMBEDDING_DIM must be configured together');
  }
  // worker 的 dev 进程 cwd 是 apps/worker，.env 里的相对路径
  // ./data/sandboxes 实际落在 apps/worker/data/sandboxes；
  // API 的 cwd 不同，相对路径统一按 worker 目录解析才能指向同一份文件。
  const workerRoot = path.join(repositoryRoot, 'apps/worker');
  const sandboxSessionsRoot =
    value.SANDBOX_SESSIONS_ROOT ??
    value.DOCKER_SANDBOX_SESSIONS_ROOT ??
    path.join(repositoryRoot, 'data/sandboxes');
  return {
    ...value,
    TRUST_PROXY_CIDRS: parseTrustedProxyCidrs(value.TRUST_PROXY_CIDRS),
    DATABASE_URL: databaseUrl,
    WORKSPACE_ROOT: path.resolve(value.WORKSPACE_ROOT),
    SIGNUP_TENANT_ID: value.SIGNUP_TENANT_ID ?? value.DEV_TENANT_ID,
    SIGNUP_ENABLED:
      value.AUTH_SIGNUP_ENABLED !== undefined
        ? value.AUTH_SIGNUP_ENABLED === 'true'
        : value.NODE_ENV !== 'production',
    KNOWLEDGE_EMBEDDING_PROFILE: hasCompleteEmbeddingProfile ? {
      key: value.EMBEDDING_PROFILE!,
      model: value.EMBEDDING_MODEL!,
      dimension: value.EMBEDDING_DIM!,
      collectionPrefix: value.QDRANT_COLLECTION_PREFIX,
    } : undefined,
    KNOWLEDGE_MCP: (() => {
      const url = value.KNOWLEDGE_MCP_URL;
      const secret = value.KNOWLEDGE_MCP_SECRET ?? value.KNOWLEDGE_TOKEN_SECRET;
      if (!url || !secret) return undefined;
      return { url, secret, timeoutMs: value.KNOWLEDGE_MCP_TIMEOUT_MS };
    })(),
    KNOWLEDGE_QA_MODEL: value.OPENAI_BASE_URL && value.OPENAI_API_KEY
      ? {
          baseUrl: value.OPENAI_BASE_URL,
          apiKey: value.OPENAI_API_KEY,
          model: value.MODEL ?? 'deepseek-chat',
        }
      : undefined,
    SANDBOX_SESSIONS_ROOT: path.isAbsolute(sandboxSessionsRoot)
      ? path.normalize(sandboxSessionsRoot)
      : path.resolve(workerRoot, sandboxSessionsRoot),
    OAUTH: {
      github: value.OAUTH_GITHUB_CLIENT_ID && value.OAUTH_GITHUB_CLIENT_SECRET
        ? { clientId: value.OAUTH_GITHUB_CLIENT_ID, clientSecret: value.OAUTH_GITHUB_CLIENT_SECRET }
        : undefined,
      google: value.OAUTH_GOOGLE_CLIENT_ID && value.OAUTH_GOOGLE_CLIENT_SECRET
        ? { clientId: value.OAUTH_GOOGLE_CLIENT_ID, clientSecret: value.OAUTH_GOOGLE_CLIENT_SECRET }
        : undefined,
      callbackUrl: value.OAUTH_CALLBACK_URL,
      stateSecret: value.OAUTH_STATE_SECRET ?? value.AUTH_JWT_SECRET,
    },
  };
}
