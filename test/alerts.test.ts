import { describe, it, expect } from 'vitest';
import { Alerts } from '../src/monitoring/alerts.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { SimulatedClock } from '../src/lib/clock.js';

describe('alert de-duplication', () => {
  it('does not storm the same code, including critical, inside the window', async () => {
    const repos = createMemoryRepositories();
    const clock = new SimulatedClock(1_000);
    const alerts = new Alerts(repos, clock);
    await alerts.raise('critical', 'LEASE_HELD', 'first');
    await alerts.raise('critical', 'LEASE_HELD', 'second');
    await alerts.raise('warn', 'LEASE_HELD', 'third');
    expect((await repos.alerts.recent()).map((a) => a.message)).toEqual(['first']);
  });

  it('dedupes across a fresh Alerts instance (process restart) using unacked history', async () => {
    const repos = createMemoryRepositories();
    const clock = new SimulatedClock(1_000);
    await new Alerts(repos, clock).raise('warn', 'LEASE_HELD', 'held');
    await new Alerts(repos, clock).raise('warn', 'LEASE_HELD', 'held again');
    expect((await repos.alerts.recent()).length).toBe(1);
    clock.advance(6 * 60_000);
    await new Alerts(repos, clock).raise('warn', 'LEASE_HELD', 'after window');
    expect((await repos.alerts.recent()).map((a) => a.message)).toEqual(['held']);
    await repos.alerts.acknowledge((await repos.alerts.recent())[0].id);
    clock.advance(6 * 60_000);
    await new Alerts(repos, clock).raise('warn', 'LEASE_HELD', 'after ack');
    expect((await repos.alerts.recent()).map((a) => a.message)).toEqual(['after ack', 'held']);
  });
});
