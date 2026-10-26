/**
 * Versioned, learnable model parameters. The adaptive-learning engine may ONLY change values
 * listed in PARAM_BOUNDS and only within those bounds; hard risk limits live elsewhere
 * (config.risk / config.exits) and always win (see risk/engine.ts).
 */
import type { RegimeName, StrategyName } from '../domain/types.js';
import { REGIMES, STRATEGIES } from '../domain/types.js';
import { clamp } from '../lib/math.js';
import { sha256, stableStringify } from '../lib/ids.js';

export interface RegimeParams {
  adxTrend: number;
  adxRange: number;
  chopHigh: number;
  erTrend: number;
  rvHighPctile: number;
  rvLowPctile: number;
  breakoutVolumeZ: number;
  reversalRsiLow: number;
  reversalRsiHigh: number;
  minScore: number;
  hysteresis: number;
  temperature: number;
}

export interface StrategyParams {
  enabled: boolean;
  targetDte: number;
  /** abs delta of the long (or only) leg */
  longDelta: number;
  /** abs delta of the short leg for spreads / wings */
  shortDelta: number;
  /** for futures strategies: leverage multiple (capped by hard limit) */
  leverage: number;
  /**
   * If true, selector rejects the structure in LIVE even when the venue can trade it.
   * Used for sleeves that are not independently validated. Learning cannot flip this
   * (it is not in PARAM_BOUNDS).
   */
  paperOnly?: boolean;
}

export interface SelectionParams {
  minScore: number;
  wEv: number;
  wPop: number;
  wRr: number;
  wLiquidity: number;
  wAffinity: number;
  wVolEdge: number;
  /** Weight on the variance-risk-premium score (premium sellers +, buyers -). */
  wVrp: number;
  /** Premium-SELLING structures need VRP score >= this. */
  vrpMinSell: number;
  /** Premium-BUYING structures need VRP score <= this. */
  vrpMaxBuy: number;
}

export interface SizingParams {
  /** Fraction (0..1] of the hard max-risk-per-trade budget to use. */
  riskMultiplier: number;
  /** Fraction of full Kelly to use when Kelly sizing is enabled (bounded by hard risk). */
  kellyFraction: number;
  /** Scale risk by regime confidence (1 = yes linearly). */
  confidenceScaling: number;
  /** Volatility target (annualised); size scale = min(1, targetVol / forecastVol). */
  targetVol: number;
}

export interface ExitParams {
  stopLossPct: number;
  takeProfitPct: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  maxHoldHours: number;
}

export interface ForecastParams {
  /**
   * Annualised drift assumed per regime when computing expected value. Priors are deliberately small;
   * the learning engine re-estimates them from realised forward returns with shrinkage toward 0.
   */
  drift: Record<RegimeName, number>;
  /** Weights for the forecast-vol blend (normalised): GARCH, Yang-Zhang RV, implied vol. */
  wGarch: number;
  wRv: number;
  wIv: number;
  /** Multiplier on regime drift by confidence (drift used = drift * confidence^k). */
  confidencePower: number;
  /** Weight on the regime-drift table (0 disables it). */
  wRegimeDrift: number;
  /** Assumed annual Sharpe of a fully-loaded TSMOM signal (drift = SR * score * sigma). */
  momentumSharpe: number;
  /** Max annual contrarian drift tilt from extreme funding. */
  fundingTilt: number;
  /** Weight on NEGATIVE momentum (crypto evidence: the short side of TSMOM is much weaker). */
  momentumShortWeight: number;
}

export interface ModelParams {
  schema: 1;
  regime: RegimeParams;
  forecast: ForecastParams;
  affinity: Record<RegimeName, Partial<Record<StrategyName, number>>>;
  strategies: Record<StrategyName, StrategyParams>;
  selection: SelectionParams;
  sizing: SizingParams;
  exits: ExitParams;
}

const S = (
  enabled: boolean,
  targetDte: number,
  longDelta: number,
  shortDelta: number,
  leverage = 1,
  paperOnly = false,
): StrategyParams => ({
  enabled,
  targetDte,
  longDelta,
  shortDelta,
  leverage,
  paperOnly,
});

