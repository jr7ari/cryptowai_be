import { describe, it, expect } from 'vitest';
import { classify, scoreRegimes } from '../src/regime/classifier.js';
import { extractFeatures, interpretFeatures } from '../src/regime/features.js';
import { defaultModelParams } from '../src/model/params.js';
import { buildStrategy } from '../src/strategies/builders.js';
import { evaluate, simulatePaths, type CostModel } from '../src/strategies/evaluate.js';
import { selectStrategy } from '../src/strategies/selector.js';
import { buildSyntheticChain } from './fixtures/synthetic-chain.js';
import { hardRiskLimits } from '../src/config/index.js';
import { STRATEGIES, type FeatureVector, type StrategyName } from '../src/domain/types.js';
import { gbm, trend, testConfig } from './helpers.js';
import { aggregate } from '../src/marketdata/view.js';

const P = defaultModelParams();
const base: FeatureVector = {
  price: 100, adx: 20, diDiff: 0, emaAlign: 0, htfAlign: 0, er: 0.2, chop: 50, r2: 0.3, slope: 0, rvPctile: 0.5, rvRatio: 1, atrPctile: 0.5,
  volumeZ: 0, rsi: 50, hurst: 0.5, supertrendDir: 1, supertrendFlips30: 1, supertrendFlipAgo: 20, donchianPos: 0.5, breakoutUp: 0, breakoutDown: 0,
  squeeze: 0, squeezeRelease: 0, bbWidthPctile: 0.5, macdHistN: 0, macdCross: 0, divergence: 0, rsiMin10: 45, rsiMax10: 55, ret20: 0, ret50: 0, tfAgreement: 0,
};

describe('regime classifier', () => {
  it('identifies a strong uptrend with high confidence', () => {
    const fv = { ...base, adx: 38, diDiff: 0.5, emaAlign: 1, htfAlign: 1, er: 0.6, chop: 30, r2: 0.9, slope: 0.3, supertrendDir: 1, ichimoku: 1, tfAgreement: 1, hurst: 0.62, ret20: 0.08 };
    const r = classify('X', 0, fv, P.regime, 'm1');
    expect(r.primary).toBe('STRONG_UPTREND');
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.direction).toBe('BULL');
  });
  it('identifies a strong downtrend (mirror)', () => {
    const fv = { ...base, adx: 38, diDiff: -0.5, emaAlign: -1, htfAlign: -1, er: 0.6, chop: 30, r2: 0.9, slope: -0.3, supertrendDir: -1, ichimoku: -1, tfAgreement: 1, ret20: -0.08 };
    expect(classify('X', 0, fv, P.regime, 'm1').primary).toBe('STRONG_DOWNTREND');
  });
  it('identifies ranging markets', () => {
    const fv = { ...base, adx: 12, emaAlign: 0, htfAlign: 0.25, chop: 62, er: 0.1, hurst: 0.4, autocorr: -0.1, rvPctile: 0.4 };
    const r = classify('X', 0, fv, P.regime, 'm1');
    expect(['RANGING', 'CHOPPY']).toContain(r.primary);
    expect(r.scores.RANGING).toBeGreaterThan(r.scores.STRONG_UPTREND);
  });
  it('identifies breakouts on channel break with volume and squeeze release', () => {
    const fv = { ...base, breakoutUp: 0.8, breakout55Up: 1, volumeZ: 2.5, squeezeRelease: 1, rvRatio: 1.3, adxSlope: 3, macdHistN: 0.4, adx: 24, emaAlign: 0.5, htfAlign: 0.25 };
    expect(classify('X', 0, fv, P.regime, 'm1').primary).toBe('BREAKOUT');
  });
  it('identifies low volatility compression', () => {
    const fv = { ...base, rvPctile: 0.05, squeeze: 1, bbWidthPctile: 0.05, rvRatio: 0.7, ivRank: 0.1 };
    const r = classify('X', 0, fv, P.regime, 'm1');
    expect(r.scores.LOW_VOLATILITY).toBeGreaterThan(0.6);
    expect(r.volState).toBe('LOW');
  });
  it('falls back to CHOPPY when no regime is convincing', () => {
    const r = classify('X', 0, { ...base }, { ...P.regime, minScore: 0.95 }, 'm1');
    expect(r.primary).toBe('CHOPPY');
  });
  it('hysteresis keeps the previous regime on marginal changes', () => {
    const up = { ...base, adx: 30, diDiff: 0.3, emaAlign: 0.75, htfAlign: 0.75, er: 0.45, r2: 0.7, slope: 0.2 };
    const first = classify('X', 0, up, P.regime, 'm1');
    const s = scoreRegimes(up, P.regime).scores;
    expect(first.primary).toBe('STRONG_UPTREND');
    const second = classify('X', 1, { ...up, breakoutUp: 0.1, volumeZ: 1.3 }, { ...P.regime, hysteresis: 0.5 }, 'm1', { prev: first });
    expect(second.primary).toBe('STRONG_UPTREND');
    expect(s.STRONG_UPTREND).toBeGreaterThan(0.5);
  });
  it('extracts features from real candle sequences and interprets them', () => {
    const c = trend(600, 0.002, 100, '1h', 0.002);
    const fv = extractFeatures({ candles: { '1h': c, '4h': aggregate(c, '4h') }, decisionTf: '1h', higherTfs: ['4h'] });
    expect(fv.emaAlign).toBeGreaterThan(0.5);
    expect(fv.adx).toBeGreaterThan(20);
    expect(Object.values(fv).every(Number.isFinite)).toBe(true);
    expect(interpretFeatures(fv).length).toBeGreaterThan(10);
    const r = classify('X', 0, fv, P.regime, 'm1');
    expect(['STRONG_UPTREND', 'BREAKOUT']).toContain(r.primary);
  });
});

