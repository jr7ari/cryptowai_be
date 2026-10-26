/**
 * Cross-sectional momentum: rank this symbol's vol-adjusted trailing return among liquid peers
 * on the SAME closed-bar horizon. With 2 names the rank is crude (0 or 1); n<2 → unavailable.
 * Ranking is not a standalone buy rule — selector still requires TSMOM sign agreement and risk gates.
 */
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../domain/types.js';

export interface XsMomFeatures {
  xsmomAvail: number;
  /** Percentile rank in [0, 1] among peers (1 = strongest vol-adjusted return). */
  xsmomRank: number;
  xsmomN: number;
  xsmomRet: number;
}

const empty: XsMomFeatures = { xsmomAvail: 0, xsmomRank: 0.5, xsmomN: 0, xsmomRet: 0 };

export function volAdjReturn(c: Candle[], tf: Timeframe, horizonDays = 7): number | null {
  if (c.length < 40) return null;
  const barsPerDay = 86_400_000 / TIMEFRAME_MS[tf];
  const h = Math.max(2, Math.round(horizonDays * barsPerDay));
  if (h >= c.length) return null;
  const last = c[c.length - 1].c;
  const prev = c[c.length - 1 - h].c;
  if (!(last > 0 && prev > 0)) return null;
  const r = Math.log(last / prev);
  const lr: number[] = [];
  for (let i = Math.max(1, c.length - Math.round(barsPerDay * 30)); i < c.length; i++) {
    if (c[i - 1].c > 0 && c[i].c > 0) lr.push(Math.log(c[i].c / c[i - 1].c));
  }
  if (lr.length < 10) return null;
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  const sd = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, lr.length - 1));
  if (!(sd > 0)) return null;
  return r / (sd * Math.sqrt(h));
}

export function xsmomFeatures(self: number | null, peers: Array<number | null>): XsMomFeatures {
  const xs = peers.filter((x): x is number => x !== null && Number.isFinite(x));
  if (self === null || !Number.isFinite(self) || xs.length < 2) return empty;
  const below = xs.filter((x) => x < self).length;
  const equal = xs.filter((x) => x === self).length;
  return {
    xsmomAvail: 1,
    xsmomRank: (below + 0.5 * equal) / xs.length,
    xsmomN: xs.length,
    xsmomRet: self,
  };
}
