/**
 * Strategy selection: regime -> candidate strategies (via affinity) -> build legs -> evaluate ->
 * filter (liquidity, spread, EV, PoP, capability) -> score -> pick best. Every candidate, including
 * rejected ones and the reason, is returned for the audit trail.
 */
import type { Mode, RegimeClassification, StrategyCandidate, StrategyName, OptionChainSnapshot, FeatureVector } from '../domain/types.js';
import { STRATEGIES } from '../domain/types.js';
import type { ModelParams } from '../model/params.js';
import { affinityOf } from '../model/params.js';
import { buildStrategy, STRATEGY_INFO } from './builders.js';
import { evaluate, type CostModel } from './evaluate.js';
import { clamp } from '../lib/math.js';
import { alphaDrift, type AlphaBreakdown } from '../signals/alpha.js';
import type { HardRiskLimits } from '../config/index.js';

/** Strategies validated independently of the regime classifier. */
export const REGIME_INDEPENDENT = new Set<StrategyName>(['FUTURES_TSMOM', 'FUTURES_DONCHIAN']);

export interface SelectionInput {
  regime: RegimeClassification;
  features: FeatureVector;
  chain: OptionChainSnapshot | null;
  futuresInstrument: string;
  spot: number;
  bid?: number;
  ask?: number;
  now: number;
  model: ModelParams;
  limits: HardRiskLimits;
  costs: CostModel;
  /** Strategies the active execution venue can actually trade (capability gate). */
  tradable: Set<StrategyName>;
  /** strategies paused by the edge monitor -> reason */
  paused?: Map<StrategyName, string>;
  /** Monte-Carlo paths for exit-policy-aware EV (default 400). */
  mcPaths?: number;
  /** PAPER vs LIVE. Defaults to PAPER so unit tests evaluate sleeves; LIVE rejects paperOnly. */
  mode?: Mode;
  /** Optional triple-barrier meta-label P(win) in [0,1]. Undefined = filter off. */
  metaP?: number;
}

export interface SelectionResult {
  candidates: StrategyCandidate[];
  selected: StrategyCandidate | null;
  rationale: string;
  forecastVol: number;
  drift: number;
  alpha: AlphaBreakdown;
}

/** Forecast vol = normalised blend of GARCH, Yang-Zhang RV and ATM IV (whatever is available). */
export function forecastVolatility(fv: FeatureVector, m: ModelParams): number {
  const parts: Array<[number, number]> = [];
  if (fv.garchVol > 0) parts.push([fv.garchVol, m.forecast.wGarch]);
  if (fv.rvShort > 0) parts.push([fv.rvShort, m.forecast.wRv]);
  if (fv.ivAtm > 0) parts.push([fv.ivAtm, m.forecast.wIv]);
  const w = parts.reduce((a, p) => a + p[1], 0);
  if (!parts.length || w <= 0) return fv.rvShort > 0 ? fv.rvShort : 0.6;
  return clamp(parts.reduce((a, p) => a + p[0] * p[1], 0) / w, 0.05, 3);
}

/** @deprecated use alphaDrift (regime + momentum + funding); kept for baselines/back-compat */
export function regimeDrift(r: RegimeClassification, m: ModelParams): number {
  return (m.forecast.drift[r.primary] ?? 0) * Math.pow(r.confidence, m.forecast.confidencePower);
}

