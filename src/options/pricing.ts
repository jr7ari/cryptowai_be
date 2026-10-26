/**
 * European option pricing (Black-Scholes-Merton on spot with carry `q`, or Black-76 on a forward),
 * Greeks, implied volatility, and probability analytics.
 *
 * Crypto options (Deribit-style, likely CoinDCX too) are European and cash-settled; perpetual
 * funding acts like a carry, so pricing on the forward F = S*exp((r-q)T) is used.
 */
import { normCdf, normPdf, normInv } from '../lib/math.js';
import type { OptionType, Greeks } from '../domain/types.js';

export interface BsInput {
  S: number; // spot
  K: number; // strike
  T: number; // years to expiry
  sigma: number; // annualised vol
  r?: number; // risk-free (annual, continuous)
  q?: number; // carry/dividend yield
  type: OptionType;
}

const MIN_T = 1e-8;

function d1d2({ S, K, T, sigma, r = 0, q = 0 }: BsInput) {
  const t = Math.max(T, MIN_T);
  const sv = sigma * Math.sqrt(t);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * t) / sv;
  return { d1, d2: d1 - sv, t };
}

export function bsPrice(i: BsInput): number {
  const { S, K, T, sigma, r = 0, q = 0, type } = i;
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'C' ? S - K : K - S);
  const { d1, d2, t } = d1d2(i);
  const dfq = Math.exp(-q * t);
  const dfr = Math.exp(-r * t);
  return type === 'C' ? S * dfq * normCdf(d1) - K * dfr * normCdf(d2) : K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
}

