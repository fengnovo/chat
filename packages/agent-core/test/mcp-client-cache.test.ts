import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  closeSharedMcpClients,
  getSharedMcpToolsForConfigPath,
  type SharedMcpCacheOptions,
  type SharedMcpClientLike,
} from '../src/index.js';

interface FakeClient extends SharedMcpClientLike {
  closed: boolean;
}

function createFakeFactory() {
  const created: FakeClient[] = [];
  let shouldFail = false;
  const factory = (config: Record<string, unknown>): SharedMcpClientLike => {
    const toolNames = Array.isArray(config.tools) ? config.tools.map(String) : [];
    const client: FakeClient = {
      closed: false,
      getTools: async () => {
        if (shouldFail) throw new Error('connect failed');
        return toolNames.map((name) => ({ name })) as never;
      },
      close: async () => {
        client.closed = true;
      },
    };
    created.push(client);
    return client;
  };
  return {
    factory,
    created,
    failNextConnections: () => {
      shouldFail = true;
    },
    allowConnections: () => {
      shouldFail = false;
    },
  };
}

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mcp-cache-test-'));
});

after(async () => {
  await closeSharedMcpClients();
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, tools: string[]): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify({ mcpServers: {}, tools }));
  return file;
}

function optsWith(factoryOpts: Partial<SharedMcpCacheOptions>): SharedMcpCacheOptions {
  return factoryOpts as SharedMcpCacheOptions;
}

test('reuses the shared client for the same config content', async () => {
  const { factory, created } = createFakeFactory();
  const file = await writeConfig('same.json', ['t1']);
  await closeSharedMcpClients();

  const first = await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));
  const second = await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));

  assert.equal(created.length, 1, 'second call must not build a new client');
  assert.equal(first.tools.length, 1);
  assert.deepEqual(second.tools, first.tools);
  assert.match(first.status, /\(shared\)/);
});

test('rebuilds the client when the config file content changes', async () => {
  const { factory, created } = createFakeFactory();
  const file = await writeConfig('evolving.json', ['t1']);
  await closeSharedMcpClients();

  await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));
  await writeFile(file, JSON.stringify({ mcpServers: {}, tools: ['t1', 't2'] }));
  const second = await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));

  assert.equal(created.length, 2, 'changed content must invalidate the cache entry');
  assert.equal(second.tools.length, 2);
});

test('does not cache failed connections and allows retry', async () => {
  const { factory, created, failNextConnections, allowConnections } = createFakeFactory();
  const file = await writeConfig('failing.json', ['t1']);
  await closeSharedMcpClients();

  failNextConnections();
  await assert.rejects(
    getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory })),
    /connect failed/,
  );

  allowConnections();
  const recovered = await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));
  assert.equal(created.length, 2, 'failed entry must not stay in the cache');
  assert.equal(recovered.tools.length, 1);
});

test('reconnects after closeSharedMcpClients', async () => {
  const { factory, created } = createFakeFactory();
  const file = await writeConfig('closing.json', ['t1']);
  await closeSharedMcpClients();

  await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));
  await closeSharedMcpClients();
  assert.equal(created[0]?.closed, true, 'close must close all live shared clients');

  await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }));
  assert.equal(created.length, 2);
});

test('single-flights concurrent calls into one connection', async () => {
  const { factory, created } = createFakeFactory();
  const file = await writeConfig('concurrent.json', ['t1']);
  await closeSharedMcpClients();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory }))),
  );

  assert.equal(created.length, 1, 'concurrent calls must share a single connection attempt');
  assert.equal(results.length, 10);
});

test('rebuilds expired entries lazily and closes the stale client', async () => {
  const { factory, created } = createFakeFactory();
  const file = await writeConfig('ttl.json', ['t1']);
  await closeSharedMcpClients();

  let clock = 1_000;
  await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory, ttlMs: 5_000, now: () => clock }));
  assert.equal(created.length, 1);

  clock = 6_001;
  const rebuilt = await getSharedMcpToolsForConfigPath(file, optsWith({ clientFactory: factory, ttlMs: 5_000, now: () => clock }));

  assert.equal(created.length, 2, 'expired entry must be rebuilt');
  assert.equal(created[0]?.closed, true, 'stale client must be closed on rebuild');
  assert.match(rebuilt.status, /rebuilt/);
});
