/**
 * Risk engine. Hard limits come ONLY from frozen config (HardRiskLimits). Model/learning parameters
 * can make sizing and exits MORE conservative, never less: every learned value is min()'d against
 * the hard limit here. This module is pure (no I/O) so it is exhaustively unit-tested.
 */
import type { HardRiskLimits } from '../config/index.js';
import { buildProfitGuard, evaluateProfitGuard, type GuardStyle } from './profit-guard.js';
import { parseMilestones } from './exit-engine.js';
import type { Position, RiskCheck, RiskDecision, StrategyCandidate, Mode, ExitPlan, ExitV2Plan, RegimeClassification } from '../domain/types.js';
import type { ModelParams } from '../model/params.js';
import { kellyFraction } from '../options/pricing.js';
import { floorToStep } from '../lib/math.js';
import { MS } from '../lib/clock.js';
import { regimeBias } from '../regime/classifier.js';

export interface AccountState {
  mode: Mode;
  equity: number;
  cash: number;
  marginInUse: number;
  peakEquity: number;
  dayStartEquity: number;
  realizedPnlToday: number;
  openPositions: Position[];
  consecutiveLosses: number;
  lastLossAt?: number;
  ordersLastMinute: number;
  killSwitch: { engaged: boolean; reason?: string };
}

export interface RiskInput {
  candidate: StrategyCandidate;
  underlying: string;
  regime: RegimeClassification;
  account: AccountState;
  limits: HardRiskLimits;
  model: ModelParams;
  dataAgeMs: number;
  now: number;
  spot: number;
  /** minimum tradable unit step for this structure (contract/qty increment) */
  unitStep: number;
  minUnits: number;
}

const pct = (x: number) => `${x.toFixed(2)}%`;

export function drawdownPct(a: Pick<AccountState, 'equity' | 'peakEquity'>): number {
  return a.peakEquity > 0 ? Math.max(0, ((a.peakEquity - a.equity) / a.peakEquity) * 100) : 0;
}
export function dailyLossPct(a: Pick<AccountState, 'equity' | 'dayStartEquity'>): number {
  return a.dayStartEquity > 0 ? Math.max(0, ((a.dayStartEquity - a.equity) / a.dayStartEquity) * 100) : 0;
}

/** Account-level circuit checks that also apply when NOT opening (used by the kill-switch monitor). */
export function accountBreaches(a: AccountState, l: HardRiskLimits): Array<{ code: 'DAILY_LOSS' | 'MAX_DRAWDOWN'; message: string }> {
  const out: Array<{ code: 'DAILY_LOSS' | 'MAX_DRAWDOWN'; message: string }> = [];
  const dl = dailyLossPct(a);
  if (dl >= l.dailyLossLimitPct) out.push({ code: 'DAILY_LOSS', message: `Daily loss ${pct(dl)} >= limit ${pct(l.dailyLossLimitPct)}` });
  const dd = drawdownPct(a);
  if (dd >= l.maxDrawdownPct) out.push({ code: 'MAX_DRAWDOWN', message: `Drawdown ${pct(dd)} >= limit ${pct(l.maxDrawdownPct)}` });
  return out;
}

