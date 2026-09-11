import { randomUUID } from 'node:crypto';

import {
  createDeepAgentRuntime,
  type HeadlessAgentRuntime,
  type ModelSpec,
} from '@repo/agent-core';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import type { SessionStore } from '../sessions.js';
import type { CliSettings } from './config.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}，请先在项目根目录的 .env 中配置。`);
  return value;
}

function modelSpec(raw: string): ModelSpec {
  const separator = raw.indexOf(':');
  const provider = separator > 0 ? raw.slice(0, separator) : 'openai';
  const model = separator > 0 ? raw.slice(separator + 1) : raw;
  const apiKeyName =
    provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const baseUrl =
    provider === 'openai' ? process.env.OPENAI_BASE_URL?.trim() : undefined;
  return {
    id: `${provider}:${model}`,
    provider,
    model,
    apiKey: requiredEnv(apiKeyName),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export async function createAgentRuntime(
  settings: CliSettings,
  sessionStore: SessionStore,
  threadId: string,
): Promise<HeadlessAgentRuntime> {
  const models = [requiredEnv('MODEL'), ...(process.env.FALLBACK_MODELS?.split(',') ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(modelSpec);
  return createDeepAgentRuntime({
    runId: randomUUID(),
    sessionId: threadId,
    workspacePath: settings.cwd,
    checkpointer: SqliteSaver.fromConnString(sessionStore.dbPath),
    models,
    mcpConfigPath: settings.mcpConfigPath,
    skills: settings.skillCount > 0 ? ['../skills/'] : [],
    memory: ['../AGENTS.md'],
    inheritEnv: true,
  });
}

export type AgentRuntime = HeadlessAgentRuntime;
