/**
 * Strategy evaluation: expected value, probability of profit, risk/reward, breakevens, Greeks,
 * all-in costs (fees, half-spreads both ways, slippage, funding) and margin, per ONE unit.
 *
 * EV is computed by integrating the structure's mark-to-model value at the planned exit horizon
 * over a lognormal distribution using a FORECAST volatility (GARCH/RV/IV blend) and a regime drift,
 * while the structure is PRICED at market IV. The "edge" therefore comes from (a) forecast vs implied
 * vol and (b) a data-calibrated regime drift - both of which the learning engine re-estimates.
 */
import type { Evaluation, Greeks, LegSpec } from '../domain/types.js';
import { bsPrice, bsGreeks, integrateLognormal, probTouch } from '../options/pricing.js';
import { yearsTo } from '../options/chain.js';
import { YEAR_MS, MS } from '../lib/clock.js';
import { mulberry32, gaussian, quantile } from '../lib/math.js';

export interface CostModel {
  optionFeePctOfUnderlying: number;
  optionFeeCapPctOfPremium: number;
  futuresTakerFeeBps: number;
  slippageBps: number;
  fundingRatePerInterval?: number;
  fundingIntervalHours: number;
}

export interface EvalContext {
  spot: number;
  now: number;
  rate: number;
  forecastVol: number;
  /** annualised drift used for the real-world distribution */
  drift: number;
  holdHours: number;
  expiryBufferHours: number;
  takeProfitPct: number;
  stopLossPct: number;
  costs: CostModel;
  /** Exit policy used by the Monte-Carlo path evaluation (if omitted: terminal-only EV). */
  exit?: { trailingActivationPct: number; trailingDistancePct: number };
  /** number of Monte-Carlo paths (antithetic pairs x2); 0 disables path simulation */
  paths?: number;
  steps?: number;
  seed?: number;
  /** futures only */
  stopDistance?: number;
  leverage?: number;
}

const sgn = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 1 : -1);

export function optionFee(premium: number, spot: number, cs: number, c: CostModel): number {
  const byUnderlying = (c.optionFeePctOfUnderlying / 100) * spot * cs;
  const cap = (c.optionFeeCapPctOfPremium / 100) * premium * cs;
  return Math.min(byUnderlying, Math.max(cap, 0));
}

