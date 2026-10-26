/**
 * Exit Engine v2: price-based trade management the way discretionary and systematic futures traders
 * run it, expressed in R (R = initial risk per unit = the entry stop distance).
 *
 *   1. Every position starts with an initial protective stop (R) and a strategy-specific exit.
 *   2. Profit milestones (+1R, +2R ...) can book a configurable share of the ORIGINAL quantity and
 *      move the stop to a better level (break-even-plus-costs, +1R ...).
 *   3. Trend trades keep a runner trailed by a Chandelier stop (highest high since entry - k x ATR,
 *      Le Beau) or, for the Donchian sleeve, its own channel stop - whichever is TIGHTER.
 *   4. Mean-reversion / carry trades exit at their target (signal exit), the stop, or time.
 *   5. The stop only ever moves in the direction that reduces risk.
 *   6. Profit Guard floors (risk/profit-guard.ts) are converted to a price and fed into the same stop,
 *      so there is ONE protective level and no competing exit systems.
 *
 * Intrabar order is pessimistic: the stop carried from the previous evaluation is tested FIRST,
 * then milestones, and only then are the high/low water marks and trailing stops updated for the next
 * evaluation. A bar that touches both the stop and a target is treated as a stop-out.
 *
 * This module is pure (it never mutates the position): it returns an action. PositionManager executes it (idempotent orders, fill
 * confirmation, reconciliation) - see portfolio/position-manager.ts.
 */
import type { Position, ExitPlan, ExitV2Plan, StopKind } from '../domain/types.js';
import { guardFloorPct } from './profit-guard.js';

export interface MilestoneSpec {
  /** profit milestone in R */
  r: number;
  /** fraction of the ORIGINAL quantity to book (0 = only move the stop) */
  fraction: number;
  /** after the milestone, the stop moves to entry + lockR x R + costs (0 = break-even after costs) */
  lockR: number;
}

/** Parse "1:0.33:0,2:0.33:1" -> milestones. Junk entries are dropped. */
export function parseMilestones(s: string): MilestoneSpec[] {
  if (!s.trim()) return [];
  return s
    .split(',')
    .map((x) => x.split(':').map((v) => Number(v.trim())))
    .filter((a) => a.length >= 2 && a.every(Number.isFinite) && a[0] > 0 && a[1] >= 0 && a[1] < 1)
    .map((a) => ({ r: a[0], fraction: a[1], lockR: a[2] ?? Number.NaN }))
    .map((m) => ({ ...m, lockR: Number.isFinite(m.lockR) ? Math.min(m.lockR, m.r - 0.25) : -Infinity }))
    .sort((a, b) => a.r - b.r);
}

export interface ExitEngineCtx {
  /** executable exit-side price now (bid for longs, ask for shorts) */
  price: number;
  /** the last CLOSED bar since the previous evaluation (backtests); absent live -> ticks are used */
  bar?: { o: number; h: number; l: number };
  /** ATR in price units for the trailing stop (null = unavailable -> no Chandelier update) */
  atr: number | null;
  features?: Record<string, number> | null;
  /** minimum tradable quantity step */
  qtyStep: number;
}

export type ExitAction =
  | { kind: 'HOLD'; newStop: number; highWater: number; lowWater: number; stopKind?: StopKind; milestonesHit: number[]; detail?: string }
  | {
      kind: 'CLOSE';
      reason: 'PROTECTIVE_STOP' | 'TRAILING_STOP' | 'BREAKEVEN_STOP' | 'PROFIT_LOCK' | 'FINAL_TARGET';
      /** where a resting stop/target would have filled (gap-aware); live/paper use the market */
      triggerPrice: number;
      detail: string;
      newStop: number;
      highWater: number;
      lowWater: number;
    }
  | { kind: 'PARTIAL'; milestoneIndex: number; qty: number; triggerPrice: number; detail: string; newStop: number; stopKind?: StopKind; milestonesHit: number[]; highWater: number; lowWater: number };

/** Remaining open quantity of the (single) futures leg. */
export function openQty(p: Position): number {
  const l = p.legs[0];
  return l ? l.filledQty - (l.exitQty ?? 0) : 0;
}

/** Round-trip cost per unit implied at entry: maxLoss/units - stopDistance (fees, spread, funding). */
export function costPerUnit(p: Position): number {
  const sd = p.stopDistance ?? 0;
  const units = p.legs[0]?.filledQty || p.units;
  if (!(units > 0)) return 0;
  return Math.max(0, p.maxLoss / units - sd);
}

