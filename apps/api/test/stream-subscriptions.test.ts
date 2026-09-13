import assert from 'node:assert/strict';
import test from 'node:test';

import type { Redis } from 'ioredis';

import { StreamSubscriptionHub } from '../src/stream-subscriptions.js';

interface FakeSubscriber {
  handlers: Map<string, (...args: unknown[]) => void>;
  connected: boolean;
  subscribed: boolean;
  quitted: boolean;
  failOnConnect: boolean;
}

const createdSubscribers: FakeSubscriber[] = [];

function makeRedis(fake: FakeSubscriber): Redis {
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      fake.handlers.set(event, handler);
    },
    async connect() {
      fake.connected = true;
      if (fake.failOnConnect) throw new Error('redis connect failed');
    },
    async subscribe() {
      fake.subscribed = true;
    },
    async quit() {
      fake.quitted = true;
      return 'OK';
    },
  } as unknown as Redis;
}

function createFake(failOnConnect = false): Redis {
  const fake: FakeSubscriber = {
    handlers: new Map(),
    connected: false,
    subscribed: false,
    quitted: false,
    failOnConnect,
  };
  createdSubscribers.push(fake);
  return makeRedis(fake);
}

test('subscribers to the same channel share one redis connection', async () => {
  createdSubscribers.length = 0;
  const hub = new StreamSubscriptionHub(() => createFake());
  const seen: string[] = [];
  const unsubscribeA = await hub.subscribe('agent:run:1:events', () =>
    seen.push('a'),
  );
  const unsubscribeB = await hub.subscribe('agent:run:1:events', () =>
    seen.push('b'),
  );

  assert.equal(createdSubscribers.length, 1, 'one connection for a shared channel');
  const entry = createdSubscribers[0];
  assert.ok(entry, 'a subscriber was created');
  assert.equal(entry.subscribed, true);

  // 模拟 Redis message 事件：所有监听者都要收到通知。
  entry.handlers.get('message')?.();

  assert.deepEqual(seen, ['a', 'b']);

  unsubscribeA();
  unsubscribeB();
  await Promise.resolve();
  assert.equal(entry.quitted, true, 'last listener quits the connection');
  await hub.closeAll();
});

test('a failed subscribe does not leak a half-initialized connection', async () => {
  createdSubscribers.length = 0;
  const hub = new StreamSubscriptionHub(() => createFake(true));

  await assert.rejects(
    () => hub.subscribe('agent:run:2:events', () => {}),
    /redis connect failed/,
  );

  const entry = createdSubscribers.at(-1);
  assert.ok(entry, 'a subscriber was created');
  await hub.closeAll();
  assert.equal(
    entry.quitted,
    true,
    'a connect failure must quit the dangling connection',
  );
});