/**
 * Regime -> strategy affinity (0..1). Encodes standard option-structure logic:
 *  - trends: directional debit (long option / debit spread) - spreads when IV is rich
 *  - ranging: defined-risk premium selling (iron condor, credit spreads, butterfly)
 *  - low vol / compression: long straddle/strangle (cheap gamma before expansion)
 *  - high vol: defined-risk spreads only (long premium is expensive)
 *  - breakout/breakdown: directional long options + futures
 *  - choppy: nothing (affinity 0)
 */
export const DEFAULT_AFFINITY: ModelParams['affinity'] = {
  STRONG_UPTREND: { LONG_CALL: 0.8, BULL_CALL_SPREAD: 0.9, BULL_PUT_SPREAD: 0.6, FUTURES_LONG: 0.7, FUTURES_TSMOM: 0.9, FUTURES_XSMOM: 0.8, FUTURES_DONCHIAN: 0.9 },
  STRONG_DOWNTREND: { LONG_PUT: 0.8, BEAR_PUT_SPREAD: 0.9, BEAR_CALL_SPREAD: 0.6, FUTURES_SHORT: 0.7, FUTURES_TSMOM: 0.7, FUTURES_XSMOM: 0.7, FUTURES_DONCHIAN: 0.5 },
  RANGING: { IRON_CONDOR: 0.9, LONG_CALL_BUTTERFLY: 0.7, BULL_PUT_SPREAD: 0.4, BEAR_CALL_SPREAD: 0.4, FUTURES_MR: 0.7, FUTURES_CARRY: 0.5 },
  HIGH_VOLATILITY: { IRON_CONDOR: 0.6, BULL_CALL_SPREAD: 0.4, BEAR_PUT_SPREAD: 0.4, LONG_CALL_BUTTERFLY: 0.5, FUTURES_CARRY: 0.6 },
  LOW_VOLATILITY: { LONG_STRADDLE: 0.9, LONG_STRANGLE: 0.8, LONG_CALL_BUTTERFLY: 0.3, FUTURES_MR: 0.6 },
  BREAKOUT: { LONG_CALL: 0.9, BULL_CALL_SPREAD: 0.7, LONG_STRANGLE: 0.5, FUTURES_LONG: 0.8, FUTURES_TSMOM: 0.9, FUTURES_XSMOM: 0.8, FUTURES_DONCHIAN: 1 },
  BREAKDOWN: { LONG_PUT: 0.9, BEAR_PUT_SPREAD: 0.7, LONG_STRANGLE: 0.5, FUTURES_SHORT: 0.8, FUTURES_TSMOM: 0.6, FUTURES_XSMOM: 0.7, FUTURES_DONCHIAN: 0.5 },
  REVERSAL_BULLISH: { BULL_CALL_SPREAD: 0.8, LONG_CALL: 0.6, BULL_PUT_SPREAD: 0.5 },
  REVERSAL_BEARISH: { BEAR_PUT_SPREAD: 0.8, LONG_PUT: 0.6, BEAR_CALL_SPREAD: 0.5 },
  CHOPPY: {},
};

