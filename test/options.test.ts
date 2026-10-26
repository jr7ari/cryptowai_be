import { describe, it, expect } from 'vitest';
import { bsPrice, bsGreeks, impliedVol, strikeForDelta, probAbove, integrateLognormal, kellyFraction } from '../src/options/pricing.js';
import { computeChainMetrics, maxPain, interpolateIv, contractByDelta, yearsTo, ivRankPercentile } from '../src/options/chain.js';
import { buildSyntheticChain, standardExpiries } from './fixtures/synthetic-chain.js';
import type { OptionChainSnapshot } from '../src/domain/types.js';

describe('Black-Scholes', () => {
  it('matches textbook value', () => {
    expect(bsPrice({ S: 100, K: 100, T: 1, sigma: 0.2, r: 0.05, type: 'C' })).toBeCloseTo(10.4506, 3);
    expect(bsPrice({ S: 100, K: 100, T: 1, sigma: 0.2, r: 0.05, type: 'P' })).toBeCloseTo(5.5735, 3);
  });
  it('put-call parity holds', () => {
    for (const K of [80, 100, 130]) {
      const c = bsPrice({ S: 100, K, T: 0.3, sigma: 0.7, r: 0.03, type: 'C' });
      const p = bsPrice({ S: 100, K, T: 0.3, sigma: 0.7, r: 0.03, type: 'P' });
      expect(c - p).toBeCloseTo(100 - K * Math.exp(-0.03 * 0.3), 6);
    }
  });
  it('greeks match finite differences', () => {
    const base = { S: 100, K: 105, T: 0.25, sigma: 0.65, r: 0.01, type: 'C' as const };
    const g = bsGreeks(base);
    const h = 0.01;
    const d = (bsPrice({ ...base, S: 100 + h }) - bsPrice({ ...base, S: 100 - h })) / (2 * h);
    expect(g.delta).toBeCloseTo(d, 4);
    const gm = (bsPrice({ ...base, S: 100 + h }) - 2 * bsPrice(base) + bsPrice({ ...base, S: 100 - h })) / (h * h);
    expect(g.gamma).toBeCloseTo(gm, 3);
    const v = (bsPrice({ ...base, sigma: 0.66 }) - bsPrice({ ...base, sigma: 0.64 })) / 2;
    expect(g.vega).toBeCloseTo(v, 3);
    const th = bsPrice({ ...base, T: base.T - 1 / 365 }) - bsPrice(base);
    expect(g.theta).toBeCloseTo(th, 2);
  });
  it('implied vol round-trips', () => {
    for (const sigma of [0.2, 0.6, 1.4]) {
      for (const type of ['C', 'P'] as const) {
        const px = bsPrice({ S: 100, K: 110, T: 0.1, sigma, type });
        expect(impliedVol(px, { S: 100, K: 110, T: 0.1, type })).toBeCloseTo(sigma, 4);
      }
    }
    expect(Number.isNaN(impliedVol(200, { S: 100, K: 110, T: 0.1, type: 'C' }))).toBe(true);
  });
  it('strikeForDelta inverts delta', () => {
    const K = strikeForDelta(100, 0.1, 0.8, 0.25, 'C');
    expect(bsGreeks({ S: 100, K, T: 0.1, sigma: 0.8, type: 'C' }).delta).toBeCloseTo(0.25, 3);
    const Kp = strikeForDelta(100, 0.1, 0.8, -0.25, 'P');
    expect(bsGreeks({ S: 100, K: Kp, T: 0.1, sigma: 0.8, type: 'P' }).delta).toBeCloseTo(-0.25, 3);
  });
  it('lognormal integration reproduces BS price & probabilities', () => {
    const r = integrateLognormal(100, 0.5, 0.5, 0, (s) => Math.max(0, s - 100));
    expect(r.mean).toBeCloseTo(bsPrice({ S: 100, K: 100, T: 0.5, sigma: 0.5, type: 'C' }), 2);
    expect(r.pPositive).toBeCloseTo(probAbove(100, 100, 0.5, 0.5), 2);
  });
  it('kelly fraction', () => {
    expect(kellyFraction(0.5, 2, 1)).toBeCloseTo(0.25);
    expect(kellyFraction(0.3, 1, 1)).toBe(0);
  });
});

describe('option chain analytics', () => {
  const now = Date.UTC(2026, 0, 5, 12);
  const chain = buildSyntheticChain({ underlying: 'BTC', spot: 60000, now, surface: { atmIv: 0.6, skew: -0.2, smile: 0.5, termSlope: 0 }, spreadPct: 3 });
  it('builds standard expiries in the future', () => {
    const e = standardExpiries(now);
    expect(e.length).toBeGreaterThan(5);
    expect(e.every((x) => x > now)).toBe(true);
    expect(new Date(e[0]).getUTCHours()).toBe(8);
  });
  it('computes ATM IV, negative put skew risk reversal', () => {
    const m = computeChainMetrics(chain);
    expect(m.atmIv).toBeGreaterThan(0.55);
    expect(m.atmIv).toBeLessThan(0.65);
    expect(m.riskReversal25d!).toBeLessThan(0);
  });
  it('finds contracts by delta and interpolates IV', () => {
    const exp = chain.expiries[4];
    const c = contractByDelta(chain, exp, 'C', 0.25, now)!;
    const d = bsGreeks({ S: 60000, K: c.strike, T: yearsTo(exp, now), sigma: c.iv, type: 'C' }).delta;
    expect(Math.abs(d - 0.25)).toBeLessThan(0.08);
    const iv = interpolateIv(chain, c.strike, exp, now);
    expect(iv).toBeCloseTo(c.iv, 2);
  });
  it('max pain picks the OI-weighted pain minimum', () => {
    const exp = chain.expiries[0];
    const c: OptionChainSnapshot = {
      ...chain,
      contracts: [
        { ...chain.contracts[0], strike: 100, expiry: exp, type: 'C', openInterest: 5 },
        { ...chain.contracts[0], strike: 120, expiry: exp, type: 'P', openInterest: 5 },
        { ...chain.contracts[0], strike: 110, expiry: exp, type: 'C', openInterest: 50 },
        { ...chain.contracts[0], strike: 110, expiry: exp, type: 'P', openInterest: 50 },
      ],
    };
    expect(maxPain(c, exp)).toBe(110);
  });
  it('iv rank/percentile', () => {
    const r = ivRankPercentile([0.4, 0.5, 0.6, 0.7, 0.8], 0.75);
    expect(r.rank).toBeCloseTo(0.875);
    expect(r.percentile).toBeCloseTo(0.8);
  });
});