export function assessEntry(inp: RiskInput): RiskDecision {
  const { candidate: c, account: a, limits: l, model: m } = inp;
  const ev = c.evaluation;
  const checks: RiskCheck[] = [];
  const check = (name: string, passed: boolean, message: string, value?: number | string, limit?: number | string) =>
    checks.push({ name, passed, message, value, limit });

  check('kill_switch', !a.killSwitch.engaged, a.killSwitch.engaged ? `Kill switch engaged: ${a.killSwitch.reason}` : 'off');
  check('data_fresh', inp.dataAgeMs <= l.staleDataMs, `market data age ${inp.dataAgeMs}ms`, inp.dataAgeMs, l.staleDataMs);
  check('evaluation_present', !!ev, ev ? 'ok' : 'candidate has no evaluation');
  const dl = dailyLossPct(a);
  check('daily_loss', dl < l.dailyLossLimitPct, `daily loss ${pct(dl)}`, dl, l.dailyLossLimitPct);
  const dd = drawdownPct(a);
  check('max_drawdown', dd < l.maxDrawdownPct, `drawdown ${pct(dd)}`, dd, l.maxDrawdownPct);
  const open = a.openPositions.filter((p) => p.status !== 'CLOSED' && p.status !== 'FAILED');
  check('max_open_positions', open.length < l.maxOpenPositions, `${open.length} open`, open.length, l.maxOpenPositions);
  const sameU = open.filter((p) => p.underlying === inp.underlying).length;
  check(
    'positions_per_underlying',
    sameU < l.maxPositionsPerUnderlying,
    sameU >= l.maxPositionsPerUnderlying
      ? `${sameU} already open on ${inp.underlying} (max ${l.maxPositionsPerUnderlying}); existing position is monitored for exits`
      : `${sameU} open on ${inp.underlying}`,
    sameU,
    l.maxPositionsPerUnderlying,
  );
  const inCooldown =
    a.consecutiveLosses >= l.maxConsecutiveLosses && a.lastLossAt !== undefined && inp.now - a.lastLossAt < l.cooldownAfterLossMin * MS.m;
  check('loss_streak_cooldown', !inCooldown, `${a.consecutiveLosses} consecutive losses`, a.consecutiveLosses, l.maxConsecutiveLosses);
  check('order_rate', a.ordersLastMinute < l.maxOrdersPerMinute, `${a.ordersLastMinute} orders in last minute`, a.ordersLastMinute, l.maxOrdersPerMinute);
  check('regime_confidence', c.strategy === 'FUTURES_TSMOM' || c.strategy === 'FUTURES_DONCHIAN' || inp.regime.confidence >= l.minConfidence, `confidence ${inp.regime.confidence.toFixed(2)}`, inp.regime.confidence, l.minConfidence);

  if (!ev) return { approved: false, units: 0, checks, riskBudget: 0 };
  // Account-level failures (already holding, kill, stale, …) are not a size problem — skip
  // size_min so the journal does not look like "could not afford 1 BTC".
  if (checks.some((x) => !x.passed)) return { approved: false, units: 0, checks, riskBudget: 0 };

  // ---- sizing: hard budget x learned multiplier (<=1) x confidence, capped by fractional Kelly
  const hardBudget = (a.equity * l.maxRiskPerTradePct) / 100;
  const mult = Math.min(1, Math.max(0, m.sizing.riskMultiplier));
  const conf = m.sizing.confidenceScaling > 0 ? Math.min(1, inp.regime.confidence) ** m.sizing.confidenceScaling : 1;
  // volatility targeting (Moreira & Muir): only ever scales DOWN
  const tv = m.sizing.targetVol ?? 0;
  const volScale = tv > 0 && ev.forecastVol > 0 ? Math.min(1, Math.max(0.25, tv / ev.forecastVol)) : 1;
  let riskBudget = hardBudget * mult * conf * volScale;
  if (ev.rewardRisk !== null && m.sizing.kellyFraction > 0) {
    const fStar = kellyFraction(ev.probabilityOfProfit, ev.rewardRisk, 1);
    const kellyBudget = a.equity * fStar * Math.min(0.5, m.sizing.kellyFraction);
    if (kellyBudget > 0) riskBudget = Math.min(riskBudget, kellyBudget);
  }
  riskBudget = Math.min(riskBudget, hardBudget);

  let units = floorToStep(riskBudget / ev.maxLoss, inp.unitStep);
  // aggregate premium-at-risk cap
  const openRisk = open.reduce((s, p) => s + p.maxLoss, 0);
  const totalRiskCap = (a.equity * l.maxTotalPremiumAtRiskPct) / 100;
  const roomRisk = Math.max(0, totalRiskCap - openRisk);
  units = Math.min(units, floorToStep(roomRisk / ev.maxLoss, inp.unitStep));
  // margin / cash available
  const available = Math.max(0, a.cash - a.marginInUse);
  const marginPerUnit = Math.max(ev.marginRequired, 1e-9);
  units = Math.min(units, floorToStep((available * 0.95) / marginPerUnit, inp.unitStep));
  // delta / notional exposure caps
  const deltaNotionalPerUnit = Math.abs(ev.greeks.delta) * inp.spot;
  // each open position at ITS OWN price (was: every position valued at this symbol's spot, which
  // mis-stated ETH exposure while deciding on BTC and vice versa)
  const openDeltaNotional = open.reduce((s, p) => s + Math.abs(deltaNotional(p)), 0);
  if (deltaNotionalPerUnit > 0) {
    const maxNet = (a.equity * l.maxNetDeltaPctOfCapital) / 100;
    units = Math.min(units, floorToStep(Math.max(0, maxNet - openDeltaNotional) / deltaNotionalPerUnit, inp.unitStep));
    const maxNotional = (a.equity * l.maxNotionalExposurePct) / 100;
    units = Math.min(units, floorToStep(Math.max(0, maxNotional - openDeltaNotional) / deltaNotionalPerUnit, inp.unitStep));
  }
  if (c.legs.some((x) => x.kind === 'FUTURE')) {
    const lev = Number(c.params.leverage ?? 1);
    check('leverage', lev <= l.maxLeverage, `leverage ${lev}x`, lev, l.maxLeverage);
  }
  units = Math.max(0, units);
  check('size_min', units >= inp.minUnits, `units ${units} (budget ${riskBudget.toFixed(2)}, max loss/unit ${ev.maxLoss.toFixed(2)})`, units, inp.minUnits);
  check('risk_room', roomRisk > 0, `open risk ${openRisk.toFixed(2)} of cap ${totalRiskCap.toFixed(2)}`, openRisk, totalRiskCap);
  const tradeRisk = units * ev.maxLoss;
  check('per_trade_risk', tradeRisk <= hardBudget + 1e-6, `trade risk ${tradeRisk.toFixed(2)}`, tradeRisk, hardBudget);

  const approved = checks.every((x) => x.passed);
  return { approved, units: approved ? units : 0, checks, riskBudget };
}