export function selectStrategy(inp: SelectionInput): SelectionResult {
  const { regime, model, limits } = inp;
  const mode = inp.mode ?? 'PAPER';
  const forecastVol = forecastVolatility(inp.features, model);
  const alpha = alphaDrift(inp.features, regime, model, forecastVol);
  const drift = alpha.total;
  const candidates: StrategyCandidate[] = [];
  const atr = (inp.features.atrPct ?? 0.01) * inp.spot;

  // Regime gate: CHOPPY or low confidence disables regime-dependent strategies. Regime-INDEPENDENT
  // sleeves (TSMOM, validated on its own) are still evaluated.
  const gate =
    regime.primary === 'CHOPPY'
      ? 'Regime CHOPPY/uncertain: regime-dependent strategies disabled'
      : regime.confidence < limits.minConfidence
        ? `Regime confidence ${regime.confidence.toFixed(2)} < min ${limits.minConfidence}`
        : null;

  for (const name of STRATEGIES) {
    const independent = REGIME_INDEPENDENT.has(name);
    if (gate && !independent) continue;
    const aff = independent ? Math.max(0.5, affinityOf(model, regime.primary, name)) : affinityOf(model, regime.primary, name);
    const sp = model.strategies[name];
    const cand: StrategyCandidate = { strategy: name, params: {}, legs: [], evaluation: null, score: 0, regimeAffinity: aff, eligible: false, rejectedReasons: [] };
    if (aff <= 0) continue; // not relevant to this regime - not even a candidate
    if (!sp?.enabled) cand.rejectedReasons.push('disabled in model');
    if (!inp.tradable.has(name)) cand.rejectedReasons.push('venue cannot trade this structure (capability gate)');
    const pauseReason = inp.paused?.get(name);
    if (pauseReason) cand.rejectedReasons.push(pauseReason);
    if (sp?.paperOnly && mode === 'LIVE') cand.rejectedReasons.push('PAPER-only sleeve; LIVE disabled until independently validated');
    if (cand.rejectedReasons.length) {
      candidates.push(cand);
      continue;
    }
    // options are priced/evaluated against the option venue's own underlying (real Deribit index)
    const built = buildStrategy(name, sp, {
      chain: inp.chain,
      futuresInstrument: inp.futuresInstrument,
      spot: name.startsWith('FUTURES_') ? inp.spot : inp.chain?.spot ?? inp.spot,
      bid: inp.bid,
      ask: inp.ask,
      now: inp.now,
      minDte: limits.minDaysToExpiry,
      maxDte: limits.maxDaysToExpiry,
      atr,
      features: inp.features,
    });
    if ('error' in built) {
      cand.rejectedReasons.push(built.error);
      candidates.push(cand);
      continue;
    }
    cand.legs = built.legs;
    cand.params = built.params;
    if (name === 'FUTURES_DONCHIAN' && built.legs[0]?.side === 'SELL' && mode === 'LIVE') {
      cand.rejectedReasons.push('Donchian short side is PAPER-only (research tests the long side)');
      candidates.push(cand);
      continue;
    }
    if (name === 'FUTURES_TSMOM' && built.legs[0]?.side === 'SELL' && mode === 'LIVE') {
      cand.rejectedReasons.push('TSMOM short side is PAPER-only');
      candidates.push(cand);
      continue;
    }
    if (name === 'FUTURES_TSMOM' && inp.features.tsmomAgreement !== undefined && inp.features.tsmomAgreement < 0.5) {
      cand.rejectedReasons.push(`TSMOM horizon agreement ${(inp.features.tsmomAgreement * 100).toFixed(0)}% < 50% (horizon-agreement filter)`);
    }
    if (name === 'FUTURES_MR' && inp.features.changePointActive) {
      cand.rejectedReasons.push('CUSUM change-point: mean-reversion suspended');
    }
    const exits = model.exits;
    const ev = evaluate(built.legs, {
      spot: name.startsWith('FUTURES_') ? inp.spot : inp.chain?.spot ?? inp.spot,
      now: inp.now,
      rate: inp.chain?.rate ?? 0,
      forecastVol,
      drift,
      holdHours: name === 'FUTURES_TSMOM' || name === 'FUTURES_DONCHIAN' ? Math.min(sp.targetDte * 24, limits.exits.maxHoldHours) : Math.min(exits.maxHoldHours, limits.exits.maxHoldHours),
      expiryBufferHours: limits.exits.expiryBufferHours,
      takeProfitPct: name === 'FUTURES_TSMOM' || name === 'FUTURES_DONCHIAN' ? 1e6 : exits.takeProfitPct,
      stopLossPct: name === 'FUTURES_TSMOM' || name === 'FUTURES_DONCHIAN' ? Math.min(100, limits.exits.stopLossPct) : Math.min(exits.stopLossPct, limits.exits.stopLossPct),
      costs: inp.costs,
      stopDistance: built.stopDistance,
      leverage: Math.min(sp.leverage, limits.maxLeverage),
      exit: { trailingActivationPct: exits.trailingActivationPct, trailingDistancePct: Math.min(exits.trailingDistancePct, limits.exits.trailingDistancePct) },
      paths: inp.mcPaths ?? 400,
      steps: 12,
      // deterministic per decision time & strategy: reproducible audit + backtests
      seed: (Math.floor(inp.now / 60_000) ^ (STRATEGIES.indexOf(name) * 2654435761)) >>> 0,
    });
    cand.evaluation = ev;

    if (
      inp.metaP !== undefined &&
      name.startsWith('FUTURES_') &&
      inp.metaP < 0.45
    ) {
      cand.rejectedReasons.push(`meta-label P(win)=${inp.metaP.toFixed(2)} < 0.45 (skip filter; hard risk unchanged)`);
    }

    // ---- hard filters (from config; learning cannot loosen these)
    if (ev.spreadPct > limits.maxSpreadPct) cand.rejectedReasons.push(`bid-ask spread ${ev.spreadPct.toFixed(1)}% > ${limits.maxSpreadPct}%`);
    if (ev.liquidityScore < limits.minLiquidityScore) cand.rejectedReasons.push(`liquidity score ${ev.liquidityScore.toFixed(2)} < ${limits.minLiquidityScore}`);
    // Regime-independent sleeves are validated by their own backtest; they only need positive net EV.
    const minEvR = independent ? 0 : limits.minExpectedValuePerRisk;
    if (ev.evPerRisk < minEvR) cand.rejectedReasons.push(`EV/risk ${(ev.evPerRisk * 100).toFixed(1)}% < ${(minEvR * 100).toFixed(1)}%`);
    if (ev.probabilityOfProfit < limits.minProbabilityOfProfit) cand.rejectedReasons.push(`PoP ${(ev.probabilityOfProfit * 100).toFixed(0)}% < ${(limits.minProbabilityOfProfit * 100).toFixed(0)}%`);
    if (!Number.isFinite(ev.maxLoss) || ev.maxLoss <= 0) cand.rejectedReasons.push('max loss undefined');
    if (limits.minOpenInterest > 0 && inp.chain) {
      const ois = built.legs
        .filter((l) => l.kind === 'OPTION')
        .map((l) => inp.chain!.contracts.find((c) => c.symbol === l.instrument)?.openInterest ?? 0);
      if (ois.some((oi) => oi < limits.minOpenInterest)) cand.rejectedReasons.push(`leg open interest < ${limits.minOpenInterest}`);
    }

    // ---- variance-risk-premium gate (learnable): don't sell cheap vol, don't buy rich vol.
    // No ATM IV → VRP is unavailable (0 would look like "fair" and incorrectly pass/fail the gate).
    const vegaS = STRATEGY_INFO[name].vega;
    const ivAtm = inp.features.ivAtm;
    const vrpAvail = ivAtm > 0 && Number.isFinite(ivAtm);
    if (vrpAvail && vegaS === '-' && alpha.vrp < model.selection.vrpMinSell) cand.rejectedReasons.push(`VRP ${alpha.vrp.toFixed(2)} < ${model.selection.vrpMinSell} (options not rich enough to sell)`);
    if (vrpAvail && vegaS === '+' && alpha.vrp > model.selection.vrpMaxBuy) cand.rejectedReasons.push(`VRP ${alpha.vrp.toFixed(2)} > ${model.selection.vrpMaxBuy} (options too expensive to buy)`);

    // ---- score
    const sel = model.selection;
    const evN = clamp(ev.evPerRisk / 0.3, -1, 1);
    const rrN = ev.rewardRisk === null ? 1 : clamp(ev.rewardRisk / 3, 0, 1);
    const vegaSign = STRATEGY_INFO[name].vega === '+' ? 1 : STRATEGY_INFO[name].vega === '-' ? -1 : 0;
    const volEdge = Number.isFinite(ev.ivUsed) && ev.ivUsed > 0 ? clamp((vegaSign * (forecastVol - ev.ivUsed)) / ev.ivUsed / 0.3, -1, 1) : 0;
    cand.score =
      sel.wEv * evN + sel.wPop * ev.probabilityOfProfit + sel.wRr * rrN + sel.wLiquidity * ev.liquidityScore + sel.wAffinity * aff + sel.wVolEdge * volEdge + (sel.wVrp ?? 0) * (vegaS === '-' ? alpha.vrp : vegaS === '+' ? -alpha.vrp : 0);
    if (cand.score < sel.minScore) cand.rejectedReasons.push(`score ${cand.score.toFixed(3)} < ${sel.minScore}`);
    cand.eligible = cand.rejectedReasons.length === 0;
    candidates.push(cand);
  }

  const eligible = candidates.filter((c) => c.eligible).sort((a, b) => b.score - a.score);
  const selected = eligible[0] ?? null;
  const ivForRationale = (() => {
    if (inp.features.ivAtm > 0 && Number.isFinite(inp.features.ivAtm)) return inp.features.ivAtm;
    const used = selected?.evaluation?.ivUsed;
    return used !== undefined && Number.isFinite(used) && used > 0 ? used : undefined;
  })();
  const rationale = selected
    ? `${regime.primary} (conf ${regime.confidence.toFixed(2)}) -> ${selected.strategy}: score ${selected.score.toFixed(3)}, ` +
      `net EV ${selected.evaluation!.expectedValue.toFixed(2)}` +
      (selected.evaluation!.grossExpectedValue !== undefined ? ` (gross ${selected.evaluation!.grossExpectedValue.toFixed(2)})` : '') +
      ` (${(selected.evaluation!.evPerRisk * 100).toFixed(1)}% of max loss), ` +
      `PoP ${(selected.evaluation!.probabilityOfProfit * 100).toFixed(0)}%, forecast vol ${(forecastVol * 100).toFixed(0)}% vs IV ${
        ivForRationale !== undefined ? (ivForRationale * 100).toFixed(0) + '%' : 'n/a'
      }, drift ${(drift * 100).toFixed(0)}%/yr (regime ${(alpha.regime * 100).toFixed(0)}, momentum ${(alpha.momentum * 100).toFixed(0)}, funding ${(alpha.funding * 100).toFixed(0)}), VRP ${
        ivForRationale !== undefined ? alpha.vrp.toFixed(2) : 'n/a'
      }. Beat ${eligible.length - 1} other eligible candidate(s).`
    : gate && !candidates.length
      ? gate
      : `${gate ? gate + '; ' : ''}${regime.primary}: no candidate passed filters (${candidates.length} considered)`;
  return { candidates, selected, rationale, forecastVol, drift, alpha };
}
