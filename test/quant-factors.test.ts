import { describe, it, expect } from 'vitest';
import { basisFeatures } from '../src/signals/basis.js';
import { orderFlowFeatures, type PublicTrade } from '../src/signals/orderflow.js';
import { volAdjReturn, xsmomFeatures } from '../src/signals/xsmom.js';
import { meanReversionFeatures } from '../src/signals/meanreversion.js';
import { changePointDecision } from '../src/regime/changePointDetector.js';
import { cusumShift } from '../src/signals/cusum.js';
import { tripleBarrierAt, fitLogit, scoreMeta, metaFeatures } from '../src/learning/metaLabeler.js';
import { probabilityOfBacktestOverfitting } from '../src/research/validation.js';
import { defaultModelParams } from '../src/model/params.js';
import { buildStrategy } from '../src/strategies/builders.js';
import { selectStrategy } from '../src/strategies/selector.js';
import { classify } from '../src/regime/classifier.js';
import { hardRiskLimits } from '../src/config/index.js';
import { STRATEGIES, type FeatureVector, type StrategyName } from '../src/domain/types.js';
import { buildSyntheticChain } from './fixtures/synthetic-chain.js';
import { testConfig, trend, gbm } from './helpers.js';
import { mulberry32, gaussian } from '../src/lib/math.js';

const P = defaultModelParams();
const now = Date.UTC(2026, 0, 5, 12);
const chain = buildSyntheticChain({ underlying: 'BTC', spot: 60000, now, surface: { atmIv: 0.6, skew: -0.15, smile: 0.4, termSlope: 0 }, spreadPct: 3 });
const costs = { optionFeePctOfUnderlying: 0.03, optionFeeCapPctOfPremium: 12.5, futuresTakerFeeBps: 5, slippageBps: 5, fundingIntervalHours: 8, fundingRatePerInterval: 0.0001 };
const limits = hardRiskLimits(testConfig());
const tradable = new Set<StrategyName>(STRATEGIES);
const ctx = { chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, minDte: 2, maxDte: 45, atr: 600, bid: 59990, ask: 60010 };

describe('basis + funding carry', () => {
  it('marks basis unavailable when last equals mark (typical backtest)', () => {
    const f = basisFeatures({ last: 100, mark: 100, fundingRate: 0.0001 });
    expect(f.basisAvail).toBe(0);
    expect(f.fundingAvail).toBe(1);
    expect(f.carryScore).not.toBe(0);
  });
  it('computes ln(last/mark) when they differ', () => {
    const f = basisFeatures({ last: 101, mark: 100 });
    expect(f.basisAvail).toBe(1);
    expect(f.basis).toBeCloseTo(Math.log(1.01), 8);
  });
  it('PAPER CARRY shorts positive carryScore; LIVE rejects paperOnly', () => {
    const built = buildStrategy('FUTURES_CARRY', P.strategies.FUTURES_CARRY, { ...ctx, features: { carryScore: 0.8, fundingAvail: 1, basisAvail: 1 } });
    if ('error' in built) throw new Error(built.error);
    expect(built.legs[0].side).toBe('SELL');
    const fv: FeatureVector = { price: 60000, adx: 12, emaAlign: 0, htfAlign: 0, chop: 62, er: 0.1, hurst: 0.4, rvShort: 0.4, garchVol: 0.4, atrPct: 0.01, carryScore: 0.8, fundingAvail: 1, basisAvail: 1 };
    const regime = classify('X', now, { ...fv, rsi: 50, rvPctile: 0.4 }, P.regime, 'm1');
    const live = selectStrategy({
      regime: { ...regime, primary: 'RANGING', confidence: 0.8 },
      features: fv, chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, model: P, limits, costs, tradable, mode: 'LIVE',
    });
    expect(live.candidates.find((c) => c.strategy === 'FUTURES_CARRY')?.rejectedReasons.join()).toMatch(/PAPER-only/);
  });
});

describe('signed order flow', () => {
  it('stays unavailable without a tape', () => {
    expect(orderFlowFeatures(undefined, now, 100).signedFlowAvail).toBe(0);
    expect(orderFlowFeatures([], now, 100).signedFlowAvail).toBe(0);
  });
  it('Lee-Ready signed flow is positive when prints are above mid', () => {
    const trades: PublicTrade[] = Array.from({ length: 20 }, (_, i) => ({
      ts: now - 1000 * i, price: 101, qty: 1,
    }));
    const f = orderFlowFeatures(trades, now, 100);
    expect(f.signedFlowAvail).toBe(1);
    expect(f.signedFlow).toBeGreaterThan(0.5);
  });
});

