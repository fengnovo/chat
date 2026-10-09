import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildRuntimeStaticDescriptor } from '@repo/agent-core';
import type { RunJob } from '@repo/contracts';
import type { WorkerConfig } from './config.js';
import type { AgentResources, RemoteWorkspaceSandbox } from './workspace.js';

type ResourceSnapshot = { files: Array<[string, Uint8Array]>; hashes: Record<string, string> };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
const credentialKey = /secret|token|api[_-]?key|password|authorization|cookie|credential/i;

function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (credentialKey.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return value; }
}

// 比较实际生效的路由和工具配置，同时允许仅轮换凭据。
function nonSecretConfig(value: unknown, key = ''): unknown {
  if (credentialKey.test(key)) return '[credential]';
  if (Array.isArray(value)) {
    let credentialValue = false;
    return value.map((item) => {
      if (credentialValue) { credentialValue = false; return '[credential]'; }
      if (typeof item === 'string' && item.startsWith('--') && credentialKey.test(item.split('=')[0]!)) {
        credentialValue = !item.includes('=');
        return item.split('=')[0];
      }
      return nonSecretConfig(item);
    });
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, nonSecretConfig(item, name)]));
  if (typeof value === 'string') {
    const expanded = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => credentialKey.test(name) ? '[credential]' : process.env[name] ?? '');
    return /url|endpoint/i.test(key) || /^https?:\/\//i.test(expanded) ? publicUrl(expanded) : expanded;
  }
  return value;
}

async function optionalFile(file: string | undefined): Promise<Uint8Array | null> {
  if (!file) return null;
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function snapshotResources(config: WorkerConfig): Promise<ResourceSnapshot> {
  const files: ResourceSnapshot['files'] = [];
  const memory = await optionalFile(config.AGENT_MEMORY_FILE);
  if (memory) files.push(['.deepagents/AGENTS.md', memory]);
  if (config.AGENT_SKILLS_DIR) {
    let entries: Dirent[];
    try { entries = await readdir(config.AGENT_SKILLS_DIR, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = []; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const content = await optionalFile(path.join(config.AGENT_SKILLS_DIR, entry.name, 'SKILL.md'));
      if (content) files.push([`.deepagents/skills/${entry.name}/SKILL.md`, content]);
    }
  }
  return { files, hashes: Object.fromEntries(files.map(([name, content]) => [name, hash(content)])) };
}

export async function prepareHostExecution(config: WorkerConfig, job: RunJob): Promise<{ descriptor: Record<string, unknown>; resources: ResourceSnapshot }> {
  const resources = await snapshotResources(config);
  // 可选 MCP 加载必须保留 Agent 的 fail-open 行为；接纳已有运行时前，
  // 仍需通过发现流程检查实际可用的工具。
  let mcpConfigHash: string | null = null;
  if (config.MCP_CONFIG_PATH) {
    try {
      const raw = await readFile(config.MCP_CONFIG_PATH, 'utf8');
      mcpConfigHash = hash(stableJson(nonSecretConfig(JSON.parse(raw))));
    } catch { /* Missing/unreadable/invalid config disables optional MCP. */ }
  }
  const knowledgeEnabled = config.KNOWLEDGE_MCP_ENABLED && Boolean(config.KNOWLEDGE_MCP_URL && config.KNOWLEDGE_MCP_SECRET) && job.knowledgeBaseIds.length > 0;
  return {
    resources,
    descriptor: {
      workerRuntimeVersion: 'chat-worker-execution-v1',
      agent: buildRuntimeStaticDescriptor(),
      models: config.models.map(({ id, model, provider, baseUrl, maxTokens }) => ({ id, model, provider, baseUrl: baseUrl ? publicUrl(baseUrl) : null, maxTokens: maxTokens ?? null })),
      // 审批是持久化续跑中的可变用户输入，不属于部署身份。
      // 重放安全性仍由独立且不可变的可信策略决定。
      policies: { toolReplayPolicies: config.toolReplayPolicies },
      limits: { recursion: config.AGENT_RECURSION_LIMIT, modelCalls: config.AGENT_MODEL_CALL_LIMIT, summarizationTrigger: config.AGENT_SUMMARIZATION_TRIGGER_TOKENS, summarizationKeep: config.AGENT_SUMMARIZATION_KEEP_TOKENS, truncateArgsTokens: 40_000 },
      sandbox: config.SANDBOX_RUNTIME === 'docker'
        ? { runtime: 'docker', image: config.DOCKER_SANDBOX_IMAGE, workspacePath: config.DOCKER_SANDBOX_WORKSPACE_PATH, commandTimeoutMs: config.DOCKER_SANDBOX_COMMAND_TIMEOUT_MS }
        : { runtime: 'e2b', template: config.E2B_TEMPLATE, workspacePath: config.E2B_WORKSPACE_PATH, apiUrl: config.E2B_API_URL ? publicUrl(config.E2B_API_URL) : null, sandboxUrl: config.E2B_SANDBOX_URL ? publicUrl(config.E2B_SANDBOX_URL) : null },
      resourceHashes: resources.hashes,
      mcpConfigHash,
      knowledgeMcp: { enabled: knowledgeEnabled, url: config.KNOWLEDGE_MCP_URL ? publicUrl(config.KNOWLEDGE_MCP_URL) : null, timeoutMs: config.KNOWLEDGE_MCP_TIMEOUT_MS },
    },
  };
}

export async function buildHostExecutionDescriptor(config: WorkerConfig, job: RunJob): Promise<Record<string, unknown>> {
  return (await prepareHostExecution(config, job)).descriptor;
}

/** 上传获取沙箱前已计算指纹的原始字节。 */
export async function uploadPreparedAgentResources(sandbox: RemoteWorkspaceSandbox, workspace: string, resources: ResourceSnapshot): Promise<AgentResources> {
  const files: Array<[string, Uint8Array]> = resources.files.map(([name, content]) => [path.posix.join(workspace, name), content]);
  if (files.length > 0) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const directories = [...new Set(files.map(([name]) => path.posix.dirname(name)))];
    const result = await sandbox.execute(`mkdir -p -- ${directories.map(quote).join(' ')}`);
    if (result.exitCode !== 0) throw new Error(result.output.trim() || 'Unable to prepare agent resources');
    const uploaded = await sandbox.uploadFiles(files);
    const failed = uploaded.find((file) => file.error);
    if (failed) throw new Error(`Unable to upload agent resource ${failed.path}: ${failed.error}`);
  }
  return {
    memory: resources.hashes['.deepagents/AGENTS.md'] ? [path.posix.join(workspace, '.deepagents/AGENTS.md')] : [],
    skills: Object.keys(resources.hashes).some((name) => name.startsWith('.deepagents/skills/')) ? [path.posix.join(workspace, '.deepagents/skills')] : [],
  };
}

export function compatibilityFailure(error: unknown): { code: 'RECOVERY_INCOMPATIBLE' | 'RECOVERY_DESCRIPTOR_MISSING'; message: string } | null {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === 'RECOVERY_INCOMPATIBLE' || candidate.code === 'RECOVERY_DESCRIPTOR_MISSING') {
      return { code: candidate.code, message: typeof candidate.message === 'string' ? candidate.message : 'The saved execution is incompatible with this runtime.' };
    }
    error = candidate.cause;
  }
  return null;
}
