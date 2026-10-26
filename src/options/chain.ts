/**
 * Option-chain analytics over REAL option chains (Deribit public API reference data, or CoinDCX if an
 * options API is ever published). The app never fabricates option quotes.
 */
import type { OptionChainSnapshot, OptionContract, ChainMetrics, OptionType } from '../domain/types.js';
import { bsPrice, bsGreeks } from './pricing.js';
import { YEAR_MS, MS } from '../lib/clock.js';

export const yearsTo = (expiry: number, now: number) => Math.max(0, (expiry - now) / YEAR_MS);

export function optionSymbol(underlying: string, expiry: number, strike: number, type: OptionType): string {
  const d = new Date(expiry);
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()];
  return `${underlying}-${d.getUTCDate()}${mon}${String(d.getUTCFullYear()).slice(2)}-${strike}-${type}`;
}

/** Nearest expiry to a target DTE, within [minDays,maxDays]. */
export function pickExpiry(expiries: number[], now: number, targetDays: number, minDays: number, maxDays: number): number | null {
  const ok = expiries.filter((e) => e - now >= minDays * MS.d && e - now <= maxDays * MS.d);
  if (!ok.length) return null;
  return ok.reduce((best, e) => (Math.abs(e - now - targetDays * MS.d) < Math.abs(best - now - targetDays * MS.d) ? e : best));
}

export function contractsFor(chain: OptionChainSnapshot, expiry: number, type: OptionType): OptionContract[] {
  return chain.contracts.filter((c) => c.expiry === expiry && c.type === type).sort((a, b) => a.strike - b.strike);
}