/** Net delta in underlying units of the quantity still OPEN (after partial bookings). */
export function netDelta(p: Position): number {
  return p.legs.reduce((s, l) => {
    const sign = l.side === 'BUY' ? 1 : -1;
    const q = l.filledQty - (l.exitQty ?? 0);
    if (l.kind === 'FUTURE') return s + sign * q;
    // stored delta proxy: use moneyness sign when no greeks available (conservative 0.5)
    return s + sign * 0.5 * (l.option?.type === 'C' ? 1 : -1) * q * (l.option?.contractSize ?? 1);
  }, 0);
}

/** Signed delta notional of a position, priced per leg (futures at entry, options at strike). */
export function deltaNotional(p: Position): number {
  return p.legs.reduce((s, l) => {
    const sign = l.side === 'BUY' ? 1 : -1;
    const q = l.filledQty - (l.exitQty ?? 0);
    if (l.kind === 'FUTURE') return s + sign * q * l.entryPrice;
    const px = l.option?.strike ?? 0;
    return s + sign * 0.5 * (l.option?.type === 'C' ? 1 : -1) * q * (l.option?.contractSize ?? 1) * px;
  }, 0);
}

/** Effective exit plan: tighter-of(model, hard) for stops/holds; model take-profit. */
/** Large finite sentinel (JSON-safe; Infinity would serialise to null). */
export const NEVER = 1e9;

