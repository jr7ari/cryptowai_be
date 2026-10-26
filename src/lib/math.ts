/** Numeric helpers. Quantity/price rounding uses integer arithmetic on decimal places to avoid FP drift. */

export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Floor `value` to a multiple of `step` (e.g. quantity_increment). */
export function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const d = decimalsOf(step);
  // epsilon only absorbs FP noise (e.g. 0.3/0.1 = 2.9999999999999996); never rounds up a real remainder
  const units = Math.floor(value / step + 1e-9);
  return Number((units * step).toFixed(d));
}

/** Round to nearest multiple of `step` (e.g. price_increment). */
export function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const d = decimalsOf(step);
  const f = 10 ** d;
  const s = Math.round(step * f);
  return (Math.round(Math.round(value * f) / s) * s) / f;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);

export function variance(a: number[], sample = true): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  const ss = a.reduce((s, x) => s + (x - m) ** 2, 0);
  return ss / (a.length - (sample ? 1 : 0));
}
export const stdev = (a: number[], sample = true) => Math.sqrt(variance(a, sample));

export function percentileRank(series: number[], value: number): number {
  if (!series.length) return 0.5;
  let below = 0;
  let equal = 0;
  for (const x of series) {
    if (x < value) below++;
    else if (x === value) equal++;
  }
  return (below + 0.5 * equal) / series.length;
}

export function quantile(a: number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function softmax(xs: number[], temperature = 1): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp((x - m) / temperature));
  const z = sum(e);
  return e.map((x) => x / z);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf, |err| < 1.5e-7). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export const normPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Inverse normal CDF (Acklam's algorithm). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number;
  let r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Deterministic PRNG (mulberry32) so simulations/backtests are reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const round = (x: number, dp = 8) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

export const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
