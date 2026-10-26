/**
 * Statistical tests used to decide whether a model change is real improvement or noise.
 */
import { mean, variance, normCdf, normInv, mulberry32, quantile } from '../lib/math.js';

/** Regularised incomplete beta via continued fraction (for Student-t CDF). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function lgamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export function incBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const p = 0.5 * incBeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - p : p;
}

/** One-sample t-test of mean > mu0 (one-sided). */
export function oneSampleT(xs: number[], mu0 = 0): { t: number; df: number; pGreater: number; pLess: number } {
  const n = xs.length;
  if (n < 3) return { t: 0, df: Math.max(1, n - 1), pGreater: 1, pLess: 1 };
  const se = Math.sqrt(variance(xs) / n);
  const t = se > 0 ? (mean(xs) - mu0) / se : 0;
  const df = n - 1;
  return { t, df, pGreater: 1 - tCdf(t, df), pLess: tCdf(t, df) };
}

/** Welch's two-sample t-test, one-sided H1: mean(a) > mean(b). */
export function welchT(a: number[], b: number[]): { t: number; df: number; p: number } {
  if (a.length < 3 || b.length < 3) return { t: 0, df: 1, p: 1 };
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const se = Math.sqrt(va + vb);
  if (se === 0) return { t: 0, df: 1, p: mean(a) > mean(b) ? 0 : 1 };
  const t = (mean(a) - mean(b)) / se;
  const df = (va + vb) ** 2 / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  return { t, df, p: 1 - tCdf(t, df) };
}

/** Bootstrap one-sided p-value and CI for mean(a) - mean(b) (or mean(a) if b omitted). */
export function bootstrapMeanDiff(a: number[], b: number[] | null, iterations = 5000, seed = 7): { diff: number; p: number; ci95: [number, number] } {
  const rng = mulberry32(seed);
  const pick = (xs: number[]) => xs[Math.floor(rng() * xs.length)];
  const diffs: number[] = [];
  if (!a.length || (b && !b.length)) return { diff: 0, p: 1, ci95: [0, 0] };
  for (let i = 0; i < iterations; i++) {
    let sa = 0;
    for (let k = 0; k < a.length; k++) sa += pick(a);
    let sb = 0;
    if (b) for (let k = 0; k < b.length; k++) sb += pick(b);
    diffs.push(sa / a.length - (b ? sb / b.length : 0));
  }
  const observed = mean(a) - (b ? mean(b) : 0);
  const p = diffs.filter((d) => d <= 0).length / iterations;
  return { diff: observed, p, ci95: [quantile(diffs, 0.025), quantile(diffs, 0.975)] };
}

function skew(xs: number[]): number {
  const m = mean(xs);
  const sd = Math.sqrt(variance(xs, false));
  return sd > 0 ? mean(xs.map((x) => ((x - m) / sd) ** 3)) : 0;
}
function kurt(xs: number[]): number {
  const m = mean(xs);
  const sd = Math.sqrt(variance(xs, false));
  return sd > 0 ? mean(xs.map((x) => ((x - m) / sd) ** 4)) : 3;
}

/**
 * Probabilistic Sharpe Ratio (Bailey & Lopez de Prado): P(true SR > benchmark SR) given sample
 * length, skew and kurtosis of returns. Per-period (non-annualised) SRs.
 */
export function probabilisticSharpe(returns: number[], benchmarkSr = 0): number {
  const n = returns.length;
  if (n < 5) return 0;
  const sd = Math.sqrt(variance(returns));
  if (sd === 0) return mean(returns) > 0 ? 1 : 0;
  const sr = mean(returns) / sd;
  const g3 = skew(returns);
  const g4 = kurt(returns);
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmarkSr) * Math.sqrt(n - 1)) / denom);
}

/**
 * Deflated Sharpe Ratio: PSR against the expected maximum SR from `trials` independent strategy
 * trials (multiple-testing / selection-bias correction). `srVariance` = variance of SRs across trials.
 */
export function deflatedSharpe(returns: number[], trials: number, srVariance: number): number {
  if (trials <= 1) return probabilisticSharpe(returns, 0);
  const gamma = 0.5772156649;
  const z1 = normInv(1 - 1 / trials);
  const z2 = normInv(1 - 1 / (trials * Math.E));
  const sr0 = Math.sqrt(Math.max(srVariance, 1e-12)) * ((1 - gamma) * z1 + gamma * z2);
  return probabilisticSharpe(returns, sr0);
}

/** Brier score for probabilistic forecasts. Lower is better; 0 is perfect. */
export function brierScore(forecasts: number[], outcomes: Array<0 | 1>): number {
  const n = Math.min(forecasts.length, outcomes.length);
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1, Math.max(0, forecasts[i]));
    s += (p - outcomes[i]) ** 2;
  }
  return s / n;
}

/** Reliability-diagram buckets: mean forecast vs observed frequency. */
export function reliabilityBuckets(forecasts: number[], outcomes: Array<0 | 1>, bins = 10): Array<{ lo: number; hi: number; meanP: number; freq: number; n: number }> {
  const n = Math.min(forecasts.length, outcomes.length);
  const out: Array<{ lo: number; hi: number; meanP: number; freq: number; n: number }> = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    let sp = 0;
    let so = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const p = forecasts[i];
      if (p >= lo && (b === bins - 1 ? p <= hi : p < hi)) {
        sp += p;
        so += outcomes[i];
        c++;
      }
    }
    out.push({ lo, hi, meanP: c ? sp / c : NaN, freq: c ? so / c : NaN, n: c });
  }
  return out;
}

/** Minimum number of trades so a mean R of `edge` with stdev `sd` is significant at alpha (one-sided). */
export function minTradesForSignificance(edge: number, sd: number, alpha = 0.05): number {
  if (edge <= 0 || sd <= 0) return Infinity;
  const z = normInv(1 - alpha);
  return Math.ceil(((z * sd) / edge) ** 2);
}
