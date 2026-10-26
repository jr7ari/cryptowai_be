import { ExchangeError } from './errors.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

/** Token bucket rate limiter. `acquire()` waits until a token is available. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }
  private refill() {
    const now = this.clock.now();
    const add = ((now - this.last) / 1000) * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + add);
    this.last = now;
  }
  async acquire(n = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const waitMs = Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
      await this.clock.sleep(Math.max(5, waitMs));
    }
  }
  available(): number {
    this.refill();
    return this.tokens;
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Return true when the error is safe to retry. */
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (attempt: number, e: unknown, delayMs: number) => void;
  clock?: Clock;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const clock = o.clock ?? systemClock;
  const retryable = o.isRetryable ?? ((e) => e instanceof ExchangeError && e.retryable);
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= o.retries || !retryable(e)) throw e;
      const exp = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
      const delay = Math.round(exp / 2 + Math.random() * (exp / 2)); // decorrelated jitter
      o.onRetry?.(attempt + 1, e, delay);
      await clock.sleep(delay);
      attempt++;
    }
  }
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Circuit breaker: after `threshold` consecutive failures, fail fast for `cooldownMs`. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private _state: BreakerState = 'CLOSED';
  constructor(
    public readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly clock: Clock = systemClock,
  ) {}
  get state(): BreakerState {
    if (this._state === 'OPEN' && this.clock.now() - this.openedAt >= this.cooldownMs) this._state = 'HALF_OPEN';
    return this._state;
  }
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') throw new ExchangeError(`Circuit ${this.name} open`, undefined, false);
    try {
      const r = await fn();
      this.failures = 0;
      this._state = 'CLOSED';
      return r;
    } catch (e) {
      const countable = !(e instanceof ExchangeError) || e.retryable || (e.status ?? 0) >= 500;
      if (countable) {
        this.failures++;
        if (this.failures >= this.threshold || this._state === 'HALF_OPEN') {
          this._state = 'OPEN';
          this.openedAt = this.clock.now();
        }
      }
      throw e;
    }
  }
  snapshot() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}
