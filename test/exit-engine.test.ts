import { describe, it, expect } from 'vitest';
import { evaluateExitV2, parseMilestones, costPerUnit, initialStop, riskUnit } from '../src/risk/exit-engine.js';
import { buildExitPlan, buildV2Plan } from '../src/risk/engine.js';
import { PaperVenue } from '../src/execution/paper.js';
import { OrderManager } from '../src/execution/order-manager.js';
import { MarketQuoter } from '../src/execution/quoter.js';
import { PositionManager, shouldUseV2 } from '../src/portfolio/position-manager.js';
import { Account } from '../src/portfolio/account.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { SimulatedClock } from '../src/lib/clock.js';
import { defaultModelParams } from '../src/model/params.js';
import { hardRiskLimits } from '../src/config/index.js';
import type { Position, RegimeClassification, StrategyCandidate } from '../src/domain/types.js';
import { FakeMarket, gbm, testConfig } from './helpers.js';

const P = defaultModelParams();
const L = hardRiskLimits(testConfig());

/** A long futures position: entry 100, R = 2 (stop 98), maxLoss covers 0.2/unit of costs. */
function pos(over: Partial<Position> = {}, strategy = 'FUTURES_MR', side: 'BUY' | 'SELL' = 'BUY'): Position {
  const built = buildExitPlan(P, L, 0, null, strategy, side);
  // unit tests use the full stop distance as R (riskFraction 1) so the arithmetic stays readable
  const plan = { ...built, v2: { ...built.v2!, riskFraction: 1 } };
  return {
    id: 'p1', decisionId: 'd1', mode: 'PAPER', underlying: 'X', strategy: strategy as Position['strategy'],
    legs: [{ kind: 'FUTURE', instrument: 'X', side, qty: 1, ratio: 1, bid: 100, ask: 100, mark: 100, entryPrice: 100, filledQty: 1 }],
    units: 1, openedAt: 0, status: 'OPEN', entryCost: 0, maxLoss: 2.2, maxProfit: null, exitPlan: plan, peakPnl: 0, troughPnl: 0,
    fees: 0.1, fundingPaid: 0, modelVersion: 'm', regimeAtEntry: 'RANGING', regimeConfidence: 1, directionBias: side === 'BUY' ? 'BULL' : 'BEAR',
    params: {}, featuresAtEntry: {}, evAtEntry: 0, popAtEntry: 0, slippageCost: 0, stopDistance: 2, ...over,
  } as Position;
}

