import path from 'node:path';

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

function safeRelativePath(relativePath: string): string {
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
    throw new Error('E2B workspace path must be absolute');
  }
  return path.posix.resolve('/', configuredPath);
}

async function checkedExecute(sandbox: RemoteWorkspaceSandbox, command: string): Promise<string> {
  const result = await sandbox.execute(command);
  if (result.exitCode !== 0) throw new Error(result.output.trim() || `Command failed: ${command}`);
  return result.output;
}

export async function prepareWorkspace(
  sandbox: RemoteWorkspaceSandbox,
  workspace: string,
  source: WorkspaceSource | undefined,
  loadUpload: (objectKey: string) => Promise<Uint8Array>,
  initializeSource: boolean,
): Promise<string> {
  await checkedExecute(sandbox, `mkdir -p -- ${shellQuote(workspace)}`);
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
