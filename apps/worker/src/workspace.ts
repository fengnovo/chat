import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type { WorkspaceSource } from '@repo/contracts';
import { z } from 'zod';

const projectManifestSchema = z.object({
  version: z.literal(1),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1_000),
        contentBase64: z.string().min(1),
      }),
    )
    .min(1)
    .max(1_000),
});

export interface RemoteWorkspaceSandbox {
  execute(command: string): Promise<{ output: string; exitCode: number | null }>;
  uploadFiles(files: Array<[string, Uint8Array]>): Promise<Array<{ path: string; error: string | null }>>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function safeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`Uploaded file path is unsafe: ${relativePath}`);
  }
  return normalized;
}

export function remoteWorkspacePath(configuredPath: string): string {
  if (!configuredPath.startsWith('/') || configuredPath.includes('\0')) {
    throw new Error('Sandbox workspace path must be absolute');
  }
  return path.posix.resolve('/', configuredPath);
}

async function checkedExecute(sandbox: RemoteWorkspaceSandbox, command: string): Promise<string> {
  const result = await sandbox.execute(command);
  if (result.exitCode !== 0) throw new Error(result.output.trim() || `Command failed: ${command}`);
  return result.output;
}

/** 镜像内预装的离线 React/Vite 依赖，沙箱无网络时唯一的依赖来源。 */
const OFFLINE_WEB_RUNTIME = '/opt/chat-web-runtime/node_modules';

/**
 * 把离线 Web 运行时接到工作区，让子目录里的项目能向上解析到依赖。
 * 必须建真实目录再逐包软链：整体软链会让 vite 无法写 node_modules/.vite-temp，
 * 构建会以 ENOENT 失败（这正是 Agent 之前反复重写文件的原因之一）。
 * 已存在则跳过，避免覆盖 Agent 自己准备的依赖。
 */
async function linkOfflineWebRuntime(
  sandbox: RemoteWorkspaceSandbox,
  workspace: string,
): Promise<void> {
  if (!workspace.startsWith('/')) return;
  const nodeModules = `${workspace}/node_modules`;
  const script = [
    `if [ -d ${shellQuote(OFFLINE_WEB_RUNTIME)} ] && [ ! -e ${shellQuote(nodeModules)} ]; then`,
    `  mkdir -p ${shellQuote(nodeModules)}/.bin &&`,
    `  for p in ${shellQuote(OFFLINE_WEB_RUNTIME)}/*; do [ -e "$p" ] || continue; ln -sfn "$p" ${shellQuote(nodeModules)}/"$(basename "$p")"; done &&`,
    `  for b in ${shellQuote(OFFLINE_WEB_RUNTIME)}/.bin/*; do [ -e "$b" ] || continue; ln -sfn "$b" ${shellQuote(nodeModules)}/.bin/"$(basename "$b")"; done`,
    `fi`,
  ].join('\n');
  await sandbox.execute(script);
}

export async function prepareWorkspace(
  sandbox: RemoteWorkspaceSandbox,
  workspace: string,
  source: WorkspaceSource | undefined,
  loadUpload: (objectKey: string) => Promise<Uint8Array>,
  initializeSource: boolean,
): Promise<string> {
  await checkedExecute(sandbox, `mkdir -p -- ${shellQuote(workspace)}`);
  await linkOfflineWebRuntime(sandbox, workspace);
  if (!initializeSource || !source || source.type === 'empty') return workspace;

  const listing = await checkedExecute(
    sandbox,
    `if [ -z "$(ls -A -- ${shellQuote(workspace)})" ]; then printf empty; else printf populated; fi`,
  );
  if (listing !== 'empty') return workspace;

  if (source.type === 'git') {
    const branch = source.ref ? ` --branch ${shellQuote(source.ref)}` : '';
    await checkedExecute(
      sandbox,
      `git -c credential.helper= -c core.askPass= clone --depth 1 --single-branch${branch} -- ${shellQuote(source.url)} ${shellQuote(`${workspace}/.restore`)}` +
        ` && cp -a -- ${shellQuote(`${workspace}/.restore/.`)} ${shellQuote(workspace)}` +
        ` && rm -rf -- ${shellQuote(`${workspace}/.restore`)}`,
    );
    return workspace;
  }

  const snapshot = await loadUpload(source.objectKey);
  const manifest = projectManifestSchema.parse(JSON.parse(Buffer.from(snapshot).toString('utf8')));
  const files: Array<[string, Uint8Array]> = manifest.files.map((file) => [
    path.posix.join(workspace, safeRelativePath(file.path)),
    Buffer.from(file.contentBase64, 'base64'),
  ]);
  const directories = [...new Set(files.map(([filePath]) => path.posix.dirname(filePath)))];
  if (directories.length > 0) {
    await checkedExecute(sandbox, `mkdir -p -- ${directories.map(shellQuote).join(' ')}`);
  }
  const results = await sandbox.uploadFiles(files);
  const failed = results.find((result) => result.error);
  if (failed) throw new Error(`Upload restore failed for ${failed.path}: ${failed.error}`);
  return workspace;
}

export type AgentResources = {
  skills: string[];
  memory: string[];
};

/**
 * 把宿主机的 DeepAgents memory/skills 文件上传到沙箱。
 * 与 CLI 的 uploadAgentResources 逻辑一致：memory 上传到 .deepagents/AGENTS.md，
 * skills 上传到 .deepagents/skills 子目录下的 SKILL.md。
 */
export async function uploadAgentResources(
  sandbox: RemoteWorkspaceSandbox,
  workspace: string,
  memoryHostFile: string | undefined,
  skillsHostDir: string | undefined,
): Promise<AgentResources> {
  const files: Array<[string, Uint8Array]> = [];
  const memoryPath = path.posix.join(workspace, '.deepagents/AGENTS.md');
  if (memoryHostFile && existsSync(memoryHostFile)) {
    files.push([memoryPath, await readFile(memoryHostFile)]);
  }

  const skillRoot = path.posix.join(workspace, '.deepagents/skills');
  if (skillsHostDir && existsSync(skillsHostDir)) {
    for (const entry of await readdir(skillsHostDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(skillsHostDir, entry.name, 'SKILL.md');
      if (!existsSync(source)) continue;
      files.push([path.posix.join(skillRoot, entry.name, 'SKILL.md'), await readFile(source)]);
    }
  }

  if (files.length > 0) {
    const directories = [...new Set(files.map(([filePath]) => path.posix.dirname(filePath)))];
    await checkedExecute(
      sandbox,
      `mkdir -p -- ${directories.map(shellQuote).join(' ')}`,
    );
    const uploaded = await sandbox.uploadFiles(files);
    const failed = uploaded.find((result) => result.error);
    if (failed) throw new Error(`无法上传 Agent 配置：${failed.path} (${failed.error})`);
  }

  return {
    skills: files.some(([filePath]) => filePath.startsWith(`${skillRoot}/`)) ? [skillRoot] : [],
    memory: files.some(([filePath]) => filePath === memoryPath) ? [memoryPath] : [],
  };
}