describe('Exit Engine v2 (pure)', () => {
  it('parses milestones and caps the stop lock below the milestone', () => {
    expect(parseMilestones('2:0.25:1, 1:0.5:0, junk, 3:1.2:1')).toEqual([
      { r: 1, fraction: 0.5, lockR: 0 },
      { r: 2, fraction: 0.25, lockR: 1 },
    ]);
    expect(parseMilestones('1:0.5')[0].lockR).toBe(-Infinity); // no stop move
    expect(parseMilestones('')).toEqual([]);
  });

  it('builds v2 only for futures; trend sleeves keep runners (no final target, daily ATR)', () => {
    expect(buildV2Plan(L, 'IRON_CONDOR')).toBeUndefined();
    const t = buildV2Plan(L, 'FUTURES_TSMOM')!;
    expect(t.finalTargetR).toBe(0);
    expect(t.atrFeature).toBe('atrPct_1d');
    expect(t.milestones[0]).toEqual({ r: 1, fraction: 0, lockR: 0 });
    expect(buildV2Plan(L, 'FUTURES_DONCHIAN')!.channelFeature).toBe('donchianStopDist');
    const legacy = hardRiskLimits(testConfig({ exits: { engine: 'legacy' } }));
    expect(buildV2Plan(legacy, 'FUTURES_MR')).toBeUndefined();
  });

  it('initial stop = entry - R; costs per unit come from maxLoss', () => {
    const p = pos();
    expect(initialStop(p)).toBe(98);
    expect(costPerUnit(p)).toBeCloseTo(0.2);
  });

  it('R honours the hard stop-loss % (default 50% of max loss): never riskier than the legacy stop', () => {
    expect(buildV2Plan(L, 'FUTURES_MR')!.riskFraction).toBe(L.exits.stopLossPct / 100);
    const p = pos();
    const half = { ...p, exitPlan: { ...p.exitPlan, v2: { ...p.exitPlan.v2!, riskFraction: 0.5 } } };
    // 0.5 x (2 + 0.2) - 0.2 = 0.9 -> stop 99.1, and the loss there equals 50% of max loss
    expect(riskUnit(half)).toBeCloseTo(0.9);
    expect(initialStop(half)).toBeCloseTo(99.1);
    expect((0.9 + 0.2) / half.maxLoss).toBeCloseTo(0.5);
  });

  it('carried stop is tested FIRST: a bar touching both stop and +1R is a stop-out', () => {
    const p = pos({ stopPrice: 98 });
    const a = evaluateExitV2(p, { price: 101, bar: { o: 100, h: 103, l: 97.5 }, atr: 1, qtyStep: 0.001 });
    expect(a.kind).toBe('CLOSE');
    if (a.kind === 'CLOSE') {
      expect(a.reason).toBe('PROTECTIVE_STOP');
      expect(a.triggerPrice).toBe(98);
    }
  });

  it('gap through the stop fills at the open, not the stop', () => {
    const a = evaluateExitV2(pos({ stopPrice: 98 }), { price: 95, bar: { o: 95.5, h: 96, l: 94 }, atr: 1, qtyStep: 0.001 });
    expect(a.kind === 'CLOSE' && a.triggerPrice).toBe(95.5);
  });

  it('+1R books 50% of the original qty and moves the stop to break-even after costs', () => {
    const p = pos();
    // trigger = 100 + 1*2 + 0.2 = 102.2
    const a = evaluateExitV2(p, { price: 102.5, atr: 1, qtyStep: 0.001 });
    expect(a.kind).toBe('PARTIAL');
    if (a.kind === 'PARTIAL') {
      expect(a.qty).toBeCloseTo(0.5);
      expect(a.newStop).toBeCloseTo(100.2);
      expect(a.milestonesHit).toEqual([0]);
    }
    // not reached
    expect(evaluateExitV2(pos(), { price: 102.1, atr: 1, qtyStep: 0.001 }).kind).toBe('HOLD');
  });

  it('a milestone always leaves a runner of at least one step', () => {
    const p = pos({ units: 0.002, maxLoss: 2.2 * 0.002, legs: [{ ...pos().legs[0], filledQty: 0.002, exitQty: 0.001 }] });
    const a = evaluateExitV2(p, { price: 102.5, atr: 1, qtyStep: 0.001 });
    // 0.001 open; booking 50% of 0.002 would close everything -> converted to a stop move only
    expect(a.kind).toBe('HOLD');
    // stop moved at least to break-even after costs (the Profit Guard may lock more)
    expect(a.newStop).toBeGreaterThanOrEqual(100.2);
  });

  it('the stop never loosens; Chandelier and Profit Guard feed ONE stop (tightest wins)', () => {
    const p = pos({ stopPrice: 100.2, milestonesHit: [0], highWater: 104 }, 'FUTURES_TSMOM');
    // trend: milestones 1:0:0, 3:0.25:1.5. highWater 104 -> favR = (4-0.2)/2 = 1.9 >= 1 -> chandelier 104 - 3*1 = 101
    const a = evaluateExitV2(p, { price: 103, atr: 1, qtyStep: 0.001 });
    expect(a.kind).toBe('HOLD');
    // chandelier = 101; trend guard at peak 190% of risk keeps 25% of it: 100 + 0.475*2 + 0.2 = 101.15
    expect(a.newStop).toBeCloseTo(101.15);
    // ATR doubles (Chandelier would drop to 98): the stop must NOT move down
    const b = evaluateExitV2({ ...p, stopPrice: 101.15 }, { price: 103, atr: 2, qtyStep: 0.001 });
    expect(b.newStop).toBeCloseTo(101.15);
    // guard off: pure Chandelier
    const noGuard = { ...p, exitPlan: { ...p.exitPlan, profitGuard: undefined } };
    expect(evaluateExitV2(noGuard, { price: 103, atr: 1, qtyStep: 0.001 }).newStop).toBeCloseTo(101);
  });

  it('works mirrored for shorts', () => {
    const p = pos({}, 'FUTURES_MR', 'SELL');
    expect(initialStop(p)).toBe(102);
    const a = evaluateExitV2(p, { price: 97.5, atr: 1, qtyStep: 0.001 });
    expect(a.kind).toBe('PARTIAL');
    const b = evaluateExitV2(p, { price: 101, bar: { o: 100, h: 102.5, l: 99 }, atr: 1, qtyStep: 0.001 });
    expect(b.kind === 'CLOSE' && b.reason).toBe('PROTECTIVE_STOP');
  });

  it('non-trend final target closes the rest at +3R', () => {
    const p = pos({ milestonesHit: [0, 1], stopPrice: 102.2 });
    const a = evaluateExitV2(p, { price: 106.3, atr: 1, qtyStep: 0.001 });
    expect(a.kind === 'CLOSE' && a.reason).toBe('FINAL_TARGET');
  });

  it('LIVE uses v2 only after explicit approval', () => {
    const p = pos();
    expect(shouldUseV2(p, 'PAPER', false)).toBe(true);
    expect(shouldUseV2(p, 'LIVE', false)).toBe(false);
    expect(shouldUseV2(p, 'LIVE', true)).toBe(true);
    expect(shouldUseV2({ ...p, exitPlan: { ...p.exitPlan, v2: undefined } }, 'PAPER', false)).toBe(false);
  });
});

