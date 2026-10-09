import { constants } from 'node:fs';
import { open, lstat, opendir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
export class PreviewFileError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function validatePreviewMount(sessionsRoot: string, workspaceId: string): Promise<string> {
  parts(workspaceId);
  if (!workspaceId || workspaceId.includes('/')) throw new PreviewFileError(403, 'forbidden');
  const base = await realpath(sessionsRoot);
  // Mount the provisioner-owned user-data root, never an agent-writable child
  // path that Docker could resolve through a symlink into the host filesystem.
  const relative = `${workspaceId}/user-data`;
  const directory = await secureOpen(base, relative, true);
  await directory.close();
  return path.join(base, relative);
}
function parts(relative: string): string[] {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new PreviewFileError(403, 'forbidden');
  const result = relative.split('/').filter(Boolean);
  if (result.some((part) => part === '..' || part === '.')) throw new PreviewFileError(403, 'forbidden');
  return result;
}
async function secureOpen(base: string, relative: string, directory = false): Promise<FileHandle> {
  const segments = parts(relative);
  const held: FileHandle[] = [];
  try {
    const root = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    held.push(root);
    let filename = base;
    for (let i = 0; i < segments.length; i++) {
      const isDirectory = directory || i < segments.length - 1;
      filename = path.join(filename, segments[i]!);
      const anchored = process.platform === 'linux' ? `/proc/self/fd/${held.at(-1)!.fd}/${segments[i]}` : filename;
      const handle = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
      held.push(handle);
      // On development macOS, reject symlink ancestors and verify the opened inode.
      if (process.platform !== 'linux') {
        const info = await lstat(filename);
        const opened = await handle.stat();
        if (info.isSymbolicLink() || info.ino !== opened.ino || info.dev !== opened.dev) throw new PreviewFileError(403, 'forbidden');
      }
    }
    return held.pop()!;
  } catch (error) {
    if (error instanceof PreviewFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new PreviewFileError(['ELOOP', 'ENOTDIR', 'EACCES'].includes(code ?? '') ? 403 : 404, 'preview_file_unavailable');
  } finally { await Promise.all(held.map((handle) => handle.close())); }
}
async function readBounded(base: string, relative: string) {
  const file = await secureOpen(base, relative);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new PreviewFileError(404, 'not_found');
    if (info.size > MAX_PREVIEW_BYTES) throw new PreviewFileError(413, 'preview_file_too_large');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= MAX_PREVIEW_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_PREVIEW_BYTES + 1 - bytes));
      const read = await file.read(chunk);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > MAX_PREVIEW_BYTES) throw new PreviewFileError(413, 'preview_file_too_large');
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await file.close(); }
}
export async function readPreviewFile(sessionsRoot: string, workspaceId: string, requested: string, production = false) {
  if (production && process.platform !== 'linux') throw new PreviewFileError(503, 'secure_preview_requires_linux');
  parts(requested); parts(workspaceId);
  if (!workspaceId || workspaceId.includes('/')) throw new PreviewFileError(403, 'forbidden');
  const base = await realpath(sessionsRoot);
  const workspace = `${workspaceId}/user-data/workspace`;
  for (const candidate of [`${workspace}/dist`, workspace]) {
    let isFile: boolean;
    try {
      const index = await secureOpen(base, `${candidate}/index.html`);
      try { isFile = (await index.stat()).isFile(); } finally { await index.close(); }
    } catch (error) {
      if (!(error instanceof PreviewFileError) || error.status !== 404) throw error;
      continue;
    }
    // Once an entry point selects the root, missing assets must stay 404.
    if (isFile) return readBounded(base, `${candidate}/${requested || 'index.html'}`);
  }
  const directory = await secureOpen(base, workspace, true);
  const names: string[] = [];
  try {
    const entries = await opendir(process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : path.join(base, workspace));
    let scanned = 0;
    for await (const entry of entries) {
      if (++scanned > 128) throw new PreviewFileError(413, 'preview_directory_limit');
      if (entry.isDirectory()) names.push(entry.name);
    }
  } finally { await directory.close(); }
  const candidates = names.sort().map((name) => `${workspace}/${name}/dist`);
  for (const candidate of candidates) {
    try {
      await readBounded(base, `${candidate}/index.html`);
    } catch (error) {
      if (!(error instanceof PreviewFileError) || error.status !== 404) throw error;
      continue;
    }
    return readBounded(base, `${candidate}/${requested || 'index.html'}`);
  }
  throw new PreviewFileError(404, 'no_preview_built');
}
