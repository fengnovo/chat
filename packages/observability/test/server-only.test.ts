import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the package entrypoint resolves in Node and refuses the browser condition', () => {
  const args = ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e',
    'const sdk = await import("@repo/observability"); if (typeof sdk.startObservability !== "function") process.exit(2);'];
  const options = { cwd: new URL('../', import.meta.url), encoding: 'utf8' as const };
  const server = spawnSync(process.execPath, args, options);
  assert.equal(server.status, 0, server.stderr);
  const browser = spawnSync(process.execPath, ['--conditions=browser', ...args], options);
  assert.notEqual(browser.status, 0, 'browser consumers must not load the server SDK');
  assert.match(browser.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
