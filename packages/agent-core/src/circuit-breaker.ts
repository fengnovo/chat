import type { CircuitBreakerStore } from './types.js';

interface CircuitState {
  failures: number;
  openedAt: number | null;
  halfOpenSuccesses: number;
}

export class InMemoryCircuitBreakerStore implements CircuitBreakerStore {
  private readonly states = new Map<string, CircuitState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly resetAfterMs = 30_000,
    private readonly successThreshold = 2,
  ) {}

  async allows(key: string): Promise<boolean> {
    const state = this.state(key);
    if (state.openedAt === null) return true;
    return Date.now() - state.openedAt >= this.resetAfterMs;
  }

  async recordSuccess(key: string): Promise<void> {
    const state = this.state(key);
    if (state.openedAt !== null && Date.now() - state.openedAt >= this.resetAfterMs) {
      state.halfOpenSuccesses += 1;
      if (state.halfOpenSuccesses < this.successThreshold) return;
    }
    state.failures = 0;
    state.openedAt = null;
    state.halfOpenSuccesses = 0;
  }

  async recordFailure(key: string): Promise<void> {
    const state = this.state(key);
    state.failures += 1;
    state.halfOpenSuccesses = 0;
    if (state.failures >= this.failureThreshold) state.openedAt = Date.now();
  }

  private state(key: string): CircuitState {
    const current = this.states.get(key);
    if (current) return current;
    const created = { failures: 0, openedAt: null, halfOpenSuccesses: 0 };
    this.states.set(key, created);
    return created;
  }
}
