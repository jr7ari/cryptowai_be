/**
 * Evidence-based alpha signals. Each one is grounded in published research, is bounded, and has
 * learnable (bounded) weights that the walk-forward loop must re-validate out-of-sample:
 *
 *  1. Time-series momentum (TSMOM). Moskowitz-Ooi-Pedersen (2012); for crypto, Liu & Tsyvinski,
 *     "Risks and Returns of Cryptocurrency" (RFS 2021) report a strong time-series momentum effect.
 *     Implemented as a multi-horizon, volatility-normalised trend score -> annualised drift estimate.
 *
 *  2. Volatility / variance risk premium (VRP). Crypto option implied vol has on average exceeded
 *     subsequently realised vol (e.g. the Bitcoin VIX / variance-risk-premium literature using Deribit
 *     data). A positive spread favours defined-risk premium SELLING; a negative spread favours BUYING
 *     options. Implemented as a bounded score used in strategy selection.
 *
 *  3. Funding / basis carry. He, Manela, Ross & von Wachter, "Fundamentals of Perpetual Futures"
 *     (2022): perpetual-spot deviations (reflected in funding) are large in crypto and mean-revert.
 *     Extreme positive funding = crowded longs -> small contrarian (negative) drift tilt, and longs
 *     pay carry (already charged in futures EV).
 *
 *  4. Volatility targeting. Moreira & Muir, "Volatility-Managed Portfolios" (JF 2017): scaling risk
 *     inversely to forecast volatility improves risk-adjusted returns. Implemented as a sizing scale
 *     in (0, 1] - it can only REDUCE size, never exceed hard limits.
 *
 * None of these guarantee profit; they are priors whose usefulness on CoinDCX data must be proven by
 * the walk-forward promotion gate.
 */
import type { Candle, FeatureVector, Timeframe, RegimeClassification } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import { clamp } from '../lib/math.js';
import type { ModelParams } from '../model/params.js';

/** Momentum horizons in days (short to medium term, per crypto TSMOM literature). */
export const MOM_HORIZONS_DAYS = [1, 3, 7, 14, 28] as const;

/**
 * Per-horizon t-statistic of the trailing return: r_h / (sigma_bar * sqrt(h_bars)), using only closed
 * bars. Also returns a bounded composite score in [-1, 1].
 */
export function momentumFeatures(c: Candle[], tf: Timeframe): FeatureVector {
  const out: FeatureVector = {};
  if (c.length < 50) return out;
  const barsPerDay = 86_400_000 / TIMEFRAME_MS[tf];
  const lr: number[] = [];
  for (let i = 1; i < c.length; i++) lr.push(Math.log(c[i].c / c[i - 1].c));
  const tail = lr.slice(-Math.min(lr.length, Math.round(barsPerDay * 30)));
  const m = tail.reduce((a, b) => a + b, 0) / tail.length;
  const sd = Math.sqrt(tail.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, tail.length - 1));
  if (!(sd > 0)) return out;
  let score = 0;
  let n = 0;
  for (const d of MOM_HORIZONS_DAYS) {
    const h = Math.round(d * barsPerDay);
    if (h >= c.length) continue;
    const r = Math.log(c[c.length - 1].c / c[c.length - 1 - h].c);
    const t = r / (sd * Math.sqrt(h));
    out[`mom_t_${d}d`] = t;
    score += Math.tanh(t / 1.5);
    n++;
  }
  out.tsmom = n ? score / n : 0;
  // agreement across horizons (all same sign = 1)
  const ts = MOM_HORIZONS_DAYS.map((d) => out[`mom_t_${d}d`]).filter((x) => x !== undefined);
  out.tsmomAgreement = ts.length ? Math.abs(ts.reduce((a, t) => a + Math.sign(t), 0)) / ts.length : 0;
  // distance from the 28-day high/low (breakout-style momentum)
  const w = c.slice(-Math.min(c.length, Math.round(barsPerDay * 28)));
  const hi = Math.max(...w.map((x) => x.h));
  const lo = Math.min(...w.map((x) => x.l));
  out.range28Pos = hi > lo ? (c[c.length - 1].c - lo) / (hi - lo) : 0.5;
  return out;
}

export interface AlphaBreakdown {
  /** annualised drift contributions */
  regime: number;
  momentum: number;
  funding: number;
  total: number;
  /** [-1,1]: + means implied vol rich vs forecast (favour selling premium) */
  vrp: number;
  /** (0,1] volatility-target sizing scale */
  volScale: number;
}

export function vrpScore(fv: FeatureVector, forecastVol: number): number {
  if (!(fv.ivAtm > 0) || !(forecastVol > 0)) return 0;
  return clamp(Math.tanh((fv.ivAtm - forecastVol) / forecastVol / 0.25), -1, 1);
}

/** Persist alpha onto the feature vector so Overview/indicators do not depend on a later selector pass. */
export function writeAlphaFeatures(fv: FeatureVector, alpha: AlphaBreakdown, forecastVol: number): void {
  fv.alphaDrift = alpha.total;
  fv.alphaRegime = alpha.regime;
  fv.alphaMomentum = alpha.momentum;
  fv.alphaFunding = alpha.funding;
  fv.volTargetScale = alpha.volScale;
  fv.forecastVol = forecastVol;
  // VRP is undefined without an option IV — do not write 0 (the UI would treat that as "fair").
  if (fv.ivAtm > 0) fv.vrpScore = alpha.vrp;
  else delete fv.vrpScore;
}

export function alphaDrift(fv: FeatureVector, regime: RegimeClassification, m: ModelParams, forecastVol: number): AlphaBreakdown {
  const f = m.forecast;
  const reg = (f.drift[regime.primary] ?? 0) * Math.pow(regime.confidence, f.confidencePower) * f.wRegimeDrift;
  // momentum: drift = Sharpe_mom * score * sigma (vol-scaled, as in TSMOM)
  const sigma = fv.rvLong > 0 ? fv.rvLong : forecastVol;
  const score = fv.tsmom ?? 0;
  const asym = score < 0 ? f.momentumShortWeight ?? 0.3 : 1;
  const mom = f.momentumSharpe * score * asym * sigma * (0.5 + 0.5 * (fv.tsmomAgreement ?? 0));
  // funding: contrarian tilt against crowded side, bounded
  const fund = fv.fundingAnnual !== undefined ? -f.fundingTilt * Math.tanh(fv.fundingAnnual / 0.5) : 0;
  const total = clamp(reg + mom + fund, -1.5, 1.5);
  const vrp = vrpScore(fv, forecastVol);
  const volScale = forecastVol > 0 ? clamp(m.sizing.targetVol / forecastVol, 0.25, 1) : 1;
  return { regime: reg, momentum: mom, funding: fund, total, vrp, volScale };
}
