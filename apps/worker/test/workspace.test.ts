import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureWorkspace } from '../src/workspace.js';

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
