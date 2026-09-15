import assert from 'node:assert/strict';
import test from 'node:test';

import { withSessionLock } from '../src/lock.js';
import { RedisCircuitBreakerStore } from '../src/redis-circuit-breaker.js';

type CircuitEvent = { model: string; state: string };

class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private keys = new Map<string, string>();

  private hash(key: string): Map<string, string> {
    let entry = this.hashes.get(key);
    if (!entry) {
      entry = new Map();
      this.hashes.set(key, entry);
    }
    return entry;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hincrby(key: string, field: string, amount: number): Promise<number> {
    const entry = this.hash(key);
    const next = Number(entry.get(field) ?? 0) + amount;
    entry.set(field, String(next));
    return next;
  }

  async hset(key: string, field: string, value: string | number): Promise<number> {
    this.hash(key).set(field, String(value));
    return 1;
  }

  async set(key: string, value: string): Promise<'OK' | null> {
    if (this.keys.has(key)) return null;
    this.keys.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.keys.delete(key)) removed += 1;
      if (this.hashes.delete(key)) removed += 1;
    }
    return removed;
  }

  async pexpire(): Promise<number> {
    return 1;
  }

  async eval(): Promise<number> {
    return 1;
  }
}

test('breaker emits open, rejected, half_open and closed with finite states', async () => {
  const redis = new FakeRedis();
  const events: CircuitEvent[] = [];
  const breaker = new RedisCircuitBreakerStore(
    redis as never,
    'tenant-a',
    2,
    30,
    { circuit: (event) => events.push(event) },
  );

  await breaker.recordFailure('openai:gpt-4o');
  assert.equal(await breaker.allows('openai:gpt-4o'), true);
  await breaker.recordFailure('openai:gpt-4o');
  // 熔断打开后立即拒绝。
  assert.equal(await breaker.allows('openai:gpt-4o'), false);
  await new Promise((resolve) => setTimeout(resolve, 45));
  // 过冷却期后第一个请求拿到 half-open 探针并放行。
  assert.equal(await breaker.allows('openai:gpt-4o'), true);
  await breaker.recordSuccess('openai:gpt-4o');

  const states = events.map((event) => event.state);
  assert.deepEqual(states, ['open', 'rejected', 'half_open', 'closed']);
  assert.ok(events.every((event) => event.model === 'openai:gpt-4o'));
});

test('breaker telemetry failures never break circuit operations', async () => {
  const redis = new FakeRedis();
  const breaker = new RedisCircuitBreakerStore(
    redis as never,
    'tenant-b',
    1,
    30_000,
    {
      circuit() {
        throw new Error('telemetry backend is down');
      },
    },
  );
  await assert.doesNotReject(breaker.recordFailure('openai:gpt-4o'));
  assert.equal(await breaker.allows('openai:gpt-4o'), false);
  await assert.doesNotReject(breaker.recordSuccess('openai:gpt-4o'));
});

test('session lock reports acquire outcome and duration', async () => {
  const observations: Array<{ outcome: string; durationMs: number }> = [];
  const redis = new FakeRedis();
  await withSessionLock(
    redis as never,
    'session-1',
    async () => 'done',
    (outcome, durationMs) => observations.push({ outcome, durationMs }),
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.outcome, 'success');
  assert.ok(observations[0]!.durationMs >= 0);

  // 同一会话的并发抢锁失败，记 failure 而不是抛遥测错误。
  const heldRedis = new FakeRedis();
  await heldRedis.set('agent:session:session-2:lock', 'other-token');
  await assert.rejects(
    withSessionLock(
      heldRedis as never,
      'session-2',
      async () => 'done',
      (outcome, durationMs) => observations.push({ outcome, durationMs }),
    ),
    /already being processed/,
  );
  assert.equal(observations[1]!.outcome, 'failure');
});
