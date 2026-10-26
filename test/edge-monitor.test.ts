import { describe, it, expect } from 'vitest';
import { edgeStatus, pausedStrategies } from '../src/learning/edge-monitor.js';
import { deltaNotional, netDelta } from '../src/risk/engine.js';
import type { Position } from '../src/domain/types.js';

const H = 3_600_000;
const o = { window: 30, minTrades: 15, tStat: -1.5, maxCumLossR: 6, pauseHours: 72, now: 100 * H };
const tr = (strategy: string, r: number, i: number) => ({ strategy: strategy as never, returnOnRisk: r, closedAt: i * H });

describe('per-strategy edge monitor', () => {
  it('pauses a strategy whose recent trades are significantly negative, not one that is merely noisy', () => {
    const bad = Array.from({ length: 20 }, (_, i) => tr('FUTURES_MR', i % 4 === 0 ? 0.3 : -0.6, 50 + i));
    const noisy = Array.from({ length: 20 }, (_, i) => tr('FUTURES_TSMOM', i % 2 ? 1.2 : -1, 50 + i));
    const p = pausedStrategies([...bad, ...noisy], o);
    expect(p.has('FUTURES_MR' as never)).toBe(true);
    expect(p.has('FUTURES_TSMOM' as never)).toBe(false);
  });
  it('needs a minimum sample, and the pause expires (probation)', () => {
    const few = Array.from({ length: 4 }, (_, i) => tr('FUTURES_MR', -0.5, 90 + i));
    expect(pausedStrategies(few, o).size).toBe(0);
    const bad = Array.from({ length: 20 }, (_, i) => tr('FUTURES_MR', -0.5 + (i % 3) * 0.1, i));
    expect(edgeStatus(bad, { ...o, now: 19 * H + 71 * H })[0].paused).toBe(true);
    expect(edgeStatus(bad, { ...o, now: 19 * H + 73 * H })[0].paused).toBe(false);
  });
  it('cumulative-loss rule catches a fast streak before the t-test has enough trades', () => {
    const streak = Array.from({ length: 6 }, (_, i) => tr('FUTURES_CARRY', -1.1, 95 + i));
    expect(pausedStrategies(streak, o).has('FUTURES_CARRY' as never)).toBe(true);
  });
});

describe('portfolio exposure', () => {
  it('values each position at its own price and only the open quantity', () => {
    const p = { legs: [{ kind: 'FUTURE', side: 'BUY', entryPrice: 3000, filledQty: 2, exitQty: 1 }] } as unknown as Position;
    expect(netDelta(p)).toBe(1);
    expect(deltaNotional(p)).toBe(3000);
  });
});