describe('Exit Engine v2 through the position manager (PAPER, real order path)', () => {
  function setup() {
    const cfg = testConfig();
    const clock = new SimulatedClock(Date.UTC(2025, 3, 1));
    const market = new FakeMarket(clock);
    market.setCandles('B-BTC_USDT', '1h', gbm(300, { s0: 60000, seed: 3, start: Date.UTC(2025, 3, 1) - 300 * 3_600_000 }));
    market.price.set('B-BTC_USDT', 60000);
    const repos = createMemoryRepositories();
    const u = () => 'B-BTC_USDT';
    const venue = new PaperVenue({ ...cfg.paper, partialFillProbability: 0, rejectProbability: 0 }, market, clock, u, true);
    const orders = new OrderManager(repos, clock, () => venue);
    const account = new Account(repos, clock, 'PAPER', 10_000);
    const pm = new PositionManager({ repos, orders, quoter: new MarketQuoter(market, clock, u), account: () => account, clock, mode: () => 'PAPER', fundingRate: () => 0, fundingIntervalHours: 8, optionLimitTolerance: 0.05 });
    return { cfg, clock, market, repos, account, pm };
  }

  it('books at +1R, protects the runner at break-even, closes on the stop, and logs gross/fees/net', async () => {
    const env = setup();
    const R = 600; // 1% stop
    const leg = { kind: 'FUTURE' as const, instrument: 'B-BTC_USDT', side: 'BUY' as const, qty: 1, ratio: 1, bid: 59994, ask: 60006, mark: 60000 };
    const evaluation = { netPremium: 0, maxLoss: R + 60, maxProfit: null, breakevens: [], probabilityOfProfit: 0.5, expectedValue: 1, grossExpectedValue: 1, evPerRisk: 0.01, rewardRisk: null, costs: { fees: 0, slippage: 0, spreadCost: 0, funding: 0, total: 60 }, terminalExpectedValue: 1, greeks: { delta: 1, gamma: 0, vega: 0, theta: 0 }, liquidityScore: 1, spreadPct: 0.02, marginRequired: 0, horizonDays: 3, ivUsed: NaN, forecastVol: 0.6 };
    const cand = { strategy: 'FUTURES_MR', params: {}, legs: [leg], evaluation, score: 1, regimeAffinity: 1, eligible: true, rejectedReasons: [] } as unknown as StrategyCandidate;
    const p = await env.pm.open({
      decisionId: 'd-v2', candidate: cand, units: 0.01, underlying: 'B-BTC_USDT', regime: { primary: 'RANGING', confidence: 0.8 } as RegimeClassification,
      modelVersion: 'm', exitPlan: buildExitPlan(P, hardRiskLimits(env.cfg), env.clock.now(), null, 'FUTURES_MR', 'BUY'), stopDistance: R, features: {},
    });
    expect(p.status).toBe('OPEN');
    const Reff = riskUnit(p);
    expect(Reff).toBeLessThan(R); // hard 50% stop-loss honoured
    expect(p.stopPrice).toBeCloseTo(p.legs[0].entryPrice - Reff, 6);

    // +1.2R (after costs) -> partial booking
    env.market.price.set('B-BTC_USDT', p.legs[0].entryPrice + 1.2 * Reff + costPerUnit(p) + 20);
    await env.pm.monitor(() => null, () => ({ atrPct: 0.004, zScore: -1 }));
    const after = (await env.repos.positions.get(p.id))!;
    expect(after.status).toBe('OPEN');
    expect(after.legs[0].exitQty).toBeCloseTo(0.005, 9);
    expect(after.milestonesHit).toEqual([0]);
    expect(after.bookings?.[0].kind).toBe('PARTIAL');
    expect(after.bookings?.[0].grossPnl).toBeGreaterThan(0);
    expect(after.stopPrice!).toBeGreaterThan(after.legs[0].entryPrice); // break-even + costs

    // same price again: idempotent, no second booking
    await env.pm.monitor(() => null, () => ({ atrPct: 0.004, zScore: -1 }));
    expect((await env.repos.positions.get(p.id))!.bookings!.length).toBe(1);

    // price falls through the protected stop -> closed, fill confirmed, trade logged
    env.market.price.set('B-BTC_USDT', p.legs[0].entryPrice - 50);
    await env.pm.monitor(() => null, () => ({ atrPct: 0.004, zScore: -1 }));
    const closed = (await env.repos.positions.get(p.id))!;
    expect(closed.status).toBe('CLOSED');
    // the runner's stop was at break-even + costs or better (guard lock) - never the initial stop
    expect(['BREAKEVEN_STOP', 'PROFIT_LOCK', 'TRAILING_STOP']).toContain(closed.exitReason);
    const [t] = await env.repos.trades.list();
    expect(t.bookings!.map((b) => b.kind)).toEqual(['PARTIAL', 'CLOSE']);
    expect(t.grossPnl).toBeDefined();
    expect(t.realizedPnl).toBeCloseTo(t.grossPnl! - t.fees - t.funding, 6);
    expect(env.account.book.cash).toBeCloseTo(10_000 + t.realizedPnl, 6);
  });
});

