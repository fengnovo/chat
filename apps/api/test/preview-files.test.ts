import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPreviewFile } from '../src/preview-files.js';

test('selected build root never falls back to workspace source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-root-'));
  const workspace = path.join(root, 'id', 'user-data', 'workspace');
  try {
    await mkdir(path.join(workspace, 'dist'), { recursive: true });
    await writeFile(path.join(workspace, 'dist', 'index.html'), 'BUILT');
    await writeFile(path.join(workspace, 'index.html'), 'SOURCE');
    await writeFile(path.join(workspace, '.env'), 'PRIVATE');
    await writeFile(path.join(workspace, 'dist', 'asset.js'), 'ASSET');
    assert.equal((await readPreviewFile(root, 'id', 'index.html')).toString(), 'BUILT');
    assert.equal((await readPreviewFile(root, 'id', 'asset.js')).toString(), 'ASSET');
    await assert.rejects(readPreviewFile(root, 'id', '.env'), (error: unknown) => (error as { status: number }).status === 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selected nested build does not fall back to another project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-nested-'));
  const workspace = path.join(root, 'id', 'user-data', 'workspace');
  try {
    for (const name of ['a', 'b']) {
      await mkdir(path.join(workspace, name, 'dist'), { recursive: true });
      await writeFile(path.join(workspace, name, 'dist', 'index.html'), name);
    }
    await writeFile(path.join(workspace, 'b', 'dist', 'other.js'), 'OTHER');
    assert.equal((await readPreviewFile(root, 'id', '')).toString(), 'a');
    await assert.rejects(readPreviewFile(root, 'id', 'other.js'), (error: unknown) => (error as { status: number }).status === 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
