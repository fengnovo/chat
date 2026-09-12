import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  createDeepAgentRuntime,
  E2BSandbox,
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

async function uploadAgentResources(
  sandbox: E2BSandbox,
  settings: CliSettings,
  workspacePath: string,
): Promise<{ skills: string[]; memory: string[] }> {
  const files: Array<[string, Uint8Array]> = [];
  const memoryPath = path.posix.join(workspacePath, '.deepagents/AGENTS.md');
  if (existsSync(settings.memoryHostFile)) {
    files.push([memoryPath, await readFile(settings.memoryHostFile)]);
  }

  const skillRoot = path.posix.join(workspacePath, '.deepagents/skills');
  if (existsSync(settings.skillsHostDir)) {
    for (const entry of await readdir(settings.skillsHostDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(settings.skillsHostDir, entry.name, 'SKILL.md');
      if (!existsSync(source)) continue;
      files.push([path.posix.join(skillRoot, entry.name, 'SKILL.md'), await readFile(source)]);
    }
  }

  if (files.length > 0) {
    const directories = [...new Set(files.map(([filePath]) => path.posix.dirname(filePath)))];
    const prepared = await sandbox.execute(
      `mkdir -p -- ${directories.map((dir) => `'${dir.replaceAll("'", "'\\''")}'`).join(' ')}`,
    );
    if (prepared.exitCode !== 0) throw new Error(prepared.output);
    const uploaded = await sandbox.uploadFiles(files);
    const failed = uploaded.find((result) => result.error);
    if (failed) throw new Error(`无法上传 Agent 配置：${failed.path} (${failed.error})`);
  }

  return {
    skills: files.some(([filePath]) => filePath.startsWith(`${skillRoot}/`)) ? [skillRoot] : [],
    memory: files.some(([filePath]) => filePath === memoryPath) ? [memoryPath] : [],
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
  const sandboxOptions = {
    apiKey: requiredEnv('E2B_API_KEY'),
    template: process.env.E2B_TEMPLATE?.trim() || 'base',
    timeoutMs: Number(process.env.E2B_TIMEOUT_MS ?? 3_600_000),
  };
  const existingSandboxId = sessionStore.getSandboxId(threadId);
  let sandbox: E2BSandbox;
  if (existingSandboxId) {
    try {
      sandbox = await E2BSandbox.connect(existingSandboxId, sandboxOptions);
    } catch {
      sessionStore.clearSandboxId(threadId);
      sandbox = await E2BSandbox.create(sandboxOptions);
      sessionStore.setSandboxId(threadId, sandbox.id);
    }
  } else {
    sandbox = await E2BSandbox.create(sandboxOptions);
    sessionStore.setSandboxId(threadId, sandbox.id);
  }
  const workspacePath = process.env.E2B_WORKSPACE_PATH?.trim() || '/home/user/workspace';
  if (!workspacePath.startsWith('/') || workspacePath.includes('\0')) {
    await sandbox.kill().catch(() => undefined);
    sessionStore.clearSandboxId(threadId);
    throw new Error('E2B_WORKSPACE_PATH 必须是绝对路径。');
  }
  const prepared = await sandbox.execute(`mkdir -p -- '${workspacePath.replaceAll("'", "'\\''")}'`);
  if (prepared.exitCode !== 0) {
    await sandbox.kill().catch(() => undefined);
    sessionStore.clearSandboxId(threadId);
    throw new Error(prepared.output);
  }
  let runtime: HeadlessAgentRuntime;
  try {
    const resources = await uploadAgentResources(sandbox, settings, workspacePath);
    runtime = await createDeepAgentRuntime({
      runId: randomUUID(),
      sessionId: threadId,
      workspacePath,
      backend: sandbox,
      checkpointer: SqliteSaver.fromConnString(sessionStore.dbPath),
      models,
      mcpConfigPath: settings.mcpConfigPath,
      skills: resources.skills,
      memory: resources.memory,
    });
  } catch (error) {
    await sandbox.kill().catch(() => undefined);
    sessionStore.clearSandboxId(threadId);
    throw error;
  }
  return {
    ...runtime,
    async dispose() {
      await runtime.dispose().catch(() => undefined);
      await sandbox.pause().catch(() => undefined);
    },
  };
}

export type AgentRuntime = HeadlessAgentRuntime;