export function evaluate(legs: LegSpec[], ctx: EvalContext): Evaluation {
  const { spot, now, costs } = ctx;
  const isFut = legs.every((l) => l.kind === 'FUTURE');
  if (isFut) return evaluateFutures(legs[0], ctx);

  const firstExpiry = Math.min(...legs.map((l) => l.option!.expiry));
  const Texp = yearsTo(firstExpiry, now);
  const horizonYears = Math.max(1 / (365 * 24), Math.min(ctx.holdHours / (24 * 365), Texp - ctx.expiryBufferHours / (24 * 365)));
  const H = horizonYears;

  let entryTouch = 0;
  let entryMid = 0;
  let fees = 0;
  let exitHalfSpread = 0;
  const greeks: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };
  let liqSum = 0;
  let spreadPctMax = 0;
  let ivWeighted = 0;
  let ivW = 0;
  for (const l of legs) {
    const o = l.option!;
    const s = sgn(l.side);
    const cs = o.contractSize * l.ratio;
    const px = l.side === 'BUY' ? l.ask : l.bid;
    entryTouch += s * px * cs;
    entryMid += s * l.mark * cs;
    fees += 2 * optionFee(l.mark, spot, cs, costs); // open + close
    exitHalfSpread += ((l.ask - l.bid) / 2) * cs;
    const g = bsGreeks({ S: spot, K: o.strike, T: yearsTo(o.expiry, now), sigma: o.iv, r: ctx.rate, type: o.type });
    greeks.delta += s * g.delta * cs;
    greeks.gamma += s * g.gamma * cs;
    greeks.vega += s * g.vega * cs;
    greeks.theta += s * g.theta * cs;
    const mid = (l.ask + l.bid) / 2;
    const sp = mid > 0 ? (l.ask - l.bid) / mid : 1;
    spreadPctMax = Math.max(spreadPctMax, sp);
    liqSum += Math.max(0, 1 - sp / 0.2);
    ivWeighted += o.iv * l.mark * cs;
    ivW += l.mark * cs;
  }
  const slippage = (costs.slippageBps / 10_000) * legs.reduce((a, l) => a + l.mark * (l.option!.contractSize * l.ratio), 0) * 2;
  const spreadCost = entryTouch - entryMid + exitHalfSpread;
  const totalCosts = fees + slippage;

  /** Value of the structure at horizon given underlying s (exit at bid/ask via half-spread haircut). */
  const valueAt = (s: number, atYears: number) => {
    let v = 0;
    for (const l of legs) {
      const o = l.option!;
      const T = Math.max(0, yearsTo(o.expiry, now) - atYears);
      v += sgn(l.side) * bsPrice({ S: s, K: o.strike, T, sigma: o.iv, r: ctx.rate, type: o.type }) * o.contractSize * l.ratio;
    }
    return v;
  };
  const pnlAtHorizon = (s: number) => valueAt(s, H) - exitHalfSpread - entryTouch - totalCosts;

  const dist = integrateLognormal(spot, H, ctx.forecastVol, ctx.drift, pnlAtHorizon);

  // Expiry payoff grid for max loss/profit/breakevens.
  const grid: number[] = [];
  for (let k = 0; k <= 600; k++) grid.push(spot * Math.exp(-2.5 + (5 * k) / 600));
  const payoffAtExpiry = (s: number) => valueAt(s, Texp) - entryTouch - totalCosts;
  const pays = grid.map(payoffAtExpiry);
  const minPay = Math.min(...pays);
  const maxPay = Math.max(...pays);
  const n = pays.length;
  const risingEdge = pays[n - 1] > pays[n - 2] + 1e-9 && pays[n - 1] >= maxPay - 1e-9;
  const fallingEdge = pays[0] > pays[1] + 1e-9 && pays[0] >= maxPay - 1e-9;
  const breakevens: number[] = [];
  for (let k = 1; k < n; k++) {
    if (Math.sign(pays[k]) !== Math.sign(pays[k - 1]) && pays[k] !== 0) {
      const w = pays[k - 1] / (pays[k - 1] - pays[k]);
      breakevens.push(grid[k - 1] + w * (grid[k] - grid[k - 1]));
    }
  }
  const maxLoss = Math.max(1e-9, -minPay);
  const maxProfit = risingEdge || fallingEdge ? null : Math.max(0, maxPay);

  // ---- Monte-Carlo under the real exit policy (path-dependent stops/targets matter a lot for options)
  let ev = dist.mean;
  let pop = dist.pPositive;
  let path: Evaluation['path'];
  const nPaths = ctx.paths ?? 0;
  if (nPaths > 0) {
    const mc = simulatePaths({
      spot,
      H,
      sigma: ctx.forecastVol,
      mu: ctx.drift,
      steps: ctx.steps ?? 12,
      pairs: Math.ceil(nPaths / 2),
      seed: ctx.seed ?? 1,
      riskBase: maxLoss,
      stopLossPct: ctx.stopLossPct,
      takeProfitPct: ctx.takeProfitPct,
      trailingActivationPct: ctx.exit?.trailingActivationPct ?? Infinity,
      trailingDistancePct: ctx.exit?.trailingDistancePct ?? Infinity,
      pnlAt: (s, t) => valueAt(s, t) - exitHalfSpread - entryTouch - totalCosts,
    });
    ev = mc.mean;
    pop = mc.pPositive;
    path = mc.stats;
  }

  // Margin: debit structures need the premium; credit spreads need width*size - credit (exchange-dependent).
  const marginRequired = entryTouch > 0 ? entryTouch + fees : maxLoss;
  const debit = Math.max(entryTouch, 0);
  const targetPnl = (ctx.takeProfitPct / 100) * (debit > 0 ? debit : maxLoss);
  let probTouchTarget: number | undefined;
  if (Math.abs(greeks.delta) > 1e-6 && debit > 0) {
    // crude: price move needed for target via delta-gamma
    const g = greeks.gamma;
    const d = greeks.delta;
    const disc = d * d + 2 * g * targetPnl;
    const move = Math.abs(g) > 1e-12 && disc >= 0 ? (-d + Math.sign(d) * Math.sqrt(disc)) / g : targetPnl / d;
    if (Number.isFinite(move) && move !== 0) probTouchTarget = probTouch(spot, spot + move, H, ctx.forecastVol);
  }

  return {
    netPremium: entryTouch,
    maxLoss,
    maxProfit,
    breakevens,
    probabilityOfProfit: pop,
    expectedValue: ev,
    grossExpectedValue: ev + totalCosts + spreadCost,
    evPerRisk: ev / maxLoss,
    rewardRisk: maxProfit === null ? null : maxProfit / maxLoss,
    costs: { fees, slippage, spreadCost, funding: 0, total: totalCosts + spreadCost },
    terminalExpectedValue: dist.mean,
    path,
    greeks,
    liquidityScore: legs.length ? liqSum / legs.length : 0,
    spreadPct: spreadPctMax * 100,
    marginRequired,
    probTouchTarget,
    horizonDays: (H * YEAR_MS) / MS.d,
    ivUsed: ivW > 0 ? ivWeighted / ivW : NaN,
    forecastVol: ctx.forecastVol,
  };
}

