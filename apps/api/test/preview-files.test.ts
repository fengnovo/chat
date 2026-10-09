import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPreviewFile } from '../src/preview-files.js';

test('production preview stays contained during directory replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-race-'));
  const workspace = path.join(root, 'id', 'user-data', 'workspace');
  const outside = path.join(root, 'outside');
  try {
    await mkdir(path.join(workspace, 'dist'), {recursive:true});
    await mkdir(outside);
    await writeFile(path.join(workspace, 'dist', 'index.html'), 'SAFE');
    await writeFile(path.join(outside, 'index.html'), 'PRIVATE_OUTSIDE');
    if (process.platform !== 'linux') {
      await assert.rejects(readPreviewFile(root, 'id', 'index.html', true), (error: unknown) => (error as {status:number}).status === 503);
      return;
    }
    assert.equal((await readPreviewFile(root, 'id', 'index.html', true)).toString(), 'SAFE');
    let stopped = false;
    const mutate = (async () => {
      for (let i = 0; i < 100 && !stopped; i++) {
        await rename(workspace, `${workspace}-held`);
        await symlink(outside, workspace);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await rm(workspace);
        await rename(`${workspace}-held`, workspace);
      }
    })();
    try {
      for (let i = 0; i < 100; i++) {
        let content: Buffer;
        try { content = await readPreviewFile(root, 'id', 'index.html', true); }
        catch { continue; } // Missing/replaced paths must fail closed.
        assert.equal(content.toString(), 'SAFE');
      }
    } finally { stopped = true; await mutate; }
  } finally { await rm(root, {recursive:true,force:true}); }
});
test('preview refuses a file larger than its byte budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-bytes-'));
  const workspace = path.join(root, 'id', 'user-data', 'workspace', 'dist');
  try {
    await mkdir(workspace, {recursive:true});
    await writeFile(path.join(workspace,'index.html'),'safe');
    await writeFile(path.join(workspace,'large.bin'),'');
    await truncate(path.join(workspace,'large.bin'),21 * 1024 * 1024);
    await assert.rejects(readPreviewFile(root,'id','large.bin'),(error: unknown) => (error as {status:number}).status === 413);
  } finally { await rm(root,{recursive:true,force:true}); }
});
