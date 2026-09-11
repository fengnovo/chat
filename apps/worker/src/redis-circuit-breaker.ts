import type { CircuitBreakerStore } from '@repo/agent-core';
import type { Redis } from 'ioredis';

export class RedisCircuitBreakerStore implements CircuitBreakerStore {
  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
    private readonly failureThreshold = 5,
    private readonly resetAfterMs = 30_000,
  ) {}

  async allows(model: string): Promise<boolean> {
    const key = this.key(model);
    const openedAt = Number(await this.redis.hget(key, 'openedAt'));
    if (!openedAt) return true;
    if (Date.now() - openedAt < this.resetAfterMs) return false;
    const probe = await this.redis.set(
      `${key}:half-open`,
      String(Date.now()),
      'PX',
      this.resetAfterMs,
      'NX',
    );
    return probe === 'OK';
  }

  async recordSuccess(model: string): Promise<void> {
    const key = this.key(model);
    await this.redis.del(key, `${key}:half-open`);
  }

  async recordFailure(model: string): Promise<void> {
    const key = this.key(model);
    const failures = await this.redis.hincrby(key, 'failures', 1);
    if (failures >= this.failureThreshold) {
      await this.redis.hset(key, 'openedAt', Date.now());
    }
    await this.redis.del(`${key}:half-open`);
    await this.redis.pexpire(key, this.resetAfterMs * 2);
  }

  private key(model: string) {
    return `agent:circuit:${this.namespace}:${model}`;
  }
}