describe('compare-exits harness (machinery only; fixture data proves nothing about profitability)', () => {
  it('runs every variant on identical data and splits in-sample / held-out', async () => {
    const { compareExits, formatReport } = await import('../src/backtest/compare-exits.js');
    const { generateRegimeSeries } = await import('./fixtures/synthetic-data.js');
    const synth = generateRegimeSeries({ start: Date.UTC(2025, 0, 1), bars: 900, tf: '1h', startPrice: 60000, seed: 5 });
    const rep = await compareExits({
      configFor: (exits, paper) => testConfig({ exits, ...(paper ? { paper } : {}) }),
      candles: { 'B-BTC_USDT': synth.candles },
      baseTf: '1h',
      timeframes: ['1h', '4h'],
      model: { version: 'm1', params: defaultModelParams() },
      warmupBars: 300,
      decisionEveryBars: 4,
      stressCostMultiple: 2,
    });
    expect(rep.variants.map((v) => v.label)).toEqual(['legacy', 'legacy+guard', 'v2+guard', 'v2']);
    expect(rep.stress?.length).toBe(4);
    expect(rep.variantsEvaluated).toBe(8);
    for (const v of rep.variants) {
      expect(v.inSample.metrics.trades + v.outOfSample.metrics.trades).toBe(v.all.metrics.trades);
      // gross - fees - funding = net, per variant (no double-counted fees)
      expect(v.all.grossPnl - v.all.fees - v.all.funding).toBeCloseTo(v.all.metrics.totalPnl, 6);
    }
    expect(formatReport(rep)).toContain('held-out');
  }, 120_000);
});