const now = Date.UTC(2026, 0, 5, 12);
const chain = buildSyntheticChain({ underlying: 'BTC', spot: 60000, now, surface: { atmIv: 0.6, skew: -0.15, smile: 0.4, termSlope: 0 }, spreadPct: 3 });
const costs: CostModel = { optionFeePctOfUnderlying: 0.03, optionFeeCapPctOfPremium: 12.5, futuresTakerFeeBps: 5, slippageBps: 5, fundingIntervalHours: 8, fundingRatePerInterval: 0.0001 };
const ctx = { chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, minDte: 2, maxDte: 45, atr: 600 };
const ectx = { spot: 60000, now, rate: 0, forecastVol: 0.6, drift: 0, holdHours: 72, expiryBufferHours: 12, takeProfitPct: 80, stopLossPct: 50, costs };

describe('strategy builders & evaluation', () => {
  it('builds every strategy with valid structure', () => {
    for (const s of STRATEGIES) {
      const b = buildStrategy(s, P.strategies[s], {
        ...ctx,
        features: {
          tsmom: 0.6, tsmomAgreement: 1, atrPct_1d: 0.03, rvDaily: 0.6,
          carryScore: 0.8, fundingAvail: 1, basisAvail: 1,
          xsmomAvail: 1, xsmomRank: 0.9, xsmomN: 2,
          mrAvail: 1, zScore: -2.2, halfLifeBars: 8, changePointActive: 0,
          donchianAvail: 1, donchianLong: 0.8, donchianShort: 0, donchianN: 9, donchianStopDist: 0.06,
        },
      });
      expect('error' in b, `${s}: ${'error' in b ? b.error : ''}`).toBe(false);
    }
  });
  it('bull call spread: max loss = debit + costs, capped max profit, one breakeven', () => {
    const b = buildStrategy('BULL_CALL_SPREAD', P.strategies.BULL_CALL_SPREAD, ctx);
    if ('error' in b) throw new Error(b.error);
    const e = evaluate(b.legs, ectx);
    expect(e.netPremium).toBeGreaterThan(0);
    expect(e.maxLoss).toBeCloseTo(e.netPremium + e.costs.fees + e.costs.slippage, 4);
    const width = b.legs[1].option!.strike - b.legs[0].option!.strike;
    expect(e.maxProfit!).toBeLessThan(width);
    expect(e.breakevens.length).toBe(1);
    expect(e.greeks.delta).toBeGreaterThan(0);
  });
  it('long call has unbounded max profit; long put positive vega', () => {
    const c = buildStrategy('LONG_CALL', P.strategies.LONG_CALL, ctx);
    if ('error' in c) throw new Error(c.error);
    expect(evaluate(c.legs, ectx).maxProfit).toBeNull();
    const p = buildStrategy('LONG_PUT', P.strategies.LONG_PUT, ctx);
    if ('error' in p) throw new Error(p.error);
    const e = evaluate(p.legs, ectx);
    expect(e.greeks.vega).toBeGreaterThan(0);
    expect(e.greeks.delta).toBeLessThan(0);
  });
  it('iron condor: credit, defined max loss < wing width, two breakevens, short vega', () => {
    const b = buildStrategy('IRON_CONDOR', P.strategies.IRON_CONDOR, ctx);
    if ('error' in b) throw new Error(b.error);
    const e = evaluate(b.legs, ectx);
    expect(e.netPremium).toBeLessThan(0);
    const putWidth = b.legs[0].option!.strike - b.legs[1].option!.strike;
    const callWidth = b.legs[3].option!.strike - b.legs[2].option!.strike;
    expect(e.maxLoss).toBeLessThan(Math.max(putWidth, callWidth));
    expect(e.breakevens.length).toBe(2);
    expect(e.greeks.vega).toBeLessThan(0);
  });
  it('EV reacts to vol edge: straddle EV rises when forecast vol > implied', () => {
    const b = buildStrategy('LONG_STRADDLE', P.strategies.LONG_STRADDLE, ctx);
    if ('error' in b) throw new Error(b.error);
    const lo = evaluate(b.legs, { ...ectx, forecastVol: 0.3, paths: 400, seed: 1 });
    const hi = evaluate(b.legs, { ...ectx, forecastVol: 1.2, paths: 400, seed: 1 });
    expect(hi.expectedValue).toBeGreaterThan(lo.expectedValue);
    expect(hi.path!.paths).toBe(400);
  });
  it('path simulation respects stops: never loses more than ~stop on a debit structure', () => {
    const res = simulatePaths({ spot: 100, H: 0.05, sigma: 0.8, mu: 0, steps: 24, pairs: 300, seed: 2, riskBase: 10, stopLossPct: 50, takeProfitPct: 100, trailingActivationPct: Infinity, trailingDistancePct: Infinity, pnlAt: (s) => Math.max(-10, (s - 100) * 0.5) });
    expect(res.stats.stopHitPct).toBeGreaterThan(0);
    expect(res.stats.p5).toBeGreaterThanOrEqual(-10);
  });
  it('futures evaluation uses stop distance as max loss', () => {
    const b = buildStrategy('FUTURES_LONG', P.strategies.FUTURES_LONG, { ...ctx, bid: 59990, ask: 60010 });
    if ('error' in b) throw new Error(b.error);
    const e = evaluate(b.legs, { ...ectx, stopDistance: b.stopDistance, leverage: 2 });
    expect(e.maxLoss).toBeGreaterThan(b.stopDistance!);
    expect(e.marginRequired).toBeCloseTo(60010 / 2, 0);
  });
});

