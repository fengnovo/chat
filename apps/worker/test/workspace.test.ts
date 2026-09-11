import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ensureWorkspace, prepareWorkspace } from '../src/workspace.js';

const run = promisify(execFile);

test('workspace paths cannot escape the configured root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-'));
  try {
    await assert.rejects(() => ensureWorkspace(root, path.join(root, '..', 'escape')));
    const workspace = await ensureWorkspace(root, path.join(root, 'tenant', 'session'));
    assert.ok(workspace.startsWith(await realpath(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uploaded project files are restored inside a fresh workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-upload-'));
  try {
    const workspace = path.join(root, 'tenant', 'session');
    const snapshot = Buffer.from(
      JSON.stringify({
        version: 1,
        files: [
          {
            path: 'src/index.ts',
            contentBase64: Buffer.from('export const ready = true;').toString('base64'),
          },
        ],
      }),
    );
    await prepareWorkspace(
      root,
      workspace,
      { type: 'upload', objectKey: 'snapshot' },
      async () => snapshot,
    );
    assert.equal(
      await readFile(path.join(workspace, 'src/index.ts'), 'utf8'),
      'export const ready = true;',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uploaded project paths cannot escape the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-upload-'));
  try {
    const snapshot = Buffer.from(
      JSON.stringify({
        version: 1,
        files: [
          {
            path: '../escape.txt',
            contentBase64: Buffer.from('nope').toString('base64'),
          },
        ],
      }),
    );
    await assert.rejects(() =>
      prepareWorkspace(
        root,
        path.join(root, 'tenant', 'session'),
        { type: 'upload', objectKey: 'snapshot' },
        async () => snapshot,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('git projects are cloned into the workspace root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-git-'));
  try {
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(
      path.join(source, 'src/index.ts'),
      "export const marker = 'git-clone-ok';\n",
    );
    await run('git', ['init', '--initial-branch=main'], { cwd: source });
    await run('git', ['add', '.'], { cwd: source });
    await run(
      'git',
      [
        '-c',
        'user.name=Agent Test',
        '-c',
        'user.email=agent@example.test',
        'commit',
        '-m',
        'fixture',
      ],
      { cwd: source },
    );

    const workspace = path.join(root, 'tenant', 'session');
    await prepareWorkspace(
      root,
      workspace,
      { type: 'git', url: source, ref: 'main' },
      async () => new Uint8Array(),
    );
    assert.equal(
      await readFile(path.join(workspace, 'src/index.ts'), 'utf8'),
      "export const marker = 'git-clone-ok';\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
