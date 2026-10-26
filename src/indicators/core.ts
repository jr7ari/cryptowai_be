/**
 * Technical indicator library. Every function returns a series aligned with its input
 * (index i uses only data <= i: NO look-ahead), with NaN during warm-up.
 */
import type { Candle } from '../domain/types.js';

const NaNs = (n: number) => new Array<number>(n).fill(NaN);
export const last = (a: number[]) => a[a.length - 1];
export const closes = (c: Candle[]) => c.map((x) => x.c);
export const highs = (c: Candle[]) => c.map((x) => x.h);
export const lows = (c: Candle[]) => c.map((x) => x.l);
export const volumes = (c: Candle[]) => c.map((x) => x.v);

// ------------------------------------------------------------------ moving averages
export function sma(x: number[], n: number): number[] {
  const out = NaNs(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(x: number[], n: number): number[] {
  const out = NaNs(x.length);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      count++;
      if (count === n) {
        prev = seed / n;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's smoothing (RMA), used by RSI/ATR/ADX. */
export function rma(x: number[], n: number): number[] {
  const out = NaNs(x.length);
  let prev = NaN;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      count++;
      if (count === n) {
        prev = seed / n;
        out[i] = prev;
      }
    } else {
      prev = (prev * (n - 1) + v) / n;
      out[i] = prev;
    }
  }
  return out;
}

export function wma(x: number[], n: number): number[] {
  const out = NaNs(x.length);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += x[i - j] * (n - j);
    out[i] = s / denom;
  }
  return out;
}

/** Hull moving average: low-lag trend filter. */
export function hma(x: number[], n: number): number[] {
  const half = wma(x, Math.max(1, Math.floor(n / 2)));
  const full = wma(x, n);
  const diff = half.map((h, i) => 2 * h - full[i]);
  const firstValid = diff.findIndex(Number.isFinite);
  const res = NaNs(x.length);
  if (firstValid < 0) return res;
  const w = wma(diff.slice(firstValid), Math.max(1, Math.floor(Math.sqrt(n))));
  for (let i = 0; i < w.length; i++) res[i + firstValid] = w[i];
  return res;
}

/** Kaufman adaptive moving average + efficiency ratio. */
export function efficiencyRatio(x: number[], n: number): number[] {
  const out = NaNs(x.length);
  for (let i = n; i < x.length; i++) {
    const change = Math.abs(x[i] - x[i - n]);
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) vol += Math.abs(x[j] - x[j - 1]);
    out[i] = vol === 0 ? 0 : change / vol;
  }
  return out;
}

export function kama(x: number[], n = 10, fast = 2, slow = 30): number[] {
  const er = efficiencyRatio(x, n);
  const out = NaNs(x.length);
  const fsc = 2 / (fast + 1);
  const ssc = 2 / (slow + 1);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(er[i])) continue;
    if (Number.isNaN(prev)) prev = x[i - 1] ?? x[i];
    const sc = (er[i] * (fsc - ssc) + ssc) ** 2;
    prev = prev + sc * (x[i] - prev);
    out[i] = prev;
  }
  return out;
}

// ------------------------------------------------------------------ momentum
export function rsi(x: number[], n = 14): number[] {
  const gains = [NaN];
  const lossesArr = [NaN];
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    gains.push(Math.max(0, d));
    lossesArr.push(Math.max(0, -d));
  }
  const ag = rma(gains, n);
  const al = rma(lossesArr, n);
  return ag.map((g, i) => {
    if (!Number.isFinite(g) || !Number.isFinite(al[i])) return NaN;
    if (al[i] === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / al[i]);
  });
}

