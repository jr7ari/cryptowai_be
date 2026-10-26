/**
 * Rolling z-score + AR(1) half-life on CLOSED log prices. If the series looks like a random walk
 * (half-life huge / AR coef >= 1) the feature is unavailable — do not fade a trend.
 */
import { clamp } from '../lib/math.js';

export interface MrFeatures {
  mrAvail: number;
  zScore: number;
  halfLifeBars: number;
}

const empty: MrFeatures = { mrAvail: 0, zScore: 0, halfLifeBars: 0 };

export function meanReversionFeatures(closes: number[], lookback = 120): MrFeatures {
  if (closes.length < lookback + 5) return empty;
  const x = closes.slice(-lookback).map((c) => Math.log(c)).filter(Number.isFinite);
  if (x.length < lookback) return empty;
  const mu = x.reduce((a, b) => a + b, 0) / x.length;
  const v = x.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, x.length - 1);
  const sd = Math.sqrt(Math.max(v, 1e-16));
  const z = (x[x.length - 1] - mu) / sd;
  const { phi, halfLife } = ar1HalfLife(x.map((v) => v - mu));
  // Short I(1) windows bias phi down; 120 bars + phi<0.88 is the RW discriminator (VR is too noisy here).
  const ok = phi > 0.15 && phi < 0.88 && halfLife >= 1.5 && halfLife <= 24;
  if (!ok) return { mrAvail: 0, zScore: z, halfLifeBars: halfLife };
  return { mrAvail: 1, zScore: clamp(z, -6, 6), halfLifeBars: halfLife };
}

/** Overlapping Lo–MacKinlay variance ratio on log-price increments. RW → ~1; MR → <1. */
export function varianceRatio(logPx: number[], q: number): number {
  if (logPx.length < q * 5) return 1;
  const r: number[] = [];
  for (let i = 1; i < logPx.length; i++) r.push(logPx[i] - logPx[i - 1]);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const var1 = r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1);
  if (!(var1 > 0)) return 1;
  const rq: number[] = [];
  for (let i = q; i <= r.length; i++) {
    let s = 0;
    for (let j = i - q; j < i; j++) s += r[j];
    rq.push(s);
  }
  const mq = rq.reduce((a, b) => a + b, 0) / rq.length;
  const varq = rq.reduce((a, b) => a + (b - mq) ** 2, 0) / Math.max(1, rq.length - 1);
  return varq / (q * var1);
}

export function ar1HalfLife(demeaned: number[]): { phi: number; halfLife: number } {
  if (demeaned.length < 10) return { phi: 1, halfLife: Infinity };
  let num = 0;
  let den = 0;
  for (let i = 1; i < demeaned.length; i++) {
    num += demeaned[i] * demeaned[i - 1];
    den += demeaned[i - 1] * demeaned[i - 1];
  }
  const phi = den > 0 ? num / den : 1;
  if (!(phi > 0) || phi >= 1) return { phi, halfLife: Infinity };
  return { phi, halfLife: Math.log(2) / -Math.log(phi) };
}