export function defaultModelParams(): ModelParams {
  return {
    schema: 1,
    regime: {
      adxTrend: 25,
      adxRange: 18,
      chopHigh: 58,
      erTrend: 0.35,
      rvHighPctile: 0.8,
      rvLowPctile: 0.2,
      breakoutVolumeZ: 1.2,
      reversalRsiLow: 32,
      reversalRsiHigh: 68,
      minScore: 0.5,
      hysteresis: 0.08,
      temperature: 0.15,
    },
    forecast: {
      drift: {
        STRONG_UPTREND: 0.25,
        STRONG_DOWNTREND: -0.25,
        RANGING: 0,
        HIGH_VOLATILITY: 0,
        LOW_VOLATILITY: 0,
        BREAKOUT: 0.35,
        BREAKDOWN: -0.35,
        REVERSAL_BULLISH: 0.15,
        REVERSAL_BEARISH: -0.15,
        CHOPPY: 0,
      },
      wGarch: 0.4,
      wRv: 0.4,
      wIv: 0.2,
      confidencePower: 1,
      wRegimeDrift: 1,
      momentumSharpe: 0.6,
      fundingTilt: 0.15,
      momentumShortWeight: 0.3,
    },
    affinity: structuredClone(DEFAULT_AFFINITY),
    strategies: {
      LONG_CALL: S(true, 14, 0.45, 0),
      LONG_PUT: S(true, 14, 0.45, 0),
      LONG_STRADDLE: S(true, 21, 0.5, 0),
      LONG_STRANGLE: S(true, 21, 0.3, 0),
      BULL_CALL_SPREAD: S(true, 14, 0.5, 0.25),
      BEAR_PUT_SPREAD: S(true, 14, 0.5, 0.25),
      BULL_PUT_SPREAD: S(true, 10, 0.12, 0.25),
      BEAR_CALL_SPREAD: S(true, 10, 0.12, 0.25),
      IRON_CONDOR: S(true, 10, 0.08, 0.18),
      LONG_CALL_BUTTERFLY: S(true, 10, 0.5, 0.25),
      FUTURES_LONG: S(true, 0, 0, 0, 2, true),
      FUTURES_SHORT: S(true, 0, 0, 0, 2, true),
      // TSMOM sleeve: longDelta = entry threshold on the TSMOM score, shortDelta = exit threshold,
      // targetDte = expected holding days (EV horizon), leverage = max leverage (vol-targeted size)
      FUTURES_TSMOM: S(true, 7, 0.2, 0.05, 1),
      // CARRY: longDelta = |carryScore| entry, shortDelta unused, PAPER-only
      FUTURES_CARRY: S(true, 5, 0.35, 0, 1, true),
      // XSMOM: longDelta = high-rank entry, shortDelta = low-rank entry, PAPER-only
      FUTURES_XSMOM: S(true, 7, 0.7, 0.3, 1, true),
      // MR: longDelta = |z| entry, shortDelta = |z| exit, PAPER-only
      FUTURES_MR: S(true, 3, 1.8, 0.4, 1, true),
      // DONCHIAN ensemble (Zarattini et al. 2025): longDelta = share of lookbacks long to enter,
      // shortDelta = share at/below which to exit, targetDte = EV horizon days. PAPER-only.
      FUTURES_DONCHIAN: S(true, 20, 0.5, 0.25, 1, true),
    },
    selection: { minScore: 0.15, wEv: 0.35, wPop: 0.15, wRr: 0.1, wLiquidity: 0.1, wAffinity: 0.2, wVolEdge: 0.1, wVrp: 0.1, vrpMinSell: 0, vrpMaxBuy: 0.35 },
    sizing: { riskMultiplier: 0.75, kellyFraction: 0.25, confidenceScaling: 1, targetVol: 0.7 },
    exits: { stopLossPct: 50, takeProfitPct: 80, trailingActivationPct: 40, trailingDistancePct: 25, maxHoldHours: 72 },
  };
}

export type Bound = [min: number, max: number];

