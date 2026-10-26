/**
 * Realized volatility estimators (annualised, crypto trades 24/7/365) and forecasts.
 * Range-based estimators are 5-8x more efficient than close-to-close for the same sample.
 */
import type { Candle, Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import { logReturns } from './core.js';

export const barsPerYear = (tf: Timeframe) => (365 * 86_400_000) / TIMEFRAME_MS[tf];

const tail = <T>(a: T[], n: number) => a.slice(Math.max(0, a.length - n));

export function closeToCloseVol(c: Candle[], n: number, tf: Timeframe): number {
  const r = tail(logReturns(c.map((x) => x.c)), n).filter(Number.isFinite);
  if (r.length < 2) return NaN;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * barsPerYear(tf));
}

export function parkinsonVol(c: Candle[], n: number, tf: Timeframe): number {
  const w = tail(c, n);
  if (w.length < 2) return NaN;
  const s = w.reduce((a, x) => a + Math.log(x.h / x.l) ** 2, 0);
  return Math.sqrt((s / (4 * Math.log(2) * w.length)) * barsPerYear(tf));
}

export function garmanKlassVol(c: Candle[], n: number, tf: Timeframe): number {
  const w = tail(c, n);
  if (w.length < 2) return NaN;
  const s = w.reduce((a, x) => a + 0.5 * Math.log(x.h / x.l) ** 2 - (2 * Math.log(2) - 1) * Math.log(x.c / x.o) ** 2, 0);
  return Math.sqrt(Math.max(0, s / w.length) * barsPerYear(tf));
}

export function rogersSatchellVol(c: Candle[], n: number, tf: Timeframe): number {
  const w = tail(c, n);
  if (w.length < 2) return NaN;
  const s = w.reduce((a, x) => a + Math.log(x.h / x.c) * Math.log(x.h / x.o) + Math.log(x.l / x.c) * Math.log(x.l / x.o), 0);
  return Math.sqrt(Math.max(0, s / w.length) * barsPerYear(tf));
}

/** Yang-Zhang: drift-independent, handles opening jumps. Default estimator. */
export function yangZhangVol(c: Candle[], n: number, tf: Timeframe): number {
  const w = tail(c, n + 1);
  if (w.length < 3) return NaN;
  const o: number[] = [];
  const cc: number[] = [];
  let rs = 0;
  for (let i = 1; i < w.length; i++) {
    o.push(Math.log(w[i].o / w[i - 1].c));
    cc.push(Math.log(w[i].c / w[i].o));
    const x = w[i];
    rs += Math.log(x.h / x.c) * Math.log(x.h / x.o) + Math.log(x.l / x.c) * Math.log(x.l / x.o);
  }
  const k = o.length;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const vr = (a: number[]) => {
    const m = mean(a);
    return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
  };
  const kk = 0.34 / (1.34 + (k + 1) / (k - 1));
  const v = vr(o) + kk * vr(cc) + (1 - kk) * (rs / k);
  return Math.sqrt(Math.max(0, v) * barsPerYear(tf));
}

/** EWMA (RiskMetrics) volatility, lambda=0.94 by default. */
export function ewmaVol(c: Candle[], tf: Timeframe, lambda = 0.94): number {
  const r = logReturns(c.map((x) => x.c)).filter(Number.isFinite);
  if (r.length < 10) return NaN;
  let v = r.slice(0, 10).reduce((a, b) => a + b * b, 0) / 10;
  for (const x of r) v = lambda * v + (1 - lambda) * x * x;
  return Math.sqrt(v * barsPerYear(tf));
}

/**
 * GARCH(1,1) fitted by coarse-to-fine grid quasi-MLE with variance targeting, then the
 * h-step ahead average variance forecast. Returns annualised vol forecast over `horizonBars`.
 */
export function garchForecast(c: Candle[], tf: Timeframe, horizonBars: number): { vol: number; alpha: number; beta: number; persistence: number } {
  const r = logReturns(c.map((x) => x.c)).filter(Number.isFinite).slice(-600);
  if (r.length < 100) return { vol: NaN, alpha: NaN, beta: NaN, persistence: NaN };
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const e = r.map((x) => x - m);
  const uncond = e.reduce((a, b) => a + b * b, 0) / e.length;
  const nll = (alpha: number, beta: number) => {
    const omega = uncond * (1 - alpha - beta);
    let h = uncond;
    let ll = 0;
    for (const x of e) {
      ll += Math.log(h) + (x * x) / h;
      h = omega + alpha * x * x + beta * h;
    }
    return ll;
  };
  let best = { a: 0.05, b: 0.9, ll: Infinity };
  for (let a = 0.02; a <= 0.3; a += 0.03) {
    for (let b = 0.6; b <= 0.98; b += 0.03) {
      if (a + b >= 0.995) continue;
      const ll = nll(a, b);
      if (ll < best.ll) best = { a, b, ll };
    }
  }
  // refine
  for (let a = best.a - 0.015; a <= best.a + 0.015; a += 0.005) {
    for (let b = best.b - 0.015; b <= best.b + 0.015; b += 0.005) {
      if (a <= 0 || b <= 0 || a + b >= 0.999) continue;
      const ll = nll(a, b);
      if (ll < best.ll) best = { a, b, ll };
    }
  }
  const omega = uncond * (1 - best.a - best.b);
  let h = uncond;
  for (const x of e) h = omega + best.a * x * x + best.b * h;
  const p = best.a + best.b;
  let total = 0;
  let hk = h;
  for (let k = 0; k < horizonBars; k++) {
    total += hk;
    hk = uncond + p * (hk - uncond);
  }
  const avg = total / Math.max(1, horizonBars);
  return { vol: Math.sqrt(avg * barsPerYear(tf)), alpha: best.a, beta: best.b, persistence: p };
}

/** Rolling series of an estimator for percentile/regime calculations. */
export function rollingVolSeries(c: Candle[], n: number, tf: Timeframe, step = 1, estimator = yangZhangVol): number[] {
  const out: number[] = [];
  for (let i = n + 1; i <= c.length; i += step) out.push(estimator(c.slice(0, i), n, tf));
  return out.filter(Number.isFinite);
}

/** Volatility of volatility: stdev of log changes of a rolling vol series. */
export function volOfVol(volSeries: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < volSeries.length; i++) if (volSeries[i] > 0 && volSeries[i - 1] > 0) r.push(Math.log(volSeries[i] / volSeries[i - 1]));
  if (r.length < 3) return NaN;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}
