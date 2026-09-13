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

test('remote workspace path must be an absolute sandbox path', () => {
  assert.equal(remoteWorkspacePath('/mnt/user-data/workspace'), '/mnt/user-data/workspace');
  assert.throws(() => remoteWorkspacePath('../../escape'));
  assert.throws(() => remoteWorkspacePath('/mnt/user-data/workspace\0escape'));
});

test('uploaded project manifest is restored through sandbox upload', async () => {
  const sandbox = new FakeSandbox();
  const snapshot = Buffer.from(JSON.stringify({
    version: 1,
    files: [{ path: 'src/index.ts', contentBase64: Buffer.from('ready').toString('base64') }],
  }));
  await prepareWorkspace(
    sandbox,
    '/mnt/user-data/workspace',
    { type: 'upload', objectKey: 'snapshot' },
    async () => snapshot,
    true,
  );
  assert.equal(
    Buffer.from(sandbox.files.get('/mnt/user-data/workspace/src/index.ts')!).toString(),
    'ready',
  );
});

test('git clone executes inside the sandbox and resume does not initialize source again', async () => {
  const sandbox = new FakeSandbox();
  await prepareWorkspace(
    sandbox,
    '/mnt/user-data/workspace',
    { type: 'git', url: 'https://example.test/repo.git', ref: 'main' },
    async () => new Uint8Array(),
    true,
  );
  assert.ok(sandbox.commands.some((command) => command.includes('git -c credential.helper=')));
  sandbox.commands.length = 0;
  await prepareWorkspace(
    sandbox,
    '/mnt/user-data/workspace',
    { type: 'git', url: 'https://example.test/repo.git' },
    async () => new Uint8Array(),
    false,
  );
  // 恢复时不应再次 clone，只做目录准备与离线运行时接入。
  assert.equal(sandbox.commands.some((command) => command.includes(' clone ')), false);
});

test('offline web runtime is linked into the workspace so builds resolve deps', async () => {
  const sandbox = new FakeSandbox();
  await prepareWorkspace(
    sandbox,
    '/mnt/user-data/workspace',
    { type: 'empty' },
    async () => new Uint8Array(),
    true,
  );
  const linkCommand = sandbox.commands.find((command) =>
    command.includes('/opt/chat-web-runtime/node_modules'),
  );
  assert.ok(linkCommand, 'expected an offline runtime link step');
  // 必须是真实目录 + 逐包软链：整体软链会让 vite 无法写 .vite-temp。
  assert.ok(linkCommand.includes('mkdir -p'));
  assert.ok(linkCommand.includes('ln -sfn'));
  assert.ok(linkCommand.includes('/.bin'));
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
      '/mnt/user-data/workspace',
      { type: 'upload', objectKey: 'snapshot' },
      async () => snapshot,
      true,
    ));
  });
}
