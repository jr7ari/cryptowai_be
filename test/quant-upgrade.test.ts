import { describe, it, expect } from 'vitest';
import { defaultModelParams, PARAM_BOUNDS, withDefaults } from '../src/model/params.js';
import { buildStrategy } from '../src/strategies/builders.js';
import { selectStrategy } from '../src/strategies/selector.js';
import { evaluate, type CostModel } from '../src/strategies/evaluate.js';
import { classify } from '../src/regime/classifier.js';
import { hardRiskLimits } from '../src/config/index.js';
import { STRATEGIES, type FeatureVector, type OrderBook, type StrategyName } from '../src/domain/types.js';
import { buildSyntheticChain } from './fixtures/synthetic-chain.js';
import { testConfig, trend } from './helpers.js';
import { microstructureFromBook } from '../src/signals/microstructure.js';
import { cusumShift } from '../src/signals/cusum.js';
import { assessDataQuality } from '../src/signals/quality.js';
import { brierScore, reliabilityBuckets } from '../src/learning/stats.js';
import { buildExitPlan, checkExit } from '../src/risk/engine.js';
import type { Position } from '../src/domain/types.js';
import { extractFeatures } from '../src/regime/features.js';

const P = defaultModelParams();
const now = Date.UTC(2026, 0, 5, 12);
const chain = buildSyntheticChain({ underlying: 'BTC', spot: 60000, now, surface: { atmIv: 0.6, skew: -0.15, smile: 0.4, termSlope: 0 }, spreadPct: 3 });
const costs: CostModel = {
  optionFeePctOfUnderlying: 0.03,
  optionFeeCapPctOfPremium: 12.5,
  futuresTakerFeeBps: 5,
  slippageBps: 5,
  fundingIntervalHours: 8,
  fundingRatePerInterval: 0.0001,
};
const limits = hardRiskLimits(testConfig());
const tradable = new Set<StrategyName>(STRATEGIES);
const downFv: FeatureVector = {
  price: 60000, adx: 38, diDiff: -0.5, emaAlign: -1, htfAlign: -1, er: 0.6, chop: 30, r2: 0.9, slope: -0.3,
  supertrendDir: -1, ichimoku: -1, tfAgreement: 1, hurst: 0.62, ret20: -0.08, rvShort: 0.6, garchVol: 0.6, atrPct: 0.01,
  tsmom: -0.45, tsmomAgreement: 1, rvPctile: 0.5, rvRatio: 1, atrPctile: 0.5, volumeZ: 0, rsi: 40,
};

describe('PAPER directional futures', () => {
  it('default model enables FUTURES_LONG/SHORT as paperOnly and learning cannot touch that flag', () => {
    expect(P.strategies.FUTURES_SHORT.enabled).toBe(true);
    expect(P.strategies.FUTURES_SHORT.paperOnly).toBe(true);
    expect(P.strategies.FUTURES_LONG.paperOnly).toBe(true);
    expect(Object.keys(PARAM_BOUNDS).some((k) => k.includes('paperOnly') || k.includes('.enabled'))).toBe(false);
  });

  it('withDefaults re-enables the old factory-disabled short sleeve as PAPER-only', () => {
    const upgraded = withDefaults({
      strategies: { FUTURES_SHORT: { enabled: false, targetDte: 0, longDelta: 0, shortDelta: 0, leverage: 2 } },
    });
    expect(upgraded.strategies.FUTURES_SHORT.enabled).toBe(true);
    expect(upgraded.strategies.FUTURES_SHORT.paperOnly).toBe(true);
  });

  it('TSMOM builds SELL when score ≤ −entry and BUY when score ≥ entry', () => {
    const ctx = { chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, minDte: 2, maxDte: 45, atr: 600, bid: 59990, ask: 60010 };
    const short = buildStrategy('FUTURES_TSMOM', P.strategies.FUTURES_TSMOM, { ...ctx, features: { tsmom: -0.5, atrPct_1d: 0.03, rvDaily: 0.6 } });
    if ('error' in short) throw new Error(short.error);
    expect(short.legs[0].side).toBe('SELL');
    const long = buildStrategy('FUTURES_TSMOM', P.strategies.FUTURES_TSMOM, { ...ctx, features: { tsmom: 0.5, atrPct_1d: 0.03, rvDaily: 0.6 } });
    if ('error' in long) throw new Error(long.error);
    expect(long.legs[0].side).toBe('BUY');
    const flat = buildStrategy('FUTURES_TSMOM', P.strategies.FUTURES_TSMOM, { ...ctx, features: { tsmom: 0.05 } });
    expect('error' in flat).toBe(true);
  });

  it('PAPER considers FUTURES_SHORT in a downtrend; LIVE rejects paperOnly and TSMOM shorts', () => {
    const regime = classify('X', now, downFv, P.regime, 'm1');
    expect(regime.primary).toBe('STRONG_DOWNTREND');
    const paper = selectStrategy({
      regime, features: downFv, chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, model: P, limits, costs, tradable, mode: 'PAPER',
    });
    expect(paper.rationale).toMatch(/IV n\/a/);
    expect(paper.rationale).toMatch(/VRP n\/a/);
    const shortP = paper.candidates.find((c) => c.strategy === 'FUTURES_SHORT')!;
    expect(shortP.rejectedReasons.join()).not.toMatch(/PAPER-only/);
    expect(shortP.rejectedReasons.join()).not.toMatch(/disabled/);
    const tsmomP = paper.candidates.find((c) => c.strategy === 'FUTURES_TSMOM');
    if (tsmomP?.legs[0]) expect(tsmomP.legs[0].side).toBe('SELL');

    const live = selectStrategy({
      regime, features: downFv, chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, model: P, limits, costs, tradable, mode: 'LIVE',
    });
    const shortL = live.candidates.find((c) => c.strategy === 'FUTURES_SHORT')!;
    expect(shortL.eligible).toBe(false);
    expect(shortL.rejectedReasons.join()).toMatch(/PAPER-only/);
    const tsmomL = live.candidates.find((c) => c.strategy === 'FUTURES_TSMOM');
    if (tsmomL) {
      expect(tsmomL.eligible).toBe(false);
      expect(tsmomL.rejectedReasons.join()).toMatch(/PAPER-only|short side/);
    }
  });

  it('TSMOM short covers when score rises back through the exit threshold', () => {
    const L = hardRiskLimits(testConfig());
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_TSMOM', 'SELL');
    const p = { maxLoss: 100, peakPnl: 10, exitPlan: plan, legs: [], directionBias: 'BEAR' } as unknown as Position;
    expect(checkExit(p, 8, 1, null, { tsmom: -0.4 }).exit).toBe(false);
    expect(checkExit(p, 8, 1, null, { tsmom: 0.0 }).reason).toBe('SIGNAL_EXIT');
  });
});

