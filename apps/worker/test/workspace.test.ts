import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareWorkspace, remoteWorkspacePath, type RemoteWorkspaceSandbox } from '../src/workspace.js';

class FakeSandbox implements RemoteWorkspaceSandbox {
  commands: string[] = [];
  files = new Map<string, Uint8Array>();
  populated = false;

  async execute(command: string) {
    this.commands.push(command);
    if (command.startsWith('if [ -z')) {
      return { output: this.populated ? 'populated' : 'empty', exitCode: 0 };
    }
    if (command.includes(' clone ')) this.populated = true;
    return { output: '', exitCode: 0 };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    for (const [filePath, content] of files) this.files.set(filePath, content);
    this.populated = true;
    return files.map(([filePath]) => ({ path: filePath, error: null }));
  }
}

test('remote workspace path must be an absolute E2B path', () => {
  assert.equal(remoteWorkspacePath('/home/user/workspace'), '/home/user/workspace');
  assert.throws(() => remoteWorkspacePath('../../escape'));
  assert.throws(() => remoteWorkspacePath('/home/user/workspace\0escape'));
});

test('uploaded project manifest is restored through sandbox upload', async () => {
  const sandbox = new FakeSandbox();
  const snapshot = Buffer.from(JSON.stringify({
    version: 1,
    files: [{ path: 'src/index.ts', contentBase64: Buffer.from('ready').toString('base64') }],
  }));
  await prepareWorkspace(
    sandbox,
    '/home/user/workspaces/session',
    { type: 'upload', objectKey: 'snapshot' },
    async () => snapshot,
    true,
  );
  assert.equal(
    Buffer.from(sandbox.files.get('/home/user/workspaces/session/src/index.ts')!).toString(),
    'ready',
  );
});

test('git clone executes inside E2B and resume does not initialize source again', async () => {
  const sandbox = new FakeSandbox();
  await prepareWorkspace(
    sandbox,
    '/home/user/workspaces/session',
    { type: 'git', url: 'https://example.test/repo.git', ref: 'main' },
    async () => new Uint8Array(),
    true,
  );
  assert.ok(sandbox.commands.some((command) => command.includes('git -c credential.helper=')));
  const commandCount = sandbox.commands.length;
  await prepareWorkspace(
    sandbox,
    '/home/user/workspaces/session',
    { type: 'git', url: 'https://example.test/repo.git' },
    async () => new Uint8Array(),
    false,
  );
  assert.equal(sandbox.commands.length, commandCount + 1);
});

for (const unsafePath of ['../escape', '/absolute', 'src/../escape', 'src\0escape']) {
  test(`unsafe uploaded path is rejected: ${JSON.stringify(unsafePath)}`, async () => {
    const sandbox = new FakeSandbox();
    const snapshot = Buffer.from(JSON.stringify({
      version: 1,
      files: [{ path: unsafePath, contentBase64: Buffer.from('no').toString('base64') }],
    }));
    await assert.rejects(() => prepareWorkspace(
      sandbox,
      '/home/user/workspaces/session',
      { type: 'upload', objectKey: 'snapshot' },
      async () => snapshot,
      true,
    ));
  });
}
