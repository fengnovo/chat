import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function ensureWorkspace(root: string, requestedPath: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(requestedPath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Workspace path escapes WORKSPACE_ROOT');
  }
  await mkdir(resolvedPath, { recursive: true, mode: 0o700 });
  const [realRoot, realWorkspace] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolvedPath),
  ]);
  if (realWorkspace !== realRoot && !realWorkspace.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Workspace symlink escapes WORKSPACE_ROOT');
  }
  return realWorkspace;
}