function evaluateFutures(l: LegSpec, ctx: EvalContext): Evaluation {
  const { spot, costs } = ctx;
  const s = sgn(l.side);
  const entry = l.side === 'BUY' ? l.ask : l.bid;
  const stop = ctx.stopDistance ?? spot * 0.01;
  const H = ctx.holdHours / (24 * 365);
  const fee = 2 * (costs.futuresTakerFeeBps / 10_000) * entry;
  const slippage = 2 * (costs.slippageBps / 10_000) * entry;
  const intervals = ctx.holdHours / costs.fundingIntervalHours;
  // Longs pay positive funding; shorts receive it.
  const funding = s * (costs.fundingRatePerInterval ?? 0) * entry * intervals;
  const halfSpread = (l.ask - l.bid) / 2;
  // Taker costs only. Funding is economic P&L (shorts receive when the rate is positive), not a fee.
  // Adding it into "gross = net + total" made net EV > gross EV on shorts — a dashboard lie.
  const txnCosts = fee + slippage + halfSpread;
  const total = txnCosts + funding;
  const tp = Math.max(stop * (ctx.takeProfitPct / 100) * 2, stop * 1.5);
  // P&L with stop & target (barrier approx): integrate capped payoff.
  const pnl = (x: number) => Math.max(-stop, Math.min(tp, s * (x - entry))) - total;
  const dist = integrateLognormal(spot, H, ctx.forecastVol, ctx.drift, pnl);
  const maxLoss = stop + total;
  let ev = dist.mean;
  let pop = dist.pPositive;
  let path: Evaluation['path'];
  const nPaths = ctx.paths ?? 0;
  if (nPaths > 0) {
    const mc = simulatePaths({
      spot,
      H,
      sigma: ctx.forecastVol,
      mu: ctx.drift,
      steps: ctx.steps ?? 12,
      pairs: Math.ceil(nPaths / 2),
      seed: ctx.seed ?? 1,
      riskBase: maxLoss,
      stopLossPct: ctx.stopLossPct,
      takeProfitPct: ctx.takeProfitPct,
      trailingActivationPct: ctx.exit?.trailingActivationPct ?? Infinity,
      trailingDistancePct: ctx.exit?.trailingDistancePct ?? Infinity,
      pnlAt: (x) => Math.max(-stop, Math.min(tp, s * (x - entry))) - total,
    });
    ev = mc.mean;
    pop = mc.pPositive;
    path = mc.stats;
  }
  const mid = (l.ask + l.bid) / 2 || spot;
  const sp = (l.ask - l.bid) / mid;
  return {
    netPremium: 0,
    maxLoss,
    maxProfit: ctx.takeProfitPct >= 1e5 ? null : tp - total, // no take-profit => unbounded
    breakevens: [entry + s * total],
    probabilityOfProfit: pop,
    expectedValue: ev,
    grossExpectedValue: ev + txnCosts,
    evPerRisk: ev / maxLoss,
    rewardRisk: ctx.takeProfitPct >= 1e5 ? null : (tp - total) / maxLoss,
    costs: { fees: fee, slippage, spreadCost: halfSpread, funding, total },
    terminalExpectedValue: dist.mean,
    path,
    greeks: { delta: s, gamma: 0, vega: 0, theta: 0 },
    liquidityScore: Math.max(0, 1 - sp / 0.005),
    spreadPct: sp * 100,
    marginRequired: entry / Math.max(1, ctx.leverage ?? 1),
    probTouchTarget: ctx.takeProfitPct >= 1e5 ? undefined : probTouch(spot, entry + s * tp, H, ctx.forecastVol),
    horizonDays: ctx.holdHours / 24,
    ivUsed: NaN,
    forecastVol: ctx.forecastVol,
  };
}

