import { describe, it, expect } from 'vitest';
import { fetchAndStoreHistory, walkForwardBarsNeeded } from '../src/marketdata/history.js';
import { loadLatestRealData, loadRealData } from '../src/backtest/data.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { LearningEngine } from '../src/learning/engine.js';
import { ModelRegistry } from '../src/model/registry.js';
import { Alerts } from '../src/monitoring/alerts.js';
import { SimulatedClock } from '../src/lib/clock.js';
import { TIMEFRAME_MS, type Timeframe } from '../src/domain/types.js';
import type { Candle } from '../src/domain/types.js';
import { testConfig } from './helpers.js';

const NOW = Date.UTC(2025, 3, 1);

function bars(tf: Timeframe, n: number, end = NOW): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  return Array.from({ length: n }, (_, i) => {
    const t = end - (n - i) * ms;
    return { t, o: 100, h: 101, l: 99, c: 100.5, v: 10 };
  });
}

function fakeRest(series: Candle[]) {
  const calls: Array<{ pair: string; tf: Timeframe; from: number; to: number }> = [];
  return {
    calls,
    async candles(pair: string, tf: Timeframe, fromMs: number, toMs: number) {
      calls.push({ pair, tf, from: fromMs, to: toMs });
      return series.filter((c) => c.t >= fromMs && c.t < toMs);
    },
  };
}

describe('fetchAndStoreHistory', () => {
  it('pages in 500-bar chunks and upserts closed candles', async () => {
    const repos = createMemoryRepositories();
    const series = bars('1h', 80, NOW);
    const rest = fakeRest(series);
    const r = await fetchAndStoreHistory({
      rest,
      repos,
      symbols: ['B-BTC_USDT'],
      timeframes: ['1h'],
      fromMs: NOW - 80 * TIMEFRAME_MS['1h'],
      toMs: NOW,
    });
    expect(r.stored).toBeGreaterThan(0);
    expect(rest.calls.length).toBe(1);
    const stored = await repos.candles.range('B-BTC_USDT', '1h', 0, NOW);
    expect(stored.length).toBe(r.stored);
  });
});

describe('walkForwardBarsNeeded', () => {
  it('counts warmup + train + test * folds', () => {
    expect(walkForwardBarsNeeded(5760, 1440, 4)).toBe(260 + 5760 + 5760);
  });
});

describe('loadLatestRealData', () => {
  it('keeps all stored bars while the current candle is still forming (off-by-one vs a wall-clock range)', async () => {
    const now = Date.UTC(2025, 3, 1, 8, 37, 9);
    const tf = '15m' as const;
    const n = 100;
    const lastClosed = Date.UTC(2025, 3, 1, 8, 15);
    const series = bars(tf, n, lastClosed + TIMEFRAME_MS[tf]);
    expect(series[series.length - 1].t).toBe(lastClosed);
    const repos = createMemoryRepositories();
    await repos.candles.upsertMany('B-BTC_USDT', tf, series);
    const map = { 'B-BTC_USDT': 'BTC' };
    const ranged = await loadRealData(repos, ['B-BTC_USDT'], map, tf, now - n * TIMEFRAME_MS[tf], now, 1);
    expect(ranged.coverage['B-BTC_USDT'].candles).toBe(n - 1);
    const latest = await loadLatestRealData(repos, ['B-BTC_USDT'], map, tf, n, now);
    expect(latest.coverage['B-BTC_USDT'].candles).toBe(n);
    expect(latest.candles['B-BTC_USDT']).toHaveLength(n);
  });
});

describe('LearningEngine history auto-fetch', () => {
  async function setup(rest?: ReturnType<typeof fakeRest>) {
    const cfg = testConfig({
      app: { symbols: ['B-BTC_USDT'], timeframes: ['1h'], decisionTimeframe: '1h', underlyingMap: 'B-BTC_USDT:BTC' },
      learning: { walkForwardTrainDays: 1, walkForwardTestDays: 1, walkForwardFolds: 1, candidatesPerCycle: 1 },
    });
    const clock = new SimulatedClock(NOW);
    const repos = createMemoryRepositories();
    const alerts = new Alerts(repos, clock);
    const registry = new ModelRegistry(repos, clock);
    await registry.ensureBaseline();
    const learning = new LearningEngine(cfg, repos, registry, clock, alerts, rest);
    return { learning, rest, repos };
  }

  it('skips with a CLI hint when no exchange client is wired', async () => {
    const { learning } = await setup();
    const v = await learning.runWalkForward('test');
    expect(v).toBeNull();
    expect(learning.status.progress.some((p) => /insufficient history/.test(p) && /fetch-history/.test(p))).toBe(true);
  });

  it('fetches from the exchange when stored history is too short, then skips if still short', async () => {
    const rest = fakeRest(bars('1h', 40, NOW));
    const { learning } = await setup(rest);
    const v = await learning.runWalkForward('test');
    expect(v).toBeNull();
    expect(rest.calls.length).toBeGreaterThan(0);
    expect(learning.status.progress.some((p) => /fetching \d+d from exchange/.test(p))).toBe(true);
    expect(learning.status.progress.some((p) => /insufficient history/.test(p) && /need \d+/.test(p))).toBe(true);
  });

  it('does not mark the cycle complete when history is still insufficient', async () => {
    const rest = fakeRest([]);
    const { learning, repos } = await setup(rest);
    await learning.runWalkForward('test');
    expect(await repos.state.get('learning.lastWalkForwardAt')).toBeUndefined();
  });
});
