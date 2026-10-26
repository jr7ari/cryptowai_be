/**
 * The decision pipeline, shared verbatim by LIVE, PAPER and BACKTEST:
 *   features -> regime -> candidate strategies -> evaluation -> risk -> (open request) + audit record.
 * It performs no I/O; the caller persists the DecisionRecord and executes the open request.
 */
import type { MarketSnapshot, Mode, RegimeClassification, Timeframe } from '../domain/types.js';
import type { MarketView } from '../marketdata/view.js';
import type { HardRiskLimits, AppConfig } from '../config/index.js';
import type { ActiveModel } from '../model/registry.js';
import type { DecisionRecord } from '../persistence/ports.js';
import { extractFeatures } from '../regime/features.js';
import { classify } from '../regime/classifier.js';
import { forecastVolatility, selectStrategy } from '../strategies/selector.js';
import { alphaDrift, writeAlphaFeatures } from '../signals/alpha.js';
import { assessEntry, buildExitPlan, type AccountState } from '../risk/engine.js';
import type { CostModel } from '../strategies/evaluate.js';
import type { StrategyName } from '../domain/types.js';
import { uuid } from '../lib/ids.js';
import { microstructureFromBook } from '../signals/microstructure.js';
import { assessDataQuality, featureDisagreements } from '../signals/quality.js';
import { basisFeatures } from '../signals/basis.js';
import { orderFlowFeatures } from '../signals/orderflow.js';
import { volAdjReturn, xsmomFeatures } from '../signals/xsmom.js';
import { meanReversionFeatures } from '../signals/meanreversion.js';
import { changePointDecision } from '../regime/changePointDetector.js';
import { metaFeatures, scoreMeta, type MetaModel } from '../learning/metaLabeler.js';
import * as I from '../indicators/core.js';

export interface DecisionContext {
  symbol: string;
  underlying: string;
  mode: Mode;
  market: MarketView;
  model: ActiveModel;
  limits: HardRiskLimits;
  account: AccountState;
  costs: CostModel;
  tradable: Set<StrategyName>;
  /** strategies paused by the per-strategy edge monitor */
  paused?: Map<StrategyName, string>;
  timeframes: Timeframe[];
  decisionTf: Timeframe;
  fundingIntervalHours: number;
  prevRegime?: RegimeClassification;
  unitStep: (strategy: StrategyName) => number;
  minUnits: (strategy: StrategyName) => number;
  /** Monte-Carlo paths per candidate for exit-aware EV (default 400) */
  mcPaths?: number;
  /** Symbols used for cross-sectional ranking (includes `symbol`). */
  peerSymbols?: string[];
  /** Optional fitted meta-labeler. Unfitted → no skip filter. */
  metaModel?: MetaModel | null;
}

export interface DecisionOutput {
  record: DecisionRecord;
  regime: RegimeClassification;
  open?: {
    units: number;
    exitPlan: ReturnType<typeof buildExitPlan>;
    stopDistance?: number;
    leverage?: number;
  };
}

