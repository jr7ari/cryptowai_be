import { describe, it, expect, beforeAll } from 'vitest';
import { runBacktest, BASELINE_POLICIES } from '../src/backtest/engine.js';
import { generateRegimeSeries } from './fixtures/synthetic-data.js';
import { syntheticChainFromCandles } from './fixtures/synthetic-chain.js';
import type { HistoricalMarketView } from '../src/backtest/historical-view.js';

/** test-only option chains (production backtests replay REAL recorded chains) */
const fixtureChains = (sym: string, now: number, v: HistoricalMarketView) => {
  const c = v.closedCandles(sym, '1h');
  const p = v.lastPrice(sym);
  return p && c.length > 50 ? syntheticChainFromCandles('BTC', p.price, now, c.slice(-200), '1h', { vrp: 1.15, spreadPct: 3 }) : null;
};
import { walkForward } from '../src/learning/walkforward.js';
import { evaluatePromotion, evaluateLiveReadiness } from '../src/learning/promotion.js';
import { monitorAndRollback } from '../src/learning/monitor.js';
import { calibrateDrift, adjustAffinity } from '../src/learning/calibration.js';
import { defaultModelParams, modelHash } from '../src/model/params.js';
import { ModelRegistry } from '../src/model/registry.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { SimulatedClock } from '../src/lib/clock.js';
import type { TradeRecord } from '../src/persistence/ports.js';
import { testConfig } from './helpers.js';

const cfg = testConfig();
const synth = generateRegimeSeries({ start: Date.UTC(2025, 0, 1), bars: 2200, tf: '1h', startPrice: 60000, seed: 3 });
const model = { version: 'm1', params: defaultModelParams() };

describe('backtester', () => {
  let a: Awaited<ReturnType<typeof runBacktest>>;
  beforeAll(async () => {
    a = await runBacktest({ config: cfg, candles: { 'B-BTC_USDT': synth.candles }, baseTf: '1h', timeframes: ['1h', '4h'], decisionEveryBars: 4, warmupBars: 300, model, policy: { kind: 'REGIME_ENGINE' }, mcPaths: 100, chainProvider: fixtureChains });
  });
  it('is deterministic for the same inputs and seed', async () => {
    const b = await runBacktest({ config: cfg, candles: { 'B-BTC_USDT': synth.candles }, baseTf: '1h', timeframes: ['1h', '4h'], decisionEveryBars: 4, warmupBars: 300, model, policy: { kind: 'REGIME_ENGINE' }, mcPaths: 100, chainProvider: fixtureChains });
    expect(b.metrics.trades).toBe(a.metrics.trades);
    expect(b.metrics.totalPnl).toBeCloseTo(a.metrics.totalPnl, 8);
  });
  it('produces an equity curve, regime labels and per-regime breakdowns', () => {
    expect(a.equity.length).toBeGreaterThan(1000);
    expect(a.regimeLabels.length).toBe(a.decisions);
    expect(Object.keys(a.regimeCounts).length).toBeGreaterThan(2);
    const sum = Object.values(a.byRegime).reduce((s, m) => s + m.trades, 0);
    expect(sum).toBe(a.metrics.trades);
  });
  it('never violates the hard per-trade risk limit', () => {
    for (const t of a.trades) expect(t.maxLoss).toBeLessThanOrEqual((cfg.paper.startingBalance * 1.2 * cfg.risk.maxRiskPerTradePct) / 100);
    expect(a.curve.maxDrawdownPct).toBeLessThan(cfg.risk.maxDrawdownPct);
  });
  it('regime engine is more selective and has lower drawdown than naive always-in baselines', async () => {
    const naive = await runBacktest({ config: cfg, candles: { 'B-BTC_USDT': synth.candles }, baseTf: '1h', timeframes: ['1h', '4h'], decisionEveryBars: 4, warmupBars: 300, model, policy: BASELINE_POLICIES[1], chainProvider: fixtureChains });
    expect(naive.metrics.trades).toBeGreaterThan(a.metrics.trades);
    expect(a.curve.maxDrawdownPct).toBeLessThanOrEqual(naive.curve.maxDrawdownPct);
  });
  it('rejects look-ahead: truncating future data does not change past decisions', async () => {
    const cut = await runBacktest({ config: cfg, candles: { 'B-BTC_USDT': synth.candles.slice(0, 1500) }, baseTf: '1h', timeframes: ['1h', '4h'], decisionEveryBars: 4, warmupBars: 300, model, policy: { kind: 'REGIME_ENGINE' }, mcPaths: 100, chainProvider: fixtureChains });
    const n = cut.regimeLabels.length - 5;
    for (let i = 0; i < n; i++) {
      expect(cut.regimeLabels[i].regime).toBe(a.regimeLabels[i].regime);
      expect(cut.regimeLabels[i].confidence).toBeCloseTo(a.regimeLabels[i].confidence, 10);
    }
  });
});