/** Greeks: delta, gamma per 1 unit spot, vega per 1 vol point (0.01), theta per calendar day. */
export function bsGreeks(i: BsInput): Greeks & { rho: number; vanna: number; volga: number; charm: number } {
  const { S, K, sigma, r = 0, q = 0, type } = i;
  if (i.T <= 0 || sigma <= 0) {
    const itm = type === 'C' ? S > K : S < K;
    return { delta: itm ? (type === 'C' ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0, rho: 0, vanna: 0, volga: 0, charm: 0 };
  }
  const { d1, d2, t } = d1d2(i);
  const dfq = Math.exp(-q * t);
  const dfr = Math.exp(-r * t);
  const pdf = normPdf(d1);
  const sqrtT = Math.sqrt(t);
  const delta = type === 'C' ? dfq * normCdf(d1) : dfq * (normCdf(d1) - 1);
  const gamma = (dfq * pdf) / (S * sigma * sqrtT);
  const vegaRaw = S * dfq * pdf * sqrtT;
  const thetaYear =
    type === 'C'
      ? (-S * dfq * pdf * sigma) / (2 * sqrtT) - r * K * dfr * normCdf(d2) + q * S * dfq * normCdf(d1)
      : (-S * dfq * pdf * sigma) / (2 * sqrtT) + r * K * dfr * normCdf(-d2) - q * S * dfq * normCdf(-d1);
  const rho = type === 'C' ? K * t * dfr * normCdf(d2) : -K * t * dfr * normCdf(-d2);
  const vanna = (-dfq * pdf * d2) / sigma;
  const volga = (vegaRaw * d1 * d2) / sigma;
  const charm = -dfq * pdf * ((2 * (r - q) * t - d2 * sigma * sqrtT) / (2 * t * sigma * sqrtT));
  return { delta, gamma, vega: vegaRaw / 100, theta: thetaYear / 365, rho: rho / 100, vanna, volga: volga / 10000, charm: charm / 365 };
}

/**
 * Implied volatility: Newton-Raphson with Brenner-Subrahmanyam seed, falling back to bisection.
 * Returns NaN if price violates no-arbitrage bounds.
 */
export function impliedVol(price: number, i: Omit<BsInput, 'sigma'>, tol = 1e-7): number {
  const { S, K, T, r = 0, q = 0, type } = i;
  if (T <= 0 || price <= 0) return NaN;
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  const lower = Math.max(0, type === 'C' ? S * dfq - K * dfr : K * dfr - S * dfq);
  const upper = type === 'C' ? S * dfq : K * dfr;
  if (price < lower - 1e-12 || price > upper) return NaN;
  let sigma = Math.max(0.05, Math.min(3, Math.sqrt((2 * Math.PI) / T) * (price / S)));
  for (let k = 0; k < 50; k++) {
    const p = bsPrice({ ...i, sigma });
    const vega = bsGreeks({ ...i, sigma }).vega * 100;
    const diff = p - price;
    if (Math.abs(diff) < tol) return sigma;
    if (vega < 1e-10) break;
    const next = sigma - diff / vega;
    if (!(next > 0.001 && next < 10)) break;
    sigma = next;
  }
  let lo = 1e-4;
  let hi = 10;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    const p = bsPrice({ ...i, sigma: mid });
    if (Math.abs(p - price) < tol) return mid;
    if (p > price) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/** Risk-neutral P(S_T > K). With `drift`=mu it becomes a real-world estimate. */
export function probAbove(S: number, K: number, T: number, sigma: number, drift = 0): number {
  if (T <= 0) return S > K ? 1 : 0;
  const d2 = (Math.log(S / K) + (drift - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d2);
}

/** Probability the price touches level B before T (reflection principle, driftless approx). */
export function probTouch(S: number, B: number, T: number, sigma: number): number {
  if (T <= 0) return 0;
  const pEnd = B > S ? probAbove(S, B, T, sigma) : 1 - probAbove(S, B, T, sigma);
  return Math.min(1, 2 * pEnd);
}

/** One-standard-deviation expected move over T years. */
export const expectedMove = (S: number, sigma: number, T: number) => S * sigma * Math.sqrt(Math.max(T, 0));

/** Strike for a target Black-Scholes delta (calls: 0..1, puts: -1..0). */
export function strikeForDelta(S: number, T: number, sigma: number, targetDelta: number, type: OptionType, r = 0, q = 0): number {
  const t = Math.max(T, MIN_T);
  const dq = Math.exp(-q * t);
  const d1 = type === 'C' ? normInv(Math.min(0.999, Math.max(0.001, targetDelta / dq))) : normInv(Math.min(0.999, Math.max(0.001, targetDelta / dq + 1)));
  return S * Math.exp(-(d1 * sigma * Math.sqrt(t)) + (r - q + 0.5 * sigma * sigma) * t);
}

/**
 * Expected value and distribution stats of an arbitrary payoff at horizon H under a lognormal
 * with vol `sigma` and annual drift `mu`, via Gauss-Hermite-like dense quadrature on log-price.
 * `valueAt(S_H)` must return the structure's value at the horizon (may include residual time value).
 */
export function integrateLognormal(
  S: number,
  H: number,
  sigma: number,
  mu: number,
  valueAt: (s: number) => number,
  points = 401,
): { mean: number; pPositive: number; quantiles: { p5: number; p50: number; p95: number }; stdev: number } {
  if (H <= 0) {
    const v = valueAt(S);
    return { mean: v, pPositive: v > 0 ? 1 : 0, quantiles: { p5: v, p50: v, p95: v }, stdev: 0 };
  }
  const sd = sigma * Math.sqrt(H);
  const m = (mu - 0.5 * sigma * sigma) * H;
  const zMax = 6;
  const dz = (2 * zMax) / (points - 1);
  let total = 0;
  let wsum = 0;
  let pPos = 0;
  let m2 = 0;
  const samples: Array<[number, number]> = [];
  for (let k = 0; k < points; k++) {
    const z = -zMax + k * dz;
    const w = normPdf(z) * dz;
    const v = valueAt(S * Math.exp(m + sd * z));
    total += w * v;
    m2 += w * v * v;
    wsum += w;
    if (v > 0) pPos += w;
    samples.push([v, w]);
  }
  const mean = total / wsum;
  samples.sort((a, b) => a[0] - b[0]);
  const q = (p: number) => {
    let acc = 0;
    for (const [v, w] of samples) {
      acc += w / wsum;
      if (acc >= p) return v;
    }
    return samples[samples.length - 1][0];
  };
  return { mean, pPositive: pPos / wsum, quantiles: { p5: q(0.05), p50: q(0.5), p95: q(0.95) }, stdev: Math.sqrt(Math.max(0, m2 / wsum - mean * mean)) };
}

/** Kelly fraction for a binary-ish bet: f* = p/a - q/b (a = loss fraction, b = win multiple). */
export function kellyFraction(pWin: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0;
  const b = avgWin / avgLoss;
  return Math.max(0, pWin - (1 - pWin) / b);
}
