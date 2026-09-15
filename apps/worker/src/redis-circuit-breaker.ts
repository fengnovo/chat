import type { AgentTelemetry, CircuitBreakerStore } from '@repo/agent-core';
import type { Redis } from 'ioredis';

type CircuitTelemetry = Pick<AgentTelemetry, 'circuit'>;

export class RedisCircuitBreakerStore implements CircuitBreakerStore {
  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
    private readonly failureThreshold = 5,
    private readonly resetAfterMs = 30_000,
    private readonly telemetry?: CircuitTelemetry,
  ) {}

  async allows(model: string): Promise<boolean> {
    const key = this.key(model);
    const openedAt = Number(await this.redis.hget(key, 'openedAt'));
    if (!openedAt) return true;
    if (Date.now() - openedAt < this.resetAfterMs) {
      this.emit(model, 'rejected');
      return false;
    }
    const probe = await this.redis.set(
      `${key}:half-open`,
      String(Date.now()),
      'PX',
      this.resetAfterMs,
      'NX',
    );
    if (probe === 'OK') this.emit(model, 'half_open');
    else this.emit(model, 'rejected');
    return probe === 'OK';
  }

  async recordSuccess(model: string): Promise<void> {
    const key = this.key(model);
    // 只有从开启/半开恢复时才记一次 closed，避免每次成功调用都刷状态指标。
    const wasOpen = Number(await this.redis.hget(key, 'openedAt'));
    if (wasOpen) this.emit(model, 'closed');
    await this.redis.del(key, `${key}:half-open`);
  }

  async recordFailure(model: string): Promise<void> {
    const key = this.key(model);
    const failures = await this.redis.hincrby(key, 'failures', 1);
    if (failures >= this.failureThreshold) {
      await this.redis.hset(key, 'openedAt', Date.now());
      this.emit(model, 'open');
    }
    await this.redis.del(`${key}:half-open`);
    await this.redis.pexpire(key, this.resetAfterMs * 2);
  }

  private emit(model: string, state: Parameters<CircuitTelemetry['circuit']>[0]['state']): void {
    try {
      this.telemetry?.circuit({ model, state });
    } catch {}
  }

  private key(model: string) {
    return `agent:circuit:${this.namespace}:${model}`;
  }
}
