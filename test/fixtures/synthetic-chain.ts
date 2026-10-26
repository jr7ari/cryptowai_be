/**
 * TEST FIXTURE ONLY - never imported by application code. Builds a parametric option chain so unit
 * tests can exercise pricing/analytics deterministically without network access.
 */
import type { Candle, OptionChainSnapshot, OptionContract, OptionType, Timeframe } from '../../src/domain/types.js';
import { bsPrice } from '../../src/options/pricing.js';
import { yearsTo, optionSymbol, computeChainMetrics } from '../../src/options/chain.js';
import { MS } from '../../src/lib/clock.js';
import { yangZhangVol, closeToCloseVol } from '../../src/indicators/volatility.js';

/** Crypto option expiry calendar (08:00 UTC): next N dailies, weeklies (Fri), and month-ends (last Fri). */
export function standardExpiries(now: number, opts = { dailies: 3, weeklies: 4, monthlies: 3 }): number[] {
  const set = new Set<number>();
  const at8 = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0);
  const today = new Date(now);
  for (let i = 0, added = 0; added < opts.dailies && i < 10; i++) {
    const t = at8(new Date(now + i * MS.d));
    if (t > now + MS.h) {
      set.add(t);
      added++;
    }
  }
  const dow = today.getUTCDay();
  let fri = at8(new Date(now + ((5 - dow + 7) % 7) * MS.d));
  if (fri <= now + MS.h) fri += 7 * MS.d;
  for (let i = 0; i < opts.weeklies; i++) set.add(fri + i * 7 * MS.d);
  for (let m = 0; m < opts.monthlies + 1 && set.size < 50; m++) {
    const y = today.getUTCFullYear();
    const mo = today.getUTCMonth() + m;
    const lastDay = new Date(Date.UTC(y, mo + 1, 0, 8));
    while (lastDay.getUTCDay() !== 5) lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    if (lastDay.getTime() > now + MS.h) set.add(lastDay.getTime());
  }
  return [...set].sort((a, b) => a - b);
}

export function strikeStep(spot: number): number {
  if (spot > 50_000) return 500;
  if (spot > 10_000) return 250;
  if (spot > 2_000) return 25;
  if (spot > 500) return 5;
  if (spot > 50) return 1;
  return 0.1;
}

export interface SurfaceParams {
  atmIv: number;
  /** IV change per unit of log-moneyness (negative = put skew). */
  skew: number;
  /** curvature of the smile. */
  smile: number;
  /** IV term slope per year (positive = contango). */
  termSlope: number;
}

/** Parametric smile: iv(k,T) = atm + skew*k + smile*k^2 + term*(T - 30d), floored. */
export function surfaceIv(p: SurfaceParams, spot: number, strike: number, T: number): number {
  const k = Math.log(strike / spot);
  const termAdj = p.termSlope * (T - 30 / 365);
  return Math.max(0.05, p.atmIv + p.skew * k + p.smile * k * k + termAdj);
}

export interface SyntheticChainOptions {
  underlying: string;
  spot: number;
  now: number;
  surface: SurfaceParams;
  rate?: number;
  spreadPct: number;
  strikesEachSide?: number;
  expiries?: number[];
  contractSize?: number;
}

export function buildSyntheticChain(o: SyntheticChainOptions): OptionChainSnapshot {
  const expiries = o.expiries ?? standardExpiries(o.now);
  const step = strikeStep(o.spot);
  const atm = Math.round(o.spot / step) * step;
  const n = o.strikesEachSide ?? 20;
  const contracts: OptionContract[] = [];
  for (const exp of expiries) {
    const T = yearsTo(exp, o.now);
    // widen strike grid with sqrt(T)
    const width = Math.max(1, Math.round((o.spot * o.surface.atmIv * Math.sqrt(T) * 2.5) / step / n));
    for (let i = -n; i <= n; i++) {
      const K = atm + i * step * width;
      if (K <= 0) continue;
      for (const type of ['C', 'P'] as OptionType[]) {
        const iv = surfaceIv(o.surface, o.spot, K, T);
        const mark = bsPrice({ S: o.spot, K, T, sigma: iv, r: o.rate ?? 0, type });
        // spread: percentage of premium, with a floor in underlying terms (tick-ish) for cheap wings
        const half = Math.max(mark * (o.spreadPct / 100) / 2, o.spot * 0.00005);
        contracts.push({
          symbol: optionSymbol(o.underlying, exp, K, type),
          underlying: o.underlying,
          strike: K,
          expiry: exp,
          type,
          bid: Math.max(0, mark - half),
          ask: mark + half,
          mark,
          iv,
          contractSize: o.contractSize ?? 1,
          source: 'TEST_FIXTURE',
        });
      }
    }
  }
  const snap: OptionChainSnapshot = {
    underlying: o.underlying,
    ts: o.now,
    spot: o.spot,
    rate: o.rate ?? 0,
    contracts,
    expiries,
    source: 'TEST_FIXTURE',
    metrics: { atmIv: o.surface.atmIv },
  };
  snap.metrics = computeChainMetrics(snap);
  return snap;
}


export function syntheticChainFromCandles(
  underlying: string,
  spot: number,
  now: number,
  candles: Candle[],
  tf: Timeframe,
  cfg: { vrp: number; spreadPct: number },
): OptionChainSnapshot | null {
  const n = Math.min(100, candles.length - 2);
  const rv = Math.max(closeToCloseVol(candles, n, tf) || 0, yangZhangVol(candles, n, tf) || 0) || NaN;
  if (!Number.isFinite(rv) || !(spot > 0)) return null;
  return buildSyntheticChain({ underlying, spot, now, surface: { atmIv: Math.max(0.15, rv * cfg.vrp), skew: -0.15, smile: 0.4, termSlope: 0 }, spreadPct: cfg.spreadPct });
}
