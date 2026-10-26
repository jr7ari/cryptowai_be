import { describe, it, expect } from 'vitest';
import { buildExitPlan, checkExit, guardStyleFor } from '../src/risk/engine.js';
import { buildProfitGuard, evaluateProfitGuard, guardFloorPct, parseLockSteps } from '../src/risk/profit-guard.js';
import { donchianFeatures } from '../src/signals/donchian.js';
import { buildStrategy } from '../src/strategies/builders.js';
import { defaultModelParams } from '../src/model/params.js';
import { hardRiskLimits } from '../src/config/index.js';
import type { Candle, Position } from '../src/domain/types.js';
import { testConfig } from './helpers.js';

const P = defaultModelParams();
const L = hardRiskLimits(testConfig());
const pos = (plan: ReturnType<typeof buildExitPlan>, extra: Partial<Position> = {}) =>
  ({ maxLoss: 100, maxProfit: null, peakPnl: 0, exitPlan: plan, legs: [], directionBias: 'NEUTRAL', ...extra }) as unknown as Position;

describe('Profit Guard', () => {
  it('parses lock steps and ignores junk', () => {
    expect(parseLockSteps('200:0.5, 100:0.4, x:y, 50:1.5')).toEqual([[100, 0.4], [200, 0.5]]);
  });

  it('moves to break-even, then ratchets a floor that never decreases', () => {
    const g = buildProfitGuard(L.exits, 'DEFAULT')!;
    expect(guardFloorPct(g, 30)).toBeNull();
    expect(guardFloorPct(g, 60)).toBe(L.exits.breakevenBufferPct);
    expect(guardFloorPct(g, 250)).toBeCloseTo(0.55 * 250);
    const plan = { ...buildExitPlan(P, L, 0, null, 'FUTURES_MR', 'BUY') };
    // peak 250% of risk, now 120%: below the 137.5% floor -> lock profit
    const r = evaluateProfitGuard(plan, 120, 250, 120, null, null);
    expect(r.exit).toBe(true);
    expect(r.reason).toBe('PROFIT_LOCK');
    // stored floor survives a lower recomputed one
    const r2 = evaluateProfitGuard(plan, 130, 60, 130, null, 137.5);
    expect(r2.floorPct).toBe(137.5);
    expect(r2.exit).toBe(true);
  });

  it('a winner can never turn into a loser once break-even is armed (MR sleeve had no trailing before)', () => {
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_MR', 'BUY');
    expect(plan.trailingActivationPct).toBeGreaterThan(1e6); // sleeve-specific: no classic trailing
    const p = pos(plan, { peakPnl: 60 });
    const ex = checkExit(p, 3, 1, null, { zScore: -1 });
    expect(ex.reason).toBe('PROFIT_LOCK');
    expect(checkExit(pos(plan, { peakPnl: 30 }), 3, 1, null, { zScore: -1 }).exit).toBe(false);
  });

  it('trend sleeves get a looser guard so big winners can run', () => {
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_TSMOM', 'BUY');
    expect(guardStyleFor('FUTURES_TSMOM')).toBe('TREND');
    expect(plan.profitGuard!.breakevenAtPct).toBeGreaterThanOrEqual(100);
    // peak 90%, back to 10%: trend guard not armed yet -> hold (signal decides)
    expect(checkExit(pos(plan, { peakPnl: 90, directionBias: 'BULL' }), 10, 1, null, { tsmom: 0.4 }).exit).toBe(false);
    // peak 400%, back to 100%: lock fires
    expect(checkExit(pos(plan, { peakPnl: 400, directionBias: 'BULL' }), 100, 1, null, { tsmom: 0.4 }).reason).toBe('PROFIT_LOCK');
  });

  it('credit structures are banked at 50% of max profit, capped debits at 75%', () => {
    const credit = buildExitPlan(P, L, 0, 10 * 86_400_000, 'IRON_CONDOR');
    expect(checkExit(pos(credit, { maxLoss: 300, maxProfit: 100 }), 52, 1, null).reason).toBe('PROFIT_CAPTURE');
    expect(checkExit(pos(credit, { maxLoss: 300, maxProfit: 100 }), 40, 1, null).exit).toBe(false);
    const debit = buildExitPlan(P, L, 0, 10 * 86_400_000, 'BULL_CALL_SPREAD');
    expect(checkExit(pos(debit, { maxLoss: 100, maxProfit: 200 }), 151, 1, null).reason).toBe('PROFIT_CAPTURE');
  });

  it('stop-loss still wins over everything; disabling the guard removes it', () => {
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_MR', 'BUY');
    expect(checkExit(pos(plan, { peakPnl: 500 }), -60, 1, null).reason).toBe('STOP_LOSS');
    const off = hardRiskLimits(testConfig({ exits: { profitGuardEnabled: false } }));
    expect(buildExitPlan(P, off, 0, null, 'FUTURES_MR', 'BUY').profitGuard).toBeUndefined();
  });
});

const daily = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * 86_400_000, o: c, h: c, l: c, c, v: 1 }));

describe('Donchian ensemble sleeve', () => {
  it('is fully long after a steady rally and flat after a crash through the midpoints', () => {
    const up = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.004 * i));
    const f = donchianFeatures(daily(up));
    expect(f.donchianAvail).toBe(1);
    expect(f.donchianLong).toBe(1);
    expect(f.donchianShort).toBe(0);
    const crash = [...up, ...Array.from({ length: 15 }, (_, i) => up[up.length - 1] * Math.exp(-0.05 * (i + 1)))];
    const g = donchianFeatures(daily(crash));
    expect(g.donchianLong).toBeLessThan(0.25);
    expect(g.donchianShort).toBeGreaterThan(0);
  });

  it('needs enough history and builds a long with a wide stop', () => {
    expect(donchianFeatures(daily([1, 2, 3])).donchianAvail).toBe(0);
    const ctx = { chain: null, futuresInstrument: 'B-BTC_USDT', spot: 100, bid: 99.9, ask: 100.1, now: 0, minDte: 2, maxDte: 45, atr: 1 };
    const b = buildStrategy('FUTURES_DONCHIAN', P.strategies.FUTURES_DONCHIAN, { ...ctx, features: { donchianAvail: 1, donchianLong: 0.8, donchianShort: 0, donchianStopDist: 0.08, donchianN: 9, atrPct_1d: 0.03 } });
    expect('error' in b).toBe(false);
    if (!('error' in b)) {
      expect(b.legs[0].side).toBe('BUY');
      expect(b.stopDistance).toBeCloseTo(8);
    }
    const no = buildStrategy('FUTURES_DONCHIAN', P.strategies.FUTURES_DONCHIAN, { ...ctx, features: { donchianAvail: 1, donchianLong: 0.3, donchianShort: 0.1, donchianN: 9 } });
    expect('error' in no).toBe(true);
  });

  it('exits when the ensemble share drops below the exit threshold; PAPER-only by default', () => {
    expect(P.strategies.FUTURES_DONCHIAN.paperOnly).toBe(true);
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_DONCHIAN', 'BUY');
    const p = pos(plan, { directionBias: 'BULL' });
    expect(checkExit(p, 20, 1, null, { donchianLong: 0.6 }).exit).toBe(false);
    expect(checkExit(p, 20, 1, null, { donchianLong: 0.1 }).reason).toBe('SIGNAL_EXIT');
  });
});