/** Current mark-to-market value of open legs (positive = we could sell it for this). */
export function markValue(legs: Array<LegSpec & { filledQty?: number }>, spot: number, now: number, rate: number, ivFor: (l: LegSpec) => number, useTouch = true): number {
  let v = 0;
  for (const l of legs) {
    const qty = l.filledQty ?? l.qty;
    if (l.kind === 'FUTURE') continue; // futures P&L handled from entry price
    const o = l.option!;
    const T = yearsTo(o.expiry, now);
    const theo = bsPrice({ S: spot, K: o.strike, T, sigma: ivFor(l), r: rate, type: o.type });
    const half = useTouch ? (l.ask - l.bid) / 2 : 0;
    // to close a long we sell at bid (theo - half); to close a short we buy at ask (theo + half)
    v += l.side === 'BUY' ? (theo - half) * o.contractSize * qty : -(theo + half) * o.contractSize * qty;
  }
  return v;
}

export interface PathSimInput {
  spot: number;
  H: number;
  sigma: number;
  mu: number;
  steps: number;
  pairs: number;
  seed: number;
  riskBase: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  /** P&L if closed at underlying s after t years */
  pnlAt: (s: number, t: number) => number;
}

/**
 * GBM Monte-Carlo with antithetic variates, applying the same exit rules as the live position monitor
 * at each step. Deterministic for a given seed.
 */
export function simulatePaths(i: PathSimInput): { mean: number; pPositive: number; stats: NonNullable<Evaluation['path']> } {
  const rng = mulberry32(i.seed);
  const dt = i.H / i.steps;
  const drift = (i.mu - 0.5 * i.sigma * i.sigma) * dt;
  const vol = i.sigma * Math.sqrt(dt);
  const base = Math.max(i.riskBase, 1e-9);
  const out: number[] = [];
  let sl = 0;
  let tp = 0;
  let tr = 0;
  let te = 0;
  for (let p = 0; p < i.pairs; p++) {
    const zs: number[] = [];
    for (let k = 0; k < i.steps; k++) zs.push(gaussian(rng));
    for (const sign of [1, -1]) {
      let s = i.spot;
      let peak = 0;
      let result: number | null = null;
      for (let k = 0; k < i.steps; k++) {
        s *= Math.exp(drift + vol * sign * zs[k]);
        const pnl = i.pnlAt(s, (k + 1) * dt);
        const pct = (pnl / base) * 100;
        peak = Math.max(peak, pct);
        if (pct <= -i.stopLossPct) {
          result = pnl;
          sl++;
          break;
        }
        if (pct >= i.takeProfitPct) {
          result = pnl;
          tp++;
          break;
        }
        if (peak >= i.trailingActivationPct && peak - pct >= i.trailingDistancePct) {
          result = pnl;
          tr++;
          break;
        }
      }
      if (result === null) {
        result = i.pnlAt(s, i.H);
        te++;
      }
      out.push(result);
    }
  }
  const n = out.length;
  const mean = out.reduce((a, b) => a + b, 0) / n;
  const sampleVar = n > 1 ? out.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    mean,
    pPositive: out.filter((x) => x > 0).length / n,
    stats: {
      paths: n,
      stopHitPct: sl / n,
      takeProfitPct: tp / n,
      trailingPct: tr / n,
      timeExitPct: te / n,
      p5: quantile(out, 0.05),
      p95: quantile(out, 0.95),
      mean,
      meanStderr: Math.sqrt(sampleVar / n),
      seed: i.seed,
    },
  };
}