/** Contract whose BS delta is closest to `targetDelta` (abs for puts accepted either sign). */
export function contractByDelta(chain: OptionChainSnapshot, expiry: number, type: OptionType, targetDelta: number, now: number): OptionContract | null {
  const list = contractsFor(chain, expiry, type);
  const T = yearsTo(expiry, now);
  let best: OptionContract | null = null;
  let bestDiff = Infinity;
  const tgt = type === 'P' ? -Math.abs(targetDelta) : Math.abs(targetDelta);
  for (const c of list) {
    if (c.ask <= 0) continue;
    const d = bsGreeks({ S: chain.spot, K: c.strike, T, sigma: c.iv, r: chain.rate, type }).delta;
    const diff = Math.abs(d - tgt);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

export function contractByStrike(chain: OptionChainSnapshot, expiry: number, type: OptionType, strike: number): OptionContract | null {
  const list = contractsFor(chain, expiry, type);
  if (!list.length) return null;
  return list.reduce((b, c) => (Math.abs(c.strike - strike) < Math.abs(b.strike - strike) ? c : b));
}

/** Interpolated IV for any strike/expiry from the chain (linear in strike, then in total variance across expiries). */
export function interpolateIv(chain: OptionChainSnapshot, strike: number, expiry: number, now: number): number {
  const exps = [...chain.expiries].sort((a, b) => a - b);
  const ivAt = (e: number) => {
    const list = chain.contracts.filter((c) => c.expiry === e && c.type === (strike >= chain.spot ? 'C' : 'P')).sort((a, b) => a.strike - b.strike);
    if (!list.length) return chain.metrics.atmIv;
    if (strike <= list[0].strike) return list[0].iv;
    if (strike >= list[list.length - 1].strike) return list[list.length - 1].iv;
    for (let i = 1; i < list.length; i++) {
      if (strike <= list[i].strike) {
        const w = (strike - list[i - 1].strike) / (list[i].strike - list[i - 1].strike);
        return list[i - 1].iv * (1 - w) + list[i].iv * w;
      }
    }
    return chain.metrics.atmIv;
  };
  if (!exps.length) return chain.metrics.atmIv;
  if (expiry <= exps[0]) return ivAt(exps[0]);
  if (expiry >= exps[exps.length - 1]) return ivAt(exps[exps.length - 1]);
  for (let i = 1; i < exps.length; i++) {
    if (expiry <= exps[i]) {
      const t0 = yearsTo(exps[i - 1], now);
      const t1 = yearsTo(exps[i], now);
      const t = yearsTo(expiry, now);
      const v0 = ivAt(exps[i - 1]) ** 2 * t0;
      const v1 = ivAt(exps[i]) ** 2 * t1;
      const w = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const v = v0 + (v1 - v0) * w;
      return t > 0 ? Math.sqrt(Math.max(v, 1e-6) / t) : ivAt(exps[i]);
    }
  }
  return chain.metrics.atmIv;
}

export function computeChainMetrics(chain: OptionChainSnapshot): ChainMetrics {
  const now = chain.ts;
  const exps = chain.expiries.filter((e) => e - now > 2 * MS.d).sort((a, b) => a - b);
  const near = exps.find((e) => e - now >= 7 * MS.d) ?? exps[0];
  const far = exps[exps.length - 1];
  const atmIvAt = (e: number | undefined) => {
    if (e === undefined) return NaN;
    const calls = contractsFor(chain, e, 'C');
    const puts = contractsFor(chain, e, 'P');
    if (!calls.length || !puts.length) return NaN;
    const c = calls.reduce((b, x) => (Math.abs(x.strike - chain.spot) < Math.abs(b.strike - chain.spot) ? x : b));
    const p = puts.reduce((b, x) => (Math.abs(x.strike - chain.spot) < Math.abs(b.strike - chain.spot) ? x : b));
    return (c.iv + p.iv) / 2;
  };
  const atmIv = atmIvAt(near);
  let rr: number | undefined;
  let bf: number | undefined;
  if (near !== undefined) {
    const c25 = contractByDelta(chain, near, 'C', 0.25, now);
    const p25 = contractByDelta(chain, near, 'P', 0.25, now);
    if (c25 && p25 && Number.isFinite(atmIv)) {
      rr = c25.iv - p25.iv;
      bf = (c25.iv + p25.iv) / 2 - atmIv;
    }
  }
  let callOi = 0;
  let putOi = 0;
  let callVol = 0;
  let putVol = 0;
  for (const c of chain.contracts) {
    if (c.type === 'C') {
      callOi += c.openInterest ?? 0;
      callVol += c.volume24h ?? 0;
    } else {
      putOi += c.openInterest ?? 0;
      putVol += c.volume24h ?? 0;
    }
  }
  return {
    atmIv: Number.isFinite(atmIv) ? atmIv : chain.metrics?.atmIv ?? NaN,
    riskReversal25d: rr,
    butterfly25d: bf,
    termSlope: far !== undefined && near !== undefined && far !== near ? atmIvAt(far) - atmIv : undefined,
    pcrOpenInterest: callOi > 0 ? putOi / callOi : undefined,
    pcrVolume: callVol > 0 ? putVol / callVol : undefined,
    maxPain: near !== undefined ? maxPain(chain, near) : undefined,
    totalOpenInterest: callOi + putOi || undefined,
  };
}

/** Strike minimising total intrinsic value paid to option holders at expiry. */
export function maxPain(chain: OptionChainSnapshot, expiry: number): number | undefined {
  const list = chain.contracts.filter((c) => c.expiry === expiry && (c.openInterest ?? 0) > 0);
  if (!list.length) return undefined;
  const strikes = [...new Set(list.map((c) => c.strike))].sort((a, b) => a - b);
  let best = strikes[0];
  let bestPain = Infinity;
  for (const s of strikes) {
    let pain = 0;
    for (const c of list) pain += (c.openInterest ?? 0) * Math.max(0, c.type === 'C' ? s - c.strike : c.strike - s);
    if (pain < bestPain) {
      bestPain = pain;
      best = s;
    }
  }
  return best;
}

/** Dealer gamma exposure proxy (assumes dealers short calls/long puts convention). Units: $ per 1% move. */
export function gammaExposure(chain: OptionChainSnapshot): number {
  let gex = 0;
  for (const c of chain.contracts) {
    const oi = c.openInterest ?? 0;
    if (!oi) continue;
    const T = yearsTo(c.expiry, chain.ts);
    const g = bsGreeks({ S: chain.spot, K: c.strike, T, sigma: c.iv, r: chain.rate, type: c.type }).gamma;
    gex += (c.type === 'C' ? 1 : -1) * g * oi * c.contractSize * chain.spot * chain.spot * 0.01;
  }
  return gex;
}

/** IV rank (0..1) and percentile (0..1) from a history of ATM IVs. */
export function ivRankPercentile(history: number[], current: number): { rank: number; percentile: number } {
  const h = history.filter(Number.isFinite);
  if (h.length < 5 || !Number.isFinite(current)) return { rank: NaN, percentile: NaN };
  const lo = Math.min(...h);
  const hi = Math.max(...h);
  return { rank: hi === lo ? 0.5 : (current - lo) / (hi - lo), percentile: h.filter((x) => x < current).length / h.length };
}