describe('strategy selection', () => {
  const cfg = testConfig();
  const limits = hardRiskLimits(cfg);
  const tradable = new Set<StrategyName>(STRATEGIES);
  it('selects nothing in CHOPPY', () => {
    const regime = classify('X', now, { ...base }, { ...P.regime, minScore: 0.99 }, 'm1');
    const r = selectStrategy({ regime, features: { rvShort: 0.6, garchVol: 0.6, atrPct: 0.01 }, chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, model: P, limits, costs, tradable });
    expect(r.selected).toBeNull();
    expect(r.rationale).toMatch(/CHOPPY/);
  });
  it('only considers strategies with regime affinity, and honours the capability gate', () => {
    const fv = { ...base, adx: 38, diDiff: 0.5, emaAlign: 1, htfAlign: 1, er: 0.6, chop: 30, r2: 0.9, slope: 0.3, ichimoku: 1, tfAgreement: 1 };
    const regime = classify('X', now, fv, P.regime, 'm1');
    const r = selectStrategy({ regime, features: { ...fv, rvShort: 0.6, garchVol: 0.6, atrPct: 0.01 }, chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, model: P, limits, costs, tradable: new Set(['FUTURES_LONG']) });
    const names = r.candidates.map((c) => c.strategy);
    expect(names).not.toContain('IRON_CONDOR');
    const lc = r.candidates.find((c) => c.strategy === 'LONG_CALL')!;
    expect(lc.eligible).toBe(false);
    expect(lc.rejectedReasons.join()).toMatch(/capability/);
  });
  it('no-trade when EV filter cannot be met (costs > edge)', () => {
    const regime = classify('X', now, { ...base, rvPctile: 0.05, squeeze: 1, bbWidthPctile: 0.05, rvRatio: 0.7 }, P.regime, 'm1');
    const r = selectStrategy({
      regime: { ...regime, primary: 'LOW_VOLATILITY', confidence: 0.9 },
      features: { rvShort: 0.2, garchVol: 0.2, ivAtm: 0.6, atrPct: 0.003 },
      chain, futuresInstrument: 'B-BTC_USDT', spot: 60000, now, model: P, limits, costs, tradable, mcPaths: 200,
    });
    // forecast vol (~0.2-0.3) far below implied 0.6 -> long straddle must be rejected
    const st = r.candidates.find((c) => c.strategy === 'LONG_STRADDLE')!;
    expect(st.eligible).toBe(false);
  });
  it('features are finite for noisy input', () => {
    const c = gbm(500, { seed: 21 });
    const fv = extractFeatures({ candles: { '1h': c }, decisionTf: '1h', higherTfs: [] });
    expect(Object.values(fv).every(Number.isFinite)).toBe(true);
  });
});