describe('learning: calibration, walk-forward, promotion', () => {
  it('drift calibration uses only data before trainEnd and recovers the sign of a trend', () => {
    const labels = synth.candles.slice(300, 1500).map((c) => ({ ts: c.t + 3_600_000, symbol: 'S', regime: 'STRONG_UPTREND' as const, confidence: 1, price: c.c }));
    const up = synth.candles.map((c, i) => ({ ...c, c: 100 * Math.exp(i * 0.0005), o: 100, h: 1e9, l: 1 }));
    const r = calibrateDrift(labels, { S: up }, '1h', 24, up[1200].t);
    expect(r.drift.STRONG_UPTREND!).toBeGreaterThan(0);
    // no label whose forward window passes trainEnd may be used
    expect(r.samples.STRONG_UPTREND!).toBeLessThanOrEqual(1200 - 300);
  });
  it('affinity adjustment cuts significantly losing regime x strategy combos', () => {
    const p = defaultModelParams();
    const losing = Array.from({ length: 20 }, (_, i) => ({ regime: 'STRONG_UPTREND', strategy: 'LONG_CALL', returnOnRisk: -0.4 + (i % 3) * 0.05 }) as TradeRecord);
    const ch = adjustAffinity(p, losing);
    expect(ch.length).toBe(1);
    expect(p.affinity.STRONG_UPTREND.LONG_CALL!).toBeLessThan(0.8);
  });
  it('walk-forward runs end-to-end with OOS evidence and a governed promotion verdict', async () => {
    const data = generateRegimeSeries({ start: Date.UTC(2025, 0, 1), bars: 1700, tf: '1h', startPrice: 60000, seed: 9 }).candles;
    const wf = await walkForward({ config: cfg, candles: { 'B-BTC_USDT': data }, baseTf: '1h', timeframes: ['1h', '4h'], current: model, trainBars: 800, testBars: 300, folds: 2, decisionEveryBars: 6, candidates: 3, maxChangePct: 20, seed: 1, mcPaths: 60, chainProvider: fixtureChains });
    expect(wf.folds.length).toBe(2);
    for (const f of wf.folds) {
      expect(f.testFrom).toBeGreaterThanOrEqual(f.trainTo); // strict temporal separation
      expect(f.chosen.changes.length).toBeGreaterThan(0);
    }
    const v = evaluatePromotion(wf, { minOosTrades: 20, alpha: 0.05, maxDrawdownMultiple: 1.25 }, modelHash(model.params));
    expect(v.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['min_oos_trades', 'beats_current_oos', 'deflated_sharpe', 'pbo', 'beats_best_baseline']));
    expect(typeof v.promote).toBe('boolean');
  });
});

describe('model registry lifecycle, rollback and LIVE gating', () => {
  it('baseline -> candidate -> validated -> paper; rollback reverts to parent; experiments logged', async () => {
    const repos = createMemoryRepositories();
    const clock = new SimulatedClock(Date.UTC(2025, 5, 1));
    const reg = new ModelRegistry(repos, clock);
    const base = await reg.ensureBaseline();
    expect((await reg.active('PAPER'))!.version).toBe(base.version);
    expect(await reg.active('LIVE')).toBeNull(); // never live by default
    const p = defaultModelParams();
    p.exits.stopLossPct = 40;
    const cand = await reg.createCandidate(p, base.version, 'test', { oosExpectancyR: 0.1, oosMaxDrawdownPct: 2, oosRValues: Array(30).fill(0.1) });
    expect(cand.status).toBe('CANDIDATE');
    await expect(reg.activatePaper(cand.version)).rejects.toThrow(/VALIDATED/);
    await reg.markValidated(cand.version, {});
    await reg.activatePaper(cand.version);
    expect((await reg.active('PAPER'))!.version).toBe(cand.version);

    // the new model loses consistently in paper -> automatic rollback
    for (let i = 0; i < 20; i++) {
      await repos.trades.append({ positionId: `p${i}`, decisionId: 'd', mode: 'PAPER', source: 'PAPER', underlying: 'X', strategy: 'LONG_CALL', params: {}, modelVersion: cand.version, regime: 'STRONG_UPTREND', regimeConfidence: 1, featuresAtEntry: {}, openedAt: clock.now(), closedAt: clock.now() + i, holdingMs: 1, entryCost: 10, maxLoss: 10, realizedPnl: -4 - (i % 3), returnOnRisk: -0.4 - (i % 3) / 10, fees: 0, funding: 0, slippageCost: 0, mae: 0, mfe: 0, exitReason: 'STOP_LOSS', expectedValueAtEntry: 1, popAtEntry: 0.5 });
    }
    const rep = await monitorAndRollback(repos, reg, 'PAPER', { minTrades: 15, alpha: 0.05, drawdownMultiple: 1.5 });
    expect(rep.action).toBe('ROLLED_BACK');
    expect((await reg.active('PAPER'))!.version).toBe(base.version);
    const kinds = (await repos.experiments.list()).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['PROMOTION', 'ROLLBACK']));
    expect((await repos.experiments.verifyChain()).ok).toBe(true);
  });
  it('live readiness requires real paper evidence', () => {
    expect(evaluateLiveReadiness([], 20, 0.05).ready).toBe(false);
    const good = Array.from({ length: 40 }, (_, i) => ({ realizedPnl: i % 3 === 0 ? -5 : 8, returnOnRisk: i % 3 === 0 ? -0.5 : 0.8, fees: 0, holdingMs: 1, slippageCost: 0, expectedValueAtEntry: 1, closedAt: i }) as TradeRecord);
    expect(evaluateLiveReadiness(good, 20, 0.05).ready).toBe(true);
  });
});