describe('microstructure / CUSUM / quality', () => {
  it('does not invent OFI from a snapshot; microprice uses live sizes only', () => {
    expect(microstructureFromBook(null).ofiAvail).toBe(0);
    expect(microstructureFromBook(undefined).bookImbalanceAvail).toBe(0);
    const book: OrderBook = {
      instrument: 'B-BTC_USDT',
      ts: now,
      bids: [{ price: 99, qty: 2 }],
      asks: [{ price: 101, qty: 1 }],
    };
    const m = microstructureFromBook(book, 100);
    expect(m.bookImbalanceAvail).toBe(1);
    expect(m.ofiAvail).toBe(0);
    expect(m.ofi).toBe(0);
    expect(m.bookImbalance).toBeCloseTo(1 / 3);
    expect(m.microprice).toBeCloseTo((101 * 2 + 99 * 1) / 3);
  });

  it('CUSUM stays silent on short series and fires after a closed-bar level shift', () => {
    expect(cusumShift([100, 101, 99]).shift).toBe(0);
    const closes = [...Array(100).fill(100), ...Array(80).fill(0).map((_, i) => 100 * Math.exp(-0.03 * (i + 1)))];
    expect(cusumShift(closes).shift).toBe(-1);
  });

  it('marks missing L2/OFI as unavailable rather than fabricating a signal', () => {
    const c = trend(80, 0.002, 100, '1h', 0.001);
    const fv = extractFeatures({ candles: { '1h': c }, decisionTf: '1h', higherTfs: [] });
    expect(fv.ofiAvail).toBe(0);
    expect(fv.bookImbalanceAvail).toBe(0);
    expect(fv.cusumAvail).toBe(1);
    const q = assessDataQuality(fv, 1_000, 20_000, c.length);
    expect(q.ok).toBe(true);
    expect(q.ofiAvail).toBe(0);
    expect(q.reasons.some((r) => /OFI/.test(r))).toBe(true);
  });
});

describe('evaluation diagnostics', () => {
  it('reports gross vs net EV and MC stderr on futures with a seeded path sim', () => {
    const b = buildStrategy('FUTURES_SHORT', P.strategies.FUTURES_SHORT, {
      chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, minDte: 2, maxDte: 45, atr: 600, bid: 59990, ask: 60010,
    });
    if ('error' in b) throw new Error(b.error);
    const e = evaluate(b.legs, {
      spot: 60000, now, rate: 0, forecastVol: 0.6, drift: -0.25, holdHours: 72, expiryBufferHours: 12,
      takeProfitPct: 80, stopLossPct: 50, costs, stopDistance: b.stopDistance, leverage: 2, paths: 200, seed: 7,
    });
    const txn = e.costs.fees + e.costs.slippage + e.costs.spreadCost;
    expect(e.costs.funding).toBeLessThan(0); // short receives positive funding
    expect(e.grossExpectedValue).toBeCloseTo(e.expectedValue + txn, 8);
    expect(e.expectedValue).toBeLessThanOrEqual((e.grossExpectedValue ?? 0) + 1e-12);
    expect(e.path?.paths).toBe(200);
    expect(e.path?.seed).toBe(7);
    expect(e.path?.meanStderr).toBeGreaterThan(0);
    const e2 = evaluate(b.legs, {
      spot: 60000, now, rate: 0, forecastVol: 0.6, drift: -0.25, holdHours: 72, expiryBufferHours: 12,
      takeProfitPct: 80, stopLossPct: 50, costs, stopDistance: b.stopDistance, leverage: 2, paths: 200, seed: 7,
    });
    expect(e2.expectedValue).toBe(e.expectedValue);
  });

  it('Brier score is 0 for a perfect forecast and reliability buckets populate', () => {
    expect(brierScore([0, 1, 1], [0, 1, 1])).toBe(0);
    expect(brierScore([0.2, 0.8], [0, 1])).toBeCloseTo(0.04);
    const buckets = reliabilityBuckets([0.1, 0.1, 0.9, 0.9], [0, 0, 1, 1], 10);
    expect(buckets.reduce((a, b) => a + b.n, 0)).toBe(4);
  });
});
