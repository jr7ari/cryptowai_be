/**
 * Data-driven calibration steps used by the walk-forward optimiser. All functions consume ONLY
 * in-sample (training) data passed in by the caller.
 */
import type { Candle, RegimeName, StrategyName, Timeframe } from '../domain/types.js';
import { REGIMES, STRATEGIES, TIMEFRAME_MS } from '../domain/types.js';
import type { ModelParams } from './../model/params.js';
import { PARAM_BOUNDS, getPath, setPath, enforceBounds } from '../model/params.js';
import type { RegimeLabel } from '../backtest/engine.js';
import type { TradeRecord } from '../persistence/ports.js';
import { mean, clamp, mulberry32 } from '../lib/math.js';
import { oneSampleT } from './stats.js';

/**
 * Estimate annualised drift per regime from forward log-returns over `horizonBars` after each
 * labelled decision point, with James-Stein-style shrinkage toward 0: d * n/(n + k).
 * Labels whose forward window extends past `trainEnd` are discarded (no leakage into the test set).
 */
export function calibrateDrift(
  labels: RegimeLabel[],
  candles: Record<string, Candle[]>,
  tf: Timeframe,
  horizonBars: number,
  trainEnd: number,
  shrinkK = 60,
): { drift: Partial<Record<RegimeName, number>>; samples: Partial<Record<RegimeName, number>> } {
  const ms = TIMEFRAME_MS[tf];
  const index = new Map<string, Map<number, number>>();
  for (const [sym, cs] of Object.entries(candles)) index.set(sym, new Map(cs.map((c, i) => [c.t + ms, i])));
  const byRegime = new Map<RegimeName, number[]>();
  for (const l of labels) {
    const idx = index.get(l.symbol)?.get(l.ts);
    if (idx === undefined) continue;
    const cs = candles[l.symbol];
    const j = idx + horizonBars;
    if (j >= cs.length || cs[j].t + ms > trainEnd) continue;
    const r = Math.log(cs[j].c / cs[idx].c);
    if (!Number.isFinite(r)) continue;
    if (!byRegime.has(l.regime)) byRegime.set(l.regime, []);
    byRegime.get(l.regime)!.push(r);
  }
  const perYear = (365 * 86_400_000) / (ms * horizonBars);
  const drift: Partial<Record<RegimeName, number>> = {};
  const samples: Partial<Record<RegimeName, number>> = {};
  for (const r of REGIMES) {
    const xs = byRegime.get(r) ?? [];
    samples[r] = xs.length;
    if (xs.length < 5) continue;
    // overlapping windows inflate n; use effective sample size n / horizon (min 1)
    const nEff = Math.max(1, xs.length / Math.max(1, horizonBars / 4));
    const annual = mean(xs) * perYear;
    drift[r] = clamp(annual * (nEff / (nEff + shrinkK)), -0.8, 0.8);
  }
  return { drift, samples };
}

/**
 * Lower affinity for regime x strategy combinations whose in-sample trades lose money with
 * statistical support (one-sided t-test), raise slightly for significant winners. Bounded steps.
 */
export function adjustAffinity(p: ModelParams, trades: TradeRecord[], alpha = 0.1, step = 0.25, minTrades = 8): string[] {
  const changes: string[] = [];
  for (const r of REGIMES) {
    for (const s of STRATEGIES) {
      const rs = trades.filter((t) => t.regime === r && t.strategy === s).map((t) => t.returnOnRisk);
      if (rs.length < minTrades) continue;
      const cur = p.affinity[r]?.[s] ?? 0;
      const test = oneSampleT(rs, 0);
      if (test.pLess < alpha && cur > 0) {
        p.affinity[r] = { ...p.affinity[r], [s]: clamp(cur - step, 0, 1) };
        changes.push(`affinity.${r}.${s} ${cur.toFixed(2)} -> ${(cur - step).toFixed(2)} (mean R ${mean(rs).toFixed(3)}, p=${test.pLess.toFixed(3)})`);
      } else if (test.pGreater < alpha && cur > 0 && cur < 1) {
        p.affinity[r] = { ...p.affinity[r], [s]: clamp(cur + step / 2, 0, 1) };
        changes.push(`affinity.${r}.${s} ${cur.toFixed(2)} -> ${Math.min(1, cur + step / 2).toFixed(2)} (mean R ${mean(rs).toFixed(3)}, p=${test.pGreater.toFixed(3)})`);
      }
    }
  }
  return changes;
}

/** Parameters the optimiser perturbs (subset of PARAM_BOUNDS that matter most; affinity handled separately). */
export const TUNABLE = [
  'forecast.momentumSharpe',
  'forecast.wRegimeDrift',
  'forecast.fundingTilt',
  'sizing.targetVol',
  'selection.wVrp',
  'selection.vrpMinSell',
  'selection.vrpMaxBuy',
  'regime.adxTrend',
  'regime.adxRange',
  'regime.chopHigh',
  'regime.erTrend',
  'regime.minScore',
  'regime.breakoutVolumeZ',
  'selection.minScore',
  'selection.wEv',
  'selection.wAffinity',
  'forecast.wGarch',
  'forecast.wRv',
  'forecast.wIv',
  'sizing.riskMultiplier',
  'exits.stopLossPct',
  'exits.takeProfitPct',
  'exits.trailingActivationPct',
  'exits.trailingDistancePct',
  'exits.maxHoldHours',
  ...(['LONG_CALL', 'LONG_PUT', 'BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD', 'IRON_CONDOR', 'LONG_STRADDLE', 'BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD'] as StrategyName[]).flatMap((s) => [
    `strategies.${s}.targetDte`,
    `strategies.${s}.longDelta`,
    `strategies.${s}.shortDelta`,
  ]),
];

/**
 * Random bounded perturbation: each selected param moves by at most `maxChangePct`% of its
 * allowed range. Controlled, small, reproducible changes (seeded) - no unbounded search.
 */
export function perturb(base: ModelParams, maxChangePct: number, seed: number, nParams = 6): { params: ModelParams; changed: string[] } {
  const rng = mulberry32(seed);
  const p = structuredClone(base);
  const pool = [...TUNABLE];
  const changed: string[] = [];
  for (let k = 0; k < nParams && pool.length; k++) {
    const path = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    const [lo, hi] = PARAM_BOUNDS[path];
    const v = getPath(p, path);
    if (typeof v !== 'number') continue;
    const delta = (rng() * 2 - 1) * (maxChangePct / 100) * (hi - lo);
    let nv = clamp(v + delta, lo, hi);
    if (path.endsWith('targetDte') || path.endsWith('maxHoldHours')) nv = Math.round(nv);
    setPath(p, path, nv);
    changed.push(`${path}: ${round(v)} -> ${round(nv)}`);
  }
  enforceBounds(p);
  return { params: p, changed };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