export function macd(x: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(x, fast);
  const s = ema(x, slow);
  const line = f.map((v, i) => v - s[i]);
  const firstValid = line.findIndex(Number.isFinite);
  const sig = NaNs(x.length);
  if (firstValid >= 0) {
    const e = ema(line.slice(firstValid), signal);
    for (let i = 0; i < e.length; i++) sig[i + firstValid] = e[i];
  }
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export function roc(x: number[], n: number): number[] {
  return x.map((v, i) => (i >= n && x[i - n] !== 0 ? (v - x[i - n]) / x[i - n] : NaN));
}

export function stochastic(c: Candle[], k = 14, d = 3, smooth = 3) {
  const raw = NaNs(c.length);
  for (let i = k - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      hh = Math.max(hh, c[j].h);
      ll = Math.min(ll, c[j].l);
    }
    raw[i] = hh === ll ? 50 : (100 * (c[i].c - ll)) / (hh - ll);
  }
  const kLine = smaValid(raw, smooth);
  return { k: kLine, d: smaValid(kLine, d) };
}

export function stochRsi(x: number[], rsiLen = 14, stochLen = 14, k = 3, d = 3) {
  const r = rsi(x, rsiLen);
  const raw = NaNs(x.length);
  for (let i = 0; i < x.length; i++) {
    if (i < stochLen - 1) continue;
    const w = r.slice(i - stochLen + 1, i + 1);
    if (w.some((v) => !Number.isFinite(v))) continue;
    const hh = Math.max(...w);
    const ll = Math.min(...w);
    raw[i] = hh === ll ? 50 : (100 * (r[i] - ll)) / (hh - ll);
  }
  const kk = smaValid(raw, k);
  return { k: kk, d: smaValid(kk, d) };
}

/** SMA that tolerates leading NaNs. */
export function smaValid(x: number[], n: number): number[] {
  const firstValid = x.findIndex(Number.isFinite);
  const out = NaNs(x.length);
  if (firstValid < 0) return out;
  const s = sma(x.slice(firstValid), n);
  for (let i = 0; i < s.length; i++) out[i + firstValid] = s[i];
  return out;
}

export function cci(c: Candle[], n = 20): number[] {
  const tp = c.map((x) => (x.h + x.l + x.c) / 3);
  const m = sma(tp, n);
  return tp.map((v, i) => {
    if (!Number.isFinite(m[i])) return NaN;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n;
    return md === 0 ? 0 : (v - m[i]) / (0.015 * md);
  });
}

export function williamsR(c: Candle[], n = 14): number[] {
  const out = NaNs(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hh = Math.max(hh, c[j].h);
      ll = Math.min(ll, c[j].l);
    }
    out[i] = hh === ll ? -50 : (-100 * (hh - c[i].c)) / (hh - ll);
  }
  return out;
}

// ------------------------------------------------------------------ volatility / trend strength
export function trueRange(c: Candle[]): number[] {
  return c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
}

export function atr(c: Candle[], n = 14): number[] {
  return rma(trueRange(c), n);
}

/** ADX with +DI / -DI (Wilder). */
export function adx(c: Candle[], n = 14) {
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h;
    const down = c[i - 1].l - c[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = rma(trueRange(c), n);
  const pdm = rma(plusDM, n);
  const mdm = rma(minusDM, n);
  const plusDI = pdm.map((v, i) => (tr[i] ? (100 * v) / tr[i] : NaN));
  const minusDI = mdm.map((v, i) => (tr[i] ? (100 * v) / tr[i] : NaN));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (!Number.isFinite(p) || !Number.isFinite(m) || p + m === 0) return NaN;
    return (100 * Math.abs(p - m)) / (p + m);
  });
  return { adx: rma(dx, n), plusDI, minusDI };
}

