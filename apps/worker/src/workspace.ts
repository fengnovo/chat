import { spawn } from 'node:child_process';
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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

export async function ensureWorkspace(
  root: string,
  requestedPath: string,
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(requestedPath);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error('Workspace path escapes WORKSPACE_ROOT');
  }
  await mkdir(resolvedPath, { recursive: true, mode: 0o700 });
  const [realRoot, realWorkspace] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolvedPath),
  ]);
  if (
    realWorkspace !== realRoot &&
    !realWorkspace.startsWith(`${realRoot}${path.sep}`)
  ) {
    throw new Error('Workspace symlink escapes WORKSPACE_ROOT');
  }
  return realWorkspace;
}

function safeUploadPath(workspace: string, relativePath: string) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Uploaded file path is unsafe: ${relativePath}`);
  }
  const target = path.resolve(workspace, normalized);
  if (!target.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Uploaded file path escapes workspace: ${relativePath}`);
  }
  return target;
}

async function cloneRepository(
  workspace: string,
  source: Extract<WorkspaceSource, { type: 'git' }>,
  signal?: AbortSignal,
) {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (source.ref) args.push('--branch', source.ref);
  args.push('--', source.url, '.');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-4_000);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Git clone timed out'));
    }, 120_000);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Workspace preparation cancelled'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Git clone failed: ${errorOutput.trim() || `exit ${code}`}`),
        );
      }
    });
  });
}

async function restoreUpload(workspace: string, snapshot: Uint8Array) {
  const manifest = projectManifestSchema.parse(
    JSON.parse(Buffer.from(snapshot).toString('utf8')),
  );
  for (const file of manifest.files) {
    const target = safeUploadPath(workspace, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'), {
      mode: 0o600,
    });
  }
}

export async function prepareWorkspace(
  root: string,
  requestedPath: string,
  source: WorkspaceSource | undefined,
  loadUpload: (objectKey: string) => Promise<Uint8Array>,
  signal?: AbortSignal,
) {
  const workspace = await ensureWorkspace(root, requestedPath);
  if (
    !source ||
    source.type === 'empty' ||
    (await readdir(workspace)).length > 0
  ) {
    return workspace;
  }

  try {
    if (source.type === 'git') {
      await cloneRepository(workspace, source, signal);
    } else {
      await restoreUpload(workspace, await loadUpload(source.objectKey));
    }
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    throw error;
  }
}