export function isV2Eligible(p: Position): boolean {
  return !!p.exitPlan.v2 && p.legs.length === 1 && p.legs[0].kind === 'FUTURE' && (p.stopDistance ?? 0) > 0 && p.legs[0].filledQty > 0;
}

/**
 * R in price units: the loss at the initial stop. It honours the hard stop-loss % of max loss
 * (riskFraction), so v2 never risks more than the legacy %-stop the risk limits were set for.
 */
export function riskUnit(p: Position): number {
  const sd = p.stopDistance ?? 0;
  const cpu = costPerUnit(p);
  const rf = Math.min(1, Math.max(0.05, p.exitPlan.v2?.riskFraction ?? 1));
  return Math.max(sd * 0.05, rf * (sd + cpu) - cpu);
}

/** Initial stop for a freshly opened futures position. */
export function initialStop(p: Position): number {
  const l = p.legs[0];
  const s = l.side === 'BUY' ? 1 : -1;
  return l.entryPrice - s * riskUnit(p);
}

const tighter = (s: 1 | -1, a: number, b: number) => (s === 1 ? Math.max(a, b) : Math.min(a, b));

export function evaluateExitV2(p: Position, ctx: ExitEngineCtx): ExitAction {
  const v2 = p.exitPlan.v2 as ExitV2Plan;
  const l = p.legs[0];
  const s: 1 | -1 = l.side === 'BUY' ? 1 : -1;
  const entry = l.entryPrice;
  const R = riskUnit(p);
  const cpu = costPerUnit(p);
  const stop = p.stopPrice ?? initialStop(p);
  const hw = p.highWater ?? entry;
  const lw = p.lowWater ?? entry;
  const hit = new Set(p.milestonesHit ?? []);
  const lo = ctx.bar ? Math.min(ctx.bar.l, ctx.price) : ctx.price;
  const hi = ctx.bar ? Math.max(ctx.bar.h, ctx.price) : ctx.price;
  const open = ctx.bar?.o ?? ctx.price;
  const adverse = s === 1 ? lo : hi;
  const favorable = s === 1 ? hi : lo;

  // ---- 1. carried stop first (pessimistic intrabar order)
  if ((s === 1 && adverse <= stop) || (s === -1 && adverse >= stop)) {
    // gap through the stop: a resting stop fills at the open, not at the stop
    const gapped = (s === 1 && open < stop) || (s === -1 && open > stop);
    const px = ctx.bar ? (gapped ? open : stop) : ctx.price;
    const lockedR = (s * (stop - entry) - cpu) / R;
    const reason = lockedR > 0.05 ? (p.stopKind === 'PROFIT_LOCK' ? 'PROFIT_LOCK' : 'TRAILING_STOP') : lockedR > -0.05 ? 'BREAKEVEN_STOP' : 'PROTECTIVE_STOP';
    return {
      kind: 'CLOSE',
      reason,
      triggerPrice: px,
      detail: `${s === 1 ? 'low' : 'high'} ${adverse.toFixed(4)} crossed stop ${stop.toFixed(4)} (${lockedR >= 0 ? '+' : ''}${lockedR.toFixed(2)}R after costs)${gapped && ctx.bar ? `, gapped: filled at open ${open.toFixed(4)}` : ''}`,
      newStop: stop,
      highWater: hw,
      lowWater: lw,
    };
  }

  // ---- 2. final target (non-trend sleeves)
  if (v2.finalTargetR > 0) {
    const tgt = entry + s * (v2.finalTargetR * R + cpu);
    if ((s === 1 && favorable >= tgt) || (s === -1 && favorable <= tgt)) {
      const px = ctx.bar ? ((s === 1 && open > tgt) || (s === -1 && open < tgt) ? open : tgt) : ctx.price;
      return { kind: 'CLOSE', reason: 'FINAL_TARGET', triggerPrice: px, detail: `reached +${v2.finalTargetR}R target ${tgt.toFixed(4)}`, newStop: stop, highWater: hw, lowWater: lw };
    }
  }

  // ---- 3. milestones (lowest un-hit first; one action per evaluation keeps orders idempotent)
  let newStop = stop;
  let stopKind = p.stopKind;
  for (let i = 0; i < v2.milestones.length; i++) {
    if (hit.has(i)) continue;
    const m = v2.milestones[i];
    const trigger = entry + s * (m.r * R + cpu);
    if ((s === 1 && favorable >= trigger) || (s === -1 && favorable <= trigger)) {
      const origQty = l.filledQty;
      const raw = origQty * m.fraction;
      let qty = Math.floor(raw / ctx.qtyStep + 1e-9) * ctx.qtyStep;
      const remaining = openQty(p);
      // never book the whole position at a milestone; leave a runner that is at least one step
      if (remaining - qty < ctx.qtyStep) qty = Math.max(0, Math.floor((remaining - ctx.qtyStep) / ctx.qtyStep + 1e-9) * ctx.qtyStep);
      const lock = Number.isFinite(m.lockR) ? entry + s * (m.lockR * R + cpu) : stop;
      newStop = tighter(s, newStop, lock);
      if (Number.isFinite(m.lockR)) stopKind = m.lockR > 0 ? 'PROFIT_LOCK' : 'BREAKEVEN';
      const px = ctx.bar ? ((s === 1 && open > trigger) || (s === -1 && open < trigger) ? open : trigger) : ctx.price;
      if (qty >= ctx.qtyStep) {
        return {
          kind: 'PARTIAL',
          milestoneIndex: i,
          qty,
          triggerPrice: px,
          detail: `+${m.r}R milestone at ${trigger.toFixed(4)}: book ${qty} of ${origQty} (${(m.fraction * 100).toFixed(0)}% of original); stop -> ${newStop.toFixed(4)}`,
          newStop,
          stopKind,
          milestonesHit: [...hit, i],
          highWater: hw,
          lowWater: lw,
        };
      }
      // nothing to book (fraction 0 or too small): record the milestone as a stop move only
      hit.add(i);
    }
  }

  // ---- 4. update water marks with this bar, then ratchet trailing stops for the NEXT evaluation
  const nhw = Math.max(hw, hi);
  const nlw = Math.min(lw, lo);
  const favR = (s * ((s === 1 ? nhw : nlw) - entry) - cpu) / R;
  if (ctx.atr && ctx.atr > 0 && v2.chandelierAtrMult > 0 && favR >= v2.trailActivateR) {
    const ch = s === 1 ? nhw - v2.chandelierAtrMult * ctx.atr : nlw + v2.chandelierAtrMult * ctx.atr;
    const before = newStop;
    newStop = tighter(s, newStop, ch);
    if (newStop !== before) stopKind = 'TRAIL';
  }
  if (v2.channelFeature && ctx.features) {
    const dist = ctx.features[v2.channelFeature];
    if (Number.isFinite(dist) && dist > 0 && favR >= v2.trailActivateR) {
      const ch = ctx.price * (1 - s * dist);
      const before = newStop;
      newStop = tighter(s, newStop, ch);
      if (newStop !== before) stopKind = 'TRAIL';
    }
  }
  // Profit Guard floor (% of risk) -> price, so the guard lives in the same single stop
  if (p.exitPlan.profitGuard) {
    const peakPct = favR * 100;
    const floorPct = guardFloorPct(p.exitPlan.profitGuard, peakPct);
    if (floorPct !== null) {
      const g = entry + s * ((floorPct / 100) * R + cpu);
      const before = newStop;
      newStop = tighter(s, newStop, g);
      if (newStop !== before) stopKind = 'PROFIT_LOCK';
    }
  }
  // never past the current price (that would be an instant exit caused by our own bookkeeping)
  if ((s === 1 && newStop >= ctx.price) || (s === -1 && newStop <= ctx.price)) newStop = stop;
  return { kind: 'HOLD', newStop: tighter(s, stop, newStop), stopKind, highWater: nhw, lowWater: nlw, milestonesHit: [...hit] };
}

/**
 * The %-of-risk rules that v2 replaces (stop, take-profit, trailing, guard) are neutralised so the
 * remaining checkExit rules (time, signal/target, regime, expiry) cannot fire a competing exit.
 */
export function residualPlan(e: ExitPlan): ExitPlan {
  const NEVER = 1e9;
  // the hard %-stop stays as a backstop (it sits at/below the v2 initial stop by construction)
  return { ...e, takeProfitPct: NEVER, trailingActivationPct: NEVER, trailingDistancePct: NEVER, profitGuard: undefined };
}