const CREDIT = new Set(['BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'IRON_CONDOR']);
const DEBIT_CAPPED = new Set(['BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD', 'LONG_CALL_BUTTERFLY']);
const DEBIT_OPEN = new Set(['LONG_CALL', 'LONG_PUT', 'LONG_STRADDLE', 'LONG_STRANGLE']);
const TREND = new Set(['FUTURES_TSMOM', 'FUTURES_DONCHIAN', 'FUTURES_XSMOM']);

export function guardStyleFor(strategy?: string): GuardStyle {
  if (!strategy) return 'DEFAULT';
  if (CREDIT.has(strategy)) return 'OPTION_CREDIT';
  if (DEBIT_CAPPED.has(strategy)) return 'OPTION_DEBIT_CAPPED';
  if (DEBIT_OPEN.has(strategy)) return 'OPTION_DEBIT_OPEN';
  if (TREND.has(strategy)) return 'TREND';
  return 'DEFAULT';
}

export function buildExitPlan(m: ModelParams, l: HardRiskLimits, now: number, expiry: number | null, strategy?: string, side?: 'BUY' | 'SELL'): ExitPlan {
  const plan = baseExitPlan(m, l, now, expiry, strategy, side);
  const g = buildProfitGuard(l.exits, guardStyleFor(strategy));
  const out: ExitPlan = g ? { ...plan, profitGuard: g } : plan;
  const v2 = buildV2Plan(l, strategy);
  return v2 ? { ...out, v2 } : out;
}

/** Exit Engine v2 parameters for futures sleeves (options keep the %-of-risk rules + guard). */
export function buildV2Plan(l: HardRiskLimits, strategy?: string): ExitV2Plan | undefined {
  if (l.exits.engine !== 'v2' || !strategy?.startsWith('FUTURES_')) return undefined;
  const trend = guardStyleFor(strategy) === 'TREND';
  return {
    milestones: parseMilestones(trend ? l.exits.v2TrendMilestones : l.exits.v2Milestones),
    chandelierAtrMult: l.exits.chandelierAtrMult,
    atrFeature: trend ? 'atrPct_1d' : 'atrPct',
    trailActivateR: l.exits.trailActivateR,
    channelFeature: strategy === 'FUTURES_DONCHIAN' ? 'donchianStopDist' : undefined,
    finalTargetR: trend ? 0 : l.exits.finalTargetR,
    // trend sleeves already use the full catastrophe stop (min(100, hard)); others the hard stop-loss %
    riskFraction: Math.min(1, (trend ? Math.min(100, l.exits.stopLossPct) : l.exits.stopLossPct) / 100),
  };
}

function baseExitPlan(m: ModelParams, l: HardRiskLimits, now: number, expiry: number | null, strategy?: string, side?: 'BUY' | 'SELL'): ExitPlan {
  if (strategy === 'FUTURES_DONCHIAN') {
    // Zarattini-Pagani-Barbon: exit on the ratcheting channel-midpoint trailing stop (signal exit when
    // the ensemble share of lookbacks still long drops below the exit threshold) or the catastrophe stop.
    const exitShare = m.strategies.FUTURES_DONCHIAN?.shortDelta ?? 0.25;
    return {
      stopLossPct: Math.min(100, l.exits.stopLossPct),
      takeProfitPct: NEVER,
      trailingActivationPct: NEVER,
      trailingDistancePct: NEVER,
      timeExitAt: now + l.exits.maxHoldHours * MS.h,
      expiryBufferMs: 0,
      regimeInvalidationConfidence: 2,
      signalExit: side === 'SELL' ? { feature: 'donchianShort', below: exitShare } : { feature: 'donchianLong', below: exitShare },
    };
  }
  if (strategy === 'FUTURES_MR') {
    const z = m.strategies.FUTURES_MR?.shortDelta ?? 0.4;
    const hold = Math.min(m.exits.maxHoldHours, l.exits.maxHoldHours) * MS.h;
    return {
      stopLossPct: Math.min(m.exits.stopLossPct, l.exits.stopLossPct),
      takeProfitPct: m.exits.takeProfitPct,
      trailingActivationPct: NEVER,
      trailingDistancePct: NEVER,
      timeExitAt: now + hold,
      expiryBufferMs: 0,
      regimeInvalidationConfidence: l.exits.regimeInvalidationConfidence,
      signalExit: side === 'SELL' ? { feature: 'zScore', below: z } : { feature: 'zScore', above: -z },
    };
  }
  if (strategy === 'FUTURES_CARRY') {
    const hold = Math.min(m.exits.maxHoldHours, l.exits.maxHoldHours) * MS.h;
    return {
      stopLossPct: Math.min(m.exits.stopLossPct, l.exits.stopLossPct),
      takeProfitPct: m.exits.takeProfitPct,
      trailingActivationPct: NEVER,
      trailingDistancePct: NEVER,
      timeExitAt: now + hold,
      expiryBufferMs: 0,
      regimeInvalidationConfidence: l.exits.regimeInvalidationConfidence,
      signalExit: side === 'SELL' ? { feature: 'carryScore', below: 0.1 } : { feature: 'carryScore', above: -0.1 },
    };
  }
  if (strategy === 'FUTURES_XSMOM') {
    const hold = Math.min(m.exits.maxHoldHours, l.exits.maxHoldHours) * MS.h;
    return {
      stopLossPct: Math.min(m.exits.stopLossPct, l.exits.stopLossPct),
      takeProfitPct: m.exits.takeProfitPct,
      trailingActivationPct: NEVER,
      trailingDistancePct: NEVER,
      timeExitAt: now + hold,
      expiryBufferMs: 0,
      regimeInvalidationConfidence: l.exits.regimeInvalidationConfidence,
      signalExit: side === 'SELL' ? { feature: 'xsmomRank', above: 0.5 } : { feature: 'xsmomRank', below: 0.5 },
    };
  }
  if (strategy === 'FUTURES_TSMOM') {
    const thr = m.strategies.FUTURES_TSMOM?.shortDelta ?? 0.05;
    // Exits exactly as researched: signal-off or catastrophe stop (or hard max hold). No TP/trailing.
    return {
      stopLossPct: Math.min(100, l.exits.stopLossPct),
      takeProfitPct: NEVER,
      trailingActivationPct: NEVER,
      trailingDistancePct: NEVER,
      timeExitAt: now + l.exits.maxHoldHours * MS.h,
      expiryBufferMs: 0,
      regimeInvalidationConfidence: 2,
      signalExit: side === 'SELL' ? { feature: 'tsmom', above: -thr } : { feature: 'tsmom', below: thr },
    };
  }
  const hold = Math.min(m.exits.maxHoldHours, l.exits.maxHoldHours) * MS.h;
  return {
    stopLossPct: Math.min(m.exits.stopLossPct, l.exits.stopLossPct),
    takeProfitPct: m.exits.takeProfitPct,
    trailingActivationPct: m.exits.trailingActivationPct,
    // hard trailing distance is a ceiling: learned value may only trail tighter
    trailingDistancePct: Math.min(m.exits.trailingDistancePct, l.exits.trailingDistancePct),
    timeExitAt: Math.min(now + hold, expiry ? expiry - l.exits.expiryBufferHours * MS.h : Infinity),
    expiryBufferMs: l.exits.expiryBufferHours * MS.h,
    regimeInvalidationConfidence: l.exits.regimeInvalidationConfidence,
  };
}

export type ExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'TIME_EXIT'
  | 'EXPIRY_BUFFER'
  | 'REGIME_INVALIDATED'
  | 'KILL_SWITCH'
  | 'MANUAL'
  | 'RECONCILIATION'
  | 'SIGNAL_EXIT'
  | 'PROFIT_LOCK'
  | 'PROFIT_CAPTURE';

/**
 * Evaluate exits given the current mark P&L (after estimated exit costs). `riskBase` is the
 * position's max loss; percentages are relative to it, so debit and credit structures compare fairly.
 */
export function checkExit(
  p: Position,
  pnl: number,
  now: number,
  regime: RegimeClassification | null,
  features?: Record<string, number> | null,
): { exit: boolean; reason?: ExitReason; detail?: string; profitFloorPct?: number | null } {
  const base = Math.max(p.maxLoss, 1e-9);
  const pnlPct = (pnl / base) * 100;
  const e = p.exitPlan;
  if (pnlPct <= -e.stopLossPct) return { exit: true, reason: 'STOP_LOSS', detail: `P&L ${pnlPct.toFixed(1)}% <= -${e.stopLossPct}%` };
  // Profit Guard: bank capped structures, and never let a protected winner fall below its locked floor.
  const peakForGuard = (Math.max(p.peakPnl, pnl) / base) * 100;
  const g = evaluateProfitGuard(e, pnlPct, peakForGuard, pnl, p.maxProfit, p.profitFloorPct);
  if (g.exit) return { exit: true, reason: g.reason, detail: g.detail, profitFloorPct: g.floorPct };
  if (pnlPct >= e.takeProfitPct) return { exit: true, reason: 'TAKE_PROFIT', detail: `P&L ${pnlPct.toFixed(1)}% >= ${e.takeProfitPct}%` };
  const peakPct = (p.peakPnl / base) * 100;
  if (peakPct >= e.trailingActivationPct && peakPct - pnlPct >= e.trailingDistancePct) {
    return { exit: true, reason: 'TRAILING_STOP', detail: `gave back ${(peakPct - pnlPct).toFixed(1)}% from peak ${peakPct.toFixed(1)}%` };
  }
  if (now >= e.timeExitAt) {
    const expiry = p.legs.find((l) => l.option)?.option?.expiry;
    const reason: ExitReason = expiry && now >= expiry - e.expiryBufferMs ? 'EXPIRY_BUFFER' : 'TIME_EXIT';
    return { exit: true, reason, detail: `time ${new Date(now).toISOString()} >= ${new Date(e.timeExitAt).toISOString()}` };
  }
  if (e.signalExit && features && Number.isFinite(features[e.signalExit.feature])) {
    const v = features[e.signalExit.feature];
    if (e.signalExit.below !== undefined && v < e.signalExit.below) {
      return { exit: true, reason: 'SIGNAL_EXIT', detail: `${e.signalExit.feature} ${v.toFixed(3)} < ${e.signalExit.below}` };
    }
    if (e.signalExit.above !== undefined && v > e.signalExit.above) {
      return { exit: true, reason: 'SIGNAL_EXIT', detail: `${e.signalExit.feature} ${v.toFixed(3)} > ${e.signalExit.above}` };
    }
  }
  if (regime && p.directionBias !== 'NEUTRAL') {
    const bias = regimeBias(regime.primary);
    if (bias !== 'NEUTRAL' && bias !== p.directionBias && regime.confidence >= e.regimeInvalidationConfidence) {
      return { exit: true, reason: 'REGIME_INVALIDATED', detail: `${regime.primary} @ ${regime.confidence.toFixed(2)} opposes ${p.directionBias}` };
    }
  }
  return { exit: false, profitFloorPct: e.profitGuard ? g.floorPct : undefined };
}