/** The ONLY parameters learning may touch, with hard bounds. */
export const PARAM_BOUNDS: Record<string, Bound> = {
  'regime.adxTrend': [18, 35],
  'regime.adxRange': [12, 24],
  'regime.chopHigh': [50, 68],
  'regime.erTrend': [0.2, 0.55],
  'regime.rvHighPctile': [0.65, 0.95],
  'regime.rvLowPctile': [0.05, 0.35],
  'regime.breakoutVolumeZ': [0.5, 2.5],
  'regime.minScore': [0.4, 0.75],
  'regime.hysteresis': [0, 0.2],
  'selection.minScore': [0.05, 0.5],
  'forecast.wGarch': [0, 1],
  'forecast.wRv': [0, 1],
  'forecast.wIv': [0, 1],
  ...Object.fromEntries(REGIMES.map((r) => [`forecast.drift.${r}`, [-0.8, 0.8] as Bound])),
  'selection.wEv': [0.1, 0.6],
  'selection.wPop': [0, 0.4],
  'selection.wAffinity': [0.05, 0.4],
  'selection.wVolEdge': [0, 0.3],
  'sizing.riskMultiplier': [0.1, 1],
  'sizing.targetVol': [0.3, 1.5],
  'forecast.wRegimeDrift': [0, 1.5],
  'forecast.momentumSharpe': [0, 1.5],
  'forecast.fundingTilt': [0, 0.5],
  'forecast.momentumShortWeight': [0, 1],
  'selection.wVrp': [0, 0.3],
  'selection.vrpMinSell': [-0.5, 0.6],
  'selection.vrpMaxBuy': [-0.3, 1],
  'sizing.kellyFraction': [0, 0.5],
  'exits.stopLossPct': [20, 100],
  'exits.takeProfitPct': [30, 300],
  'exits.trailingActivationPct': [10, 150],
  'exits.trailingDistancePct': [10, 60],
  'exits.maxHoldHours': [4, 720],
  ...Object.fromEntries(
    STRATEGIES.filter((s) => s !== 'FUTURES_CARRY' && s !== 'FUTURES_XSMOM' && s !== 'FUTURES_MR' && s !== 'FUTURES_DONCHIAN').flatMap((s) => [
      [`strategies.${s}.targetDte`, [3, 45] as Bound],
      [`strategies.${s}.longDelta`, [0.05, 0.7] as Bound],
      [`strategies.${s}.shortDelta`, [0.05, 0.45] as Bound],
    ]),
  ),
  ...Object.fromEntries(
    REGIMES.flatMap((r) => STRATEGIES.map((s) => [`affinity.${r}.${s}`, [0, 1] as Bound])),
  ),
};

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Clamp every bounded param into range; returns list of params that had to be clamped. */
export function enforceBounds(p: ModelParams): string[] {
  const clamped: string[] = [];
  for (const [path, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    const v = getPath(p, path);
    if (typeof v !== 'number') continue;
    const c = clamp(v, lo, hi);
    if (c !== v) {
      setPath(p, path, c);
      clamped.push(path);
    }
  }
  if (p.regime.adxRange >= p.regime.adxTrend) {
    p.regime.adxRange = p.regime.adxTrend - 4;
    clamped.push('regime.adxRange<adxTrend');
  }
  for (const s of STRATEGIES) {
    const sp = p.strategies[s];
    if (['BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD'].includes(s) && sp.shortDelta >= sp.longDelta) {
      sp.shortDelta = Math.max(0.05, sp.longDelta - 0.1);
      clamped.push(`strategies.${s}.shortDelta<longDelta`);
    }
    if (['BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'IRON_CONDOR'].includes(s) && sp.longDelta >= sp.shortDelta) {
      sp.longDelta = Math.max(0.03, sp.shortDelta - 0.08);
      clamped.push(`strategies.${s}.longDelta<shortDelta`);
    }
  }
  return clamped;
}

/** Maximum relative change across bounded params between two models (for change-rate limits). */
export function maxRelativeChange(a: ModelParams, b: ModelParams): { path: string; change: number } {
  let worst = { path: '', change: 0 };
  for (const [path, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    const va = getPath(a, path);
    const vb = getPath(b, path);
    if (typeof va !== 'number' && typeof vb !== 'number') continue;
    const x = typeof va === 'number' ? va : 0;
    const y = typeof vb === 'number' ? vb : 0;
    const change = Math.abs(y - x) / (hi - lo);
    if (change > worst.change) worst = { path, change };
  }
  return worst;
}

export function modelHash(p: ModelParams): string {
  return sha256(stableStringify(p)).slice(0, 12);
}

export function affinityOf(p: ModelParams, regime: RegimeName, s: StrategyName): number {
  return p.affinity[regime]?.[s] ?? 0;
}

/** Fill fields added in newer schema revisions so older stored models keep working. */
export function withDefaults(p: Partial<ModelParams> | unknown): ModelParams {
  const d = defaultModelParams();
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge((a as Record<string, unknown>)[k], v);
      return out;
    }
    return b;
  };
  const out = merge(d, p) as ModelParams;
  // Previous factory left directional futures disabled. Re-enable PAPER-only when the stored
  // sleeve still looks like that factory default. Operator LIVE intent is paperOnly === false.
  for (const s of ['FUTURES_LONG', 'FUTURES_SHORT', 'FUTURES_CARRY', 'FUTURES_XSMOM', 'FUTURES_MR', 'FUTURES_DONCHIAN'] as const) {
    const sp = out.strategies[s];
    if (!sp) continue;
    if (sp.paperOnly !== false) sp.paperOnly = true;
    if (
      sp.paperOnly === true &&
      sp.enabled === false &&
      sp.targetDte === 0 &&
      sp.longDelta === 0 &&
      sp.shortDelta === 0
    ) {
      sp.enabled = true;
    }
  }
  return out;
}