export function decide(ctx: DecisionContext): DecisionOutput {
  const now = ctx.market.now();
  const candles = Object.fromEntries(ctx.timeframes.map((tf) => [tf, ctx.market.closedCandles(ctx.symbol, tf)]));
  const chain = ctx.market.chain(ctx.symbol);
  const mark = ctx.market.mark(ctx.symbol);
  const price = ctx.market.lastPrice(ctx.symbol);
  const tob = ctx.market.topOfBook(ctx.symbol);
  const features = extractFeatures({
    candles,
    decisionTf: ctx.decisionTf,
    higherTfs: ctx.timeframes.filter((t) => t !== ctx.decisionTf),
    fundingRate: mark?.fundingRate,
    fundingIntervalHours: ctx.fundingIntervalHours,
    openInterestHistory: ctx.market.oiHistory(ctx.symbol),
    chainMetrics: chain?.metrics,
    ivHistory: ctx.market.ivHistory(ctx.symbol),
  });
  const book = ctx.market.orderBook?.(ctx.symbol) ?? null;
  const micro = microstructureFromBook(book, price?.price);
  Object.assign(features, micro);
  Object.assign(
    features,
    basisFeatures({
      last: price?.price,
      mark: mark?.mark,
      fundingRate: mark?.fundingRate,
      fundingIntervalHours: ctx.fundingIntervalHours,
      basisHistory: ctx.market.basisHistory?.(ctx.symbol),
      fundingHistory: ctx.market.fundingHistory?.(ctx.symbol),
    }),
  );
  const mid = tob && tob.bid > 0 && tob.ask >= tob.bid ? (tob.bid + tob.ask) / 2 : price?.price;
  Object.assign(features, orderFlowFeatures(ctx.market.recentTrades?.(ctx.symbol), now, mid));
  const peers = ctx.peerSymbols?.length ? ctx.peerSymbols : [ctx.symbol];
  const peerRets = peers.map((s) => volAdjReturn(ctx.market.closedCandles(s, ctx.decisionTf), ctx.decisionTf));
  const selfIdx = Math.max(0, peers.indexOf(ctx.symbol));
  Object.assign(features, xsmomFeatures(peerRets[selfIdx] ?? null, peerRets));
  const cl = I.closes(candles[ctx.decisionTf] ?? []);
  Object.assign(features, meanReversionFeatures(cl));
  const cp = changePointDecision(cl);
  features.changePointActive = cp.active ? 1 : 0;
  features.changePointShift = cp.shift;
  const disagreements = featureDisagreements(features);
  features.disagreementCount = disagreements.length;
  const regime = classify(ctx.symbol, now, features, ctx.model.params.regime, ctx.model.version, { prev: ctx.prevRegime });
  const forecastVol = forecastVolatility(features, ctx.model.params);
  writeAlphaFeatures(features, alphaDrift(features, regime, ctx.model.params, forecastVol), forecastVol);
  const spot = price?.price ?? features.price ?? 0;
  const decisionBars = (candles[ctx.decisionTf] ?? []).length;
  const snapshot: MarketSnapshot = {
    symbol: ctx.symbol,
    ts: now,
    spot,
    mark: mark?.mark,
    fundingRate: mark?.fundingRate,
    bid: tob?.bid,
    ask: tob?.ask,
    features,
    chainMetrics: chain?.metrics,
    dataAgeMs: ctx.market.dataAgeMs(ctx.symbol),
    dataQuality: assessDataQuality(features, ctx.market.dataAgeMs(ctx.symbol), ctx.limits.staleDataMs, decisionBars),
  };
  const id = uuid();
  const base: DecisionRecord = {
    id,
    ts: now,
    mode: ctx.mode,
    symbol: ctx.symbol,
    modelVersion: ctx.model.version,
    snapshot,
    regime,
    candidates: [],
    selected: null,
    rationale: '',
    riskChecks: [],
    action: 'NO_TRADE',
    orders: [],
  };
  if (!(spot > 0) || Object.keys(features).length === 0) {
    base.rationale = 'insufficient market data (warm-up or feed outage)';
    return { record: base, regime };
  }

  const sel = selectStrategy({
    regime,
    features,
    chain,
    futuresInstrument: ctx.symbol,
    spot,
    bid: tob?.bid,
    ask: tob?.ask,
    now,
    model: ctx.model.params,
    limits: ctx.limits,
    costs: { ...ctx.costs, fundingRatePerInterval: mark?.fundingRate ?? ctx.costs.fundingRatePerInterval },
    tradable: ctx.tradable,
    paused: ctx.paused,
    mcPaths: ctx.mcPaths,
    mode: ctx.mode,
    metaP: scoreMeta(ctx.metaModel, metaFeatures({ ...features, regimeConf: regime.confidence, spreadPct: 0, forecastVol: features.forecastVol ?? 0 })),
  });
  base.candidates = sel.candidates;
  writeAlphaFeatures(features, sel.alpha, sel.forecastVol);
  base.rationale = sel.rationale;
  if (!sel.selected) {
    if (disagreements.length) base.rationale += ` | feature disagreements: ${disagreements.join('; ')}`;
    if (snapshot.dataQuality && !snapshot.dataQuality.ok) base.rationale += ` | data quality: ${snapshot.dataQuality.reasons.join('; ')}`;
    return { record: base, regime };
  }

  base.selected = sel.selected.strategy;
  const risk = assessEntry({
    candidate: sel.selected,
    underlying: ctx.underlying,
    regime,
    account: ctx.account,
    limits: ctx.limits,
    model: ctx.model.params,
    dataAgeMs: snapshot.dataAgeMs,
    now,
    spot,
    unitStep: ctx.unitStep(sel.selected.strategy),
    minUnits: ctx.minUnits(sel.selected.strategy),
  });
  base.riskChecks = risk.checks;
  if (!risk.approved) {
    const failed = risk.checks.filter((c) => !c.passed);
    const onlyHolding = failed.length === 1 && failed[0].name === 'positions_per_underlying';
    if (onlyHolding) {
      base.action = 'HOLDING';
      base.rationale += ` | already in this trade (${failed[0].message})`;
    } else {
      base.action = 'BLOCKED';
      base.rationale += ` | BLOCKED by risk: ${failed.map((c) => `${c.name} (${c.message})`).join('; ')}`;
    }
    return { record: base, regime };
  }
  const expiry = sel.selected.legs.find((l) => l.option)?.option?.expiry ?? null;
  const stopDistance = sel.selected.strategy.startsWith('FUTURES_')
    ? sel.selected.evaluation!.maxLoss - sel.selected.evaluation!.costs.total
    : undefined;
  base.action = 'OPEN';
  base.rationale += ` | sized ${risk.units} unit(s), risk budget ${risk.riskBudget.toFixed(2)}`;
  return {
    record: base,
    regime,
    open: {
      units: risk.units,
      exitPlan: buildExitPlan(ctx.model.params, ctx.limits, now, expiry, sel.selected.strategy, sel.selected.legs[0]?.side),
      stopDistance,
      leverage: sel.selected.strategy.startsWith('FUTURES_') ? Math.min(ctx.model.params.strategies[sel.selected.strategy].leverage, ctx.limits.maxLeverage) : undefined,
    },
  };
}

export function costModelFromConfig(c: AppConfig): CostModel {
  return {
    optionFeePctOfUnderlying: c.paper.optionFeePctOfUnderlying,
    optionFeeCapPctOfPremium: c.paper.optionFeeCapPctOfPremium,
    futuresTakerFeeBps: c.paper.takerFeeBps,
    slippageBps: c.paper.slippageBps,
    fundingIntervalHours: c.paper.fundingIntervalHours,
  };
}