export function bollinger(x: number[], n = 20, k = 2) {
  const mid = sma(x, n);
  const upper = NaNs(x.length);
  const lower = NaNs(x.length);
  const width = NaNs(x.length);
  const pctB = NaNs(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (x[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : NaN;
    pctB[i] = upper[i] === lower[i] ? 0.5 : (x[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { mid, upper, lower, width, pctB };
}

export function keltner(c: Candle[], n = 20, mult = 1.5, atrLen = 10) {
  const mid = ema(closes(c), n);
  const a = atr(c, atrLen);
  return { mid, upper: mid.map((m, i) => m + mult * a[i]), lower: mid.map((m, i) => m - mult * a[i]) };
}

/** TTM-style squeeze: Bollinger bands inside Keltner channels => compression. */
export function squeeze(c: Candle[], n = 20) {
  const bb = bollinger(closes(c), n, 2);
  const kc = keltner(c, n, 1.5, n);
  return bb.upper.map((u, i) => (Number.isFinite(u) && Number.isFinite(kc.upper[i]) ? (u < kc.upper[i] && bb.lower[i] > kc.lower[i] ? 1 : 0) : NaN));
}

export function donchian(c: Candle[], n = 20) {
  const upper = NaNs(c.length);
  const lower = NaNs(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hh = Math.max(hh, c[j].h);
      ll = Math.min(ll, c[j].l);
    }
    upper[i] = hh;
    lower[i] = ll;
  }
  return { upper, lower, mid: upper.map((u, i) => (u + lower[i]) / 2) };
}

/** Choppiness index: >61.8 choppy/ranging, <38.2 trending. */
export function choppiness(c: Candle[], n = 14): number[] {
  const tr = trueRange(c);
  const out = NaNs(c.length);
  for (let i = n; i < c.length; i++) {
    let s = 0;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      s += tr[j];
      hh = Math.max(hh, c[j].h);
      ll = Math.min(ll, c[j].l);
    }
    out[i] = hh === ll ? 100 : (100 * Math.log10(s / (hh - ll))) / Math.log10(n);
  }
  return out;
}

export function supertrend(c: Candle[], n = 10, mult = 3) {
  const a = atr(c, n);
  const dir = NaNs(c.length);
  const line = NaNs(c.length);
  let upperPrev = NaN;
  let lowerPrev = NaN;
  let d = 1;
  for (let i = 0; i < c.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (c[i].h + c[i].l) / 2;
    let upper = hl2 + mult * a[i];
    let lower = hl2 - mult * a[i];
    if (Number.isFinite(upperPrev) && (upper > upperPrev && c[i - 1].c <= upperPrev)) upper = upperPrev;
    if (Number.isFinite(lowerPrev) && (lower < lowerPrev && c[i - 1].c >= lowerPrev)) lower = lowerPrev;
    if (Number.isFinite(upperPrev)) {
      if (d === -1 && c[i].c > upperPrev) d = 1;
      else if (d === 1 && c[i].c < lowerPrev) d = -1;
    }
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
    upperPrev = upper;
    lowerPrev = lower;
  }
  return { direction: dir, line };
}

export function parabolicSar(c: Candle[], step = 0.02, max = 0.2): number[] {
  const out = NaNs(c.length);
  if (c.length < 2) return out;
  let bull = c[1].c >= c[0].c;
  let sar = bull ? c[0].l : c[0].h;
  let ep = bull ? c[0].h : c[0].l;
  let af = step;
  for (let i = 1; i < c.length; i++) {
    sar = sar + af * (ep - sar);
    if (bull) {
      sar = Math.min(sar, c[i - 1].l, i > 1 ? c[i - 2].l : c[i - 1].l);
      if (c[i].l < sar) {
        bull = false;
        sar = ep;
        ep = c[i].l;
        af = step;
      } else if (c[i].h > ep) {
        ep = c[i].h;
        af = Math.min(max, af + step);
      }
    } else {
      sar = Math.max(sar, c[i - 1].h, i > 1 ? c[i - 2].h : c[i - 1].h);
      if (c[i].h > sar) {
        bull = true;
        sar = ep;
        ep = c[i].h;
        af = step;
      } else if (c[i].l < ep) {
        ep = c[i].l;
        af = Math.min(max, af + step);
      }
    }
    out[i] = sar;
  }
  return out;
}

export function ichimoku(c: Candle[], tenkan = 9, kijun = 26, senkouB = 52) {
  const mid = (n: number) => donchian(c, n).mid;
  const t = mid(tenkan);
  const k = mid(kijun);
  const spanA = t.map((v, i) => (v + k[i]) / 2);
  const spanB = mid(senkouB);
  // Cloud at bar i is the span computed `kijun` bars earlier (no look-ahead).
  const cloudTop = NaNs(c.length);
  const cloudBottom = NaNs(c.length);
  for (let i = kijun; i < c.length; i++) {
    cloudTop[i] = Math.max(spanA[i - kijun], spanB[i - kijun]);
    cloudBottom[i] = Math.min(spanA[i - kijun], spanB[i - kijun]);
  }
  return { tenkan: t, kijun: k, cloudTop, cloudBottom };
}

export function aroon(c: Candle[], n = 25) {
  const up = NaNs(c.length);
  const down = NaNs(c.length);
  for (let i = n; i < c.length; i++) {
    let hi = i;
    let lo = i;
    for (let j = i - n; j <= i; j++) {
      if (c[j].h >= c[hi].h) hi = j;
      if (c[j].l <= c[lo].l) lo = j;
    }
    up[i] = (100 * (n - (i - hi))) / n;
    down[i] = (100 * (n - (i - lo))) / n;
  }
  return { up, down, osc: up.map((u, i) => u - down[i]) };
}

// ------------------------------------------------------------------ volume
export function obv(c: Candle[]): number[] {
  const out = [0];
  for (let i = 1; i < c.length; i++) out.push(out[i - 1] + (c[i].c > c[i - 1].c ? c[i].v : c[i].c < c[i - 1].c ? -c[i].v : 0));
  return out;
}

export function mfi(c: Candle[], n = 14): number[] {
  const tp = c.map((x) => (x.h + x.l + x.c) / 3);
  const out = NaNs(c.length);
  for (let i = n; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j] * c[j].v;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** Chaikin money flow. */
export function cmf(c: Candle[], n = 20): number[] {
  const mfv = c.map((x) => (x.h === x.l ? 0 : ((x.c - x.l - (x.h - x.c)) / (x.h - x.l)) * x.v));
  const out = NaNs(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let a = 0;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) {
      a += mfv[j];
      v += c[j].v;
    }
    out[i] = v === 0 ? 0 : a / v;
  }
  return out;
}

/** Session VWAP that resets each UTC day (crypto has no session; daily anchor is conventional). */
export function vwapDaily(c: Candle[]): number[] {
  const out = NaNs(c.length);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor(c[i].t / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (c[i].h + c[i].l + c[i].c) / 3;
    pv += tp * c[i].v;
    vol += c[i].v;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

/** Rolling VWAP over n bars, with volume-weighted standard deviation bands. */
export function rollingVwap(c: Candle[], n = 50) {
  const vwap = NaNs(c.length);
  const sd = NaNs(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let pv = 0;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (c[j].h + c[j].l + c[j].c) / 3;
      pv += tp * c[j].v;
      v += c[j].v;
    }
    const m = v > 0 ? pv / v : c[i].c;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (c[j].h + c[j].l + c[j].c) / 3;
      ss += c[j].v * (tp - m) ** 2;
    }
    vwap[i] = m;
    sd[i] = v > 0 ? Math.sqrt(ss / v) : 0;
  }
  return { vwap, sd };
}

export function zscore(x: number[], n: number): number[] {
  const m = sma(x, n);
  return x.map((v, i) => {
    if (!Number.isFinite(m[i])) return NaN;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (x[j] - m[i]) ** 2;
    const sd = Math.sqrt(ss / (n - 1));
    return sd === 0 ? 0 : (v - m[i]) / sd;
  });
}

// ------------------------------------------------------------------ statistics
export function logReturns(x: number[]): number[] {
  const out = [NaN];
  for (let i = 1; i < x.length; i++) out.push(x[i] > 0 && x[i - 1] > 0 ? Math.log(x[i] / x[i - 1]) : NaN);
  return out;
}

/** OLS slope (per bar, normalised by mean price) and R^2 over a rolling window. */
export function linregSlope(x: number[], n: number) {
  const slope = NaNs(x.length);
  const r2 = NaNs(x.length);
  const xm = (n - 1) / 2;
  let sxx = 0;
  for (let k = 0; k < n; k++) sxx += (k - xm) ** 2;
  for (let i = n - 1; i < x.length; i++) {
    let ym = 0;
    for (let k = 0; k < n; k++) ym += x[i - n + 1 + k];
    ym /= n;
    let sxy = 0;
    let syy = 0;
    for (let k = 0; k < n; k++) {
      const y = x[i - n + 1 + k];
      sxy += (k - xm) * (y - ym);
      syy += (y - ym) ** 2;
    }
    const b = sxy / sxx;
    slope[i] = ym ? b / ym : 0;
    r2[i] = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  }
  return { slope, r2 };
}

/** Hurst exponent via rescaled range over the last `n` returns. H>0.55 trending, H<0.45 mean-reverting. */
export function hurst(x: number[], n = 128): number {
  const r = logReturns(x).slice(-n).filter(Number.isFinite);
  if (r.length < 32) return NaN;
  const sizes: number[] = [];
  for (let s = 8; s <= r.length / 2; s *= 2) sizes.push(s);
  const pts: Array<[number, number]> = [];
  for (const s of sizes) {
    const rs: number[] = [];
    for (let start = 0; start + s <= r.length; start += s) {
      const w = r.slice(start, start + s);
      const m = w.reduce((a, b) => a + b, 0) / s;
      let cum = 0;
      let mx = -Infinity;
      let mn = Infinity;
      let ss = 0;
      for (const v of w) {
        cum += v - m;
        mx = Math.max(mx, cum);
        mn = Math.min(mn, cum);
        ss += (v - m) ** 2;
      }
      const sd = Math.sqrt(ss / s);
      if (sd > 0) rs.push((mx - mn) / sd);
    }
    if (rs.length) pts.push([Math.log(s), Math.log(rs.reduce((a, b) => a + b, 0) / rs.length)]);
  }
  if (pts.length < 2) return NaN;
  const xm = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const ym = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const [px, py] of pts) {
    num += (px - xm) * (py - ym);
    den += (px - xm) ** 2;
  }
  return den ? num / den : NaN;
}

/** Lag-1 autocorrelation of returns over the last n bars (momentum vs mean reversion). */
export function autocorr(x: number[], n = 100, lag = 1): number {
  const r = logReturns(x).slice(-n).filter(Number.isFinite);
  if (r.length <= lag + 2) return NaN;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < r.length; i++) {
    den += (r[i] - m) ** 2;
    if (i >= lag) num += (r[i] - m) * (r[i - lag] - m);
  }
  return den ? num / den : NaN;
}

/** Swing pivots (fractals) using k bars each side; only confirmed pivots (k bars old) are returned. */
export function swings(c: Candle[], k = 3) {
  const highsIdx: number[] = [];
  const lowsIdx: number[] = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) isH = false;
      if (c[j].l <= c[i].l) isL = false;
    }
    if (isH) highsIdx.push(i);
    if (isL) lowsIdx.push(i);
  }
  return { highs: highsIdx, lows: lowsIdx };
}

/** Classic floor pivots from the previous completed day. */
export function floorPivots(prevHigh: number, prevLow: number, prevClose: number) {
  const p = (prevHigh + prevLow + prevClose) / 3;
  return { p, r1: 2 * p - prevLow, s1: 2 * p - prevHigh, r2: p + (prevHigh - prevLow), s2: p - (prevHigh - prevLow) };
}

/** Bullish/bearish RSI divergence over the last `lookback` bars using confirmed swing points. */
export function rsiDivergence(c: Candle[], r: number[], lookback = 40, k = 3): 'BULLISH' | 'BEARISH' | null {
  const start = Math.max(0, c.length - lookback);
  const sw = swings(c, k);
  const hs = sw.highs.filter((i) => i >= start);
  const ls = sw.lows.filter((i) => i >= start);
  if (ls.length >= 2) {
    const [a, b] = ls.slice(-2);
    if (c[b].l < c[a].l && r[b] > r[a] + 2) return 'BULLISH';
  }
  if (hs.length >= 2) {
    const [a, b] = hs.slice(-2);
    if (c[b].h > c[a].h && r[b] < r[a] - 2) return 'BEARISH';
  }
  return null;
}