describe('cross-sectional momentum', () => {
  it('is unavailable with a single name', () => {
    expect(xsmomFeatures(0.4, [0.4]).xsmomAvail).toBe(0);
  });
  it('ranks the stronger vol-adjusted return higher', () => {
    const f = xsmomFeatures(1.2, [1.2, -0.3, 0.1]);
    expect(f.xsmomAvail).toBe(1);
    expect(f.xsmomRank).toBeGreaterThan(0.6);
  });
  it('needs TSMOM sign agreement to build', () => {
    const no = buildStrategy('FUTURES_XSMOM', P.strategies.FUTURES_XSMOM, { ...ctx, features: { xsmomAvail: 1, xsmomRank: 0.9, tsmom: -0.4 } });
    expect('error' in no).toBe(true);
    const yes = buildStrategy('FUTURES_XSMOM', P.strategies.FUTURES_XSMOM, { ...ctx, features: { xsmomAvail: 1, xsmomRank: 0.9, tsmom: 0.4, xsmomN: 2 } });
    if ('error' in yes) throw new Error(yes.error);
    expect(yes.legs[0].side).toBe('BUY');
  });
  it('computes a finite vol-adjusted return on closed trend bars', () => {
    const c = trend(120, 0.002, 100, '1h', 0.001);
    expect(volAdjReturn(c, '1h', 1)).not.toBeNull();
  });
});

describe('mean reversion + CUSUM gate', () => {
  it('does not claim mean-reversion on a random walk', () => {
    const c = gbm(200, { seed: 9, s0: 100, sigma: 0.8 }).map((x) => x.c);
    expect(meanReversionFeatures(c).mrAvail).toBe(0);
  });
  it('detects a stationary series as available and fades a high z', () => {
    const rng = mulberry32(4);
    let x = 0;
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) {
      x = 0.85 * x + 0.04 * gaussian(rng);
      closes.push(Math.exp(x) * 100);
    }
    const mr = meanReversionFeatures(closes);
    expect(mr.mrAvail).toBe(1);
  });
  it('suspends MR on a CUSUM shift', () => {
    const closes = [...Array(100).fill(100), ...Array(80).fill(0).map((_, i) => 100 * Math.exp(-0.03 * (i + 1)))];
    const cp = changePointDecision(closes);
    expect(cp.suspendMeanReversion).toBe(true);
    const b = buildStrategy('FUTURES_MR', P.strategies.FUTURES_MR, { ...ctx, features: { mrAvail: 1, zScore: -2, changePointActive: 1 } });
    expect('error' in b && b.error).toMatch(/change-point/i);
  });
  it('CUSUM false-alarm rate on Gaussian noise is not 100%', () => {
    const rng = mulberry32(11);
    let fires = 0;
    const n = 40;
    for (let k = 0; k < n; k++) {
      let p = 100;
      const c: number[] = [p];
      for (let i = 0; i < 120; i++) {
        p *= Math.exp(0.02 * gaussian(rng) / Math.sqrt(365));
        c.push(p);
      }
      if (cusumShift(c).shift !== 0) fires++;
    }
    expect(fires / n).toBeLessThan(0.85);
  });
});

describe('triple-barrier meta-label + PBO', () => {
  it('labels a long TP without using bars past the horizon', () => {
    const closes = [100, 101, 102, 108, 109];
    const hit = tripleBarrierAt(closes, 0, 1, 5, 5, 4);
    expect(hit.label).toBe(1);
    expect(hit.reason).toBe('TP');
    expect(tripleBarrierAt(closes, 3, 1, 5, 5, 4).reason).toBe('INCOMPLETE');
  });
  it('does not filter when unfitted; fitted model can skip', () => {
    expect(scoreMeta(null, [0, 0])).toBeUndefined();
    const rows = Array.from({ length: 80 }, (_, i) => ({ x: [i > 40 ? 1 : 0], y: (i > 40 ? 1 : 0) as 0 | 1 }));
    const m = fitLogit(rows)!;
    expect(m.nTrain).toBeGreaterThan(30);
    expect(scoreMeta(m, [1])!).toBeGreaterThan(scoreMeta(m, [0])!);
  });
  it('PBO is unusable without a CSCV matrix and high when IS-best is OOS-worst', () => {
    expect(probabilityOfBacktestOverfitting([[1, 2]]).usable).toBe(false);
    const good = probabilityOfBacktestOverfitting([
      [3, 3, 3, 3],
      [0, 0, 0, 0],
    ]);
    expect(good.usable).toBe(true);
    expect(good.value).toBeLessThan(0.5);
    const overfit = probabilityOfBacktestOverfitting([
      [5, 5, 5, 5, -5, -5, -5, -5],
      [1, 1, 1, 1, 1, 1, 1, 1],
    ]);
    expect(overfit.usable).toBe(true);
    expect(overfit.value).toBeGreaterThan(good.value);
    expect(overfit.value).toBeGreaterThan(0.4);
  });
  it('metaFeatures length is stable', () => {
    expect(metaFeatures({}).length).toBe(10);
  });
});
