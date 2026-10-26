/**
 * Position lifecycle: multi-leg entry (protective BUY legs first so we are never naked short),
 * partial-fill handling and automatic unwind on failure, mark-to-market, exit monitoring and
 * closing (short legs bought back first), funding accrual, and the immutable trade record.
 */
import type { Mode, Position, PositionLeg, RegimeClassification, StrategyCandidate, ExitPlan, OrderRequest } from '../domain/types.js';
import type { Repositories, TradeRecord } from '../persistence/ports.js';
import type { OrderManager } from '../execution/order-manager.js';
import type { MarketQuoter } from '../execution/quoter.js';
import type { Account } from './account.js';
import { clientOrderId, uuid } from '../lib/ids.js';
import type { Clock } from '../lib/clock.js';
import { MS } from '../lib/clock.js';
import { checkExit, type ExitReason } from '../risk/engine.js';
import { positionExchange } from '../integrations/exchange.js';
import { evaluateExitV2, isV2Eligible, initialStop, residualPlan, openQty } from '../risk/exit-engine.js';
import { STRATEGY_INFO } from '../strategies/builders.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('positions');

export interface OpenRequest {
  decisionId: string;
  candidate: StrategyCandidate;
  units: number;
  underlying: string;
  regime: RegimeClassification;
  modelVersion: string;
  exitPlan: ExitPlan;
  stopDistance?: number;
  leverage?: number;
  features: import('../domain/types.js').FeatureVector;
}

export interface PositionManagerDeps {
  repos: Repositories;
  orders: OrderManager;
  quoter: MarketQuoter;
  account: () => Account;
  clock: Clock;
  mode: () => Mode;
  fundingRate: (underlying: string) => number | undefined;
  fundingIntervalHours: number;
  /** Option orders are sent as marketable limits with this tolerance over the touch (fraction). */
  optionLimitTolerance: number;
  onAlert?: (level: 'warn' | 'error' | 'critical', code: string, msg: string) => void;
  /** exchange this manager trades on; positions of the other exchange are parked (not marked/managed) */
  exchange?: 'coindcx' | 'delta';
  /** Exit Engine v2 may manage LIVE positions only when the operator approved it (exits.engine-v2-live). */
  v2Live?: boolean;
  /** quantity step per instrument (default 0.001) */
  qtyStep?: (instrument: string) => number;
  /** backtests: the last closed bar of the base timeframe (intrabar stop/target detection) */
  barOf?: (underlying: string) => { o: number; h: number; l: number; t: number } | null;
  /** backtests: execute fn with fills referenced to `price` (a resting stop/target order level) */
  execAt?: <T>(underlying: string, price: number, fn: () => Promise<T>) => Promise<T>;
}

const sgn = (s: 'BUY' | 'SELL') => (s === 'BUY' ? 1 : -1);
const legMult = (l: PositionLeg) => (l.kind === 'OPTION' ? l.option!.contractSize : 1);

/** v2 runs in PAPER/backtests; LIVE only after explicit operator approval (exits.engine-v2-live=true). */
export function shouldUseV2(p: Position, mode: Mode, v2Live: boolean): boolean {
  return isV2Eligible(p) && (mode === 'PAPER' || v2Live);
}

export class PositionManager {
  constructor(private readonly d: PositionManagerDeps) {}

  private alert(level: 'warn' | 'error' | 'critical', code: string, msg: string) {
    this.d.onAlert?.(level, code, msg);
  }

  private orderFor(p: Position, l: PositionLeg, idx: number, purpose: 'open' | 'close' | 'adjust', qty: number, attempt = 0): OrderRequest {
    const q = this.d.quoter.quote(l.instrument, l.kind);
    const side = purpose === 'open' ? l.side : l.side === 'BUY' ? 'SELL' : 'BUY';
    const ref = q ? (side === 'BUY' ? q.ask : q.bid) : l.mark;
    const isOpt = l.kind === 'OPTION';
    const tol = this.d.optionLimitTolerance;
    return {
      clientOrderId: clientOrderId(p.decisionId, idx, purpose, attempt),
      decisionId: p.decisionId,
      positionId: p.id,
      legIndex: idx,
      instrument: l.instrument,
      kind: l.kind,
      side,
      qty,
      type: isOpt ? 'LIMIT' : 'MARKET',
      limitPrice: isOpt ? (side === 'BUY' ? ref * (1 + tol) : Math.max(0, ref * (1 - tol))) : undefined,
      reduceOnly: purpose !== 'open',
      leverage: p.leverage,
      refPrice: ref,
    };
  }

  /** Apply PAPER cash effects of a filled leg. */
  private applyFillCash(l: PositionLeg, side: 'BUY' | 'SELL', qty: number, price: number, fee: number, entryPrice?: number) {
    if (this.d.mode() !== 'PAPER') return;
    const acct = this.d.account();
    if (l.kind === 'OPTION') {
      acct.applyCash(-sgn(side) * price * qty * legMult(l), fee);
    } else if (entryPrice !== undefined) {
      // futures close: realise P&L (side here is the closing side)
      acct.applyCash(-sgn(side) * (price - entryPrice) * qty, fee);
    } else {
      acct.applyCash(0, fee);
    }
  }

  async open(r: OpenRequest): Promise<Position> {
    const now = this.d.clock.now();
    const c = r.candidate;
    const ev = c.evaluation!;
    const p: Position = {
      id: uuid(),
      decisionId: r.decisionId,
      mode: this.d.mode(),
      exchange: this.d.exchange ?? 'coindcx',
      underlying: r.underlying,
      strategy: c.strategy,
      legs: c.legs.map((l) => ({ ...l, qty: l.ratio * r.units, entryPrice: 0, filledQty: 0 })),
      units: r.units,
      openedAt: now,
      status: 'OPENING',
      entryCost: 0,
      maxLoss: ev.maxLoss * r.units,
      maxProfit: ev.maxProfit === null ? null : ev.maxProfit * r.units,
      exitPlan: r.exitPlan,
      peakPnl: 0,
      troughPnl: 0,
      fees: 0,
      fundingPaid: 0,
      modelVersion: r.modelVersion,
      regimeAtEntry: r.regime.primary,
      regimeConfidence: r.regime.confidence,
      directionBias: (() => {
        const fut = c.legs.find((l) => l.kind === 'FUTURE');
        if (fut) return fut.side === 'SELL' ? 'BEAR' : 'BULL';
        return STRATEGY_INFO[c.strategy].bias.includes('bull') ? 'BULL' : STRATEGY_INFO[c.strategy].bias.includes('bear') ? 'BEAR' : 'NEUTRAL';
      })(),
      params: c.params,
      featuresAtEntry: r.features,
      evAtEntry: ev.expectedValue * r.units,
      popAtEntry: ev.probabilityOfProfit,
      slippageCost: 0,
      stopDistance: r.stopDistance,
      leverage: r.leverage,
      lastFundingAt: now,
    };
    await this.d.repos.positions.upsert(p);

    // protective legs first: BUY before SELL
    const order = p.legs.map((_, i) => i).sort((a, b) => sgn(p.legs[b].side) - sgn(p.legs[a].side));
    let fillRatio = 1;
    for (const idx of order) {
      const l = p.legs[idx];
      const qty = l.qty * fillRatio;
      const st = await this.d.orders.execute(this.orderFor(p, l, idx, 'open', qty));
      if (st.filledQty > 0) {
        l.filledQty = st.filledQty;
        l.entryPrice = st.avgPrice;
        p.fees += st.fees;
        p.slippageCost += sgn(l.side) * (st.avgPrice - st.request.refPrice) * st.filledQty * legMult(l);
        this.applyFillCash(l, l.side, st.filledQty, st.avgPrice, st.fees);
      }
      const ratio = qty > 0 ? st.filledQty / qty : 0;
      if (st.status === 'UNKNOWN') {
        p.status = 'FAILED';
        p.exitReason = 'ENTRY_UNKNOWN_ORDER_STATE';
        await this.d.repos.positions.upsert(p);
        this.alert('critical', 'ENTRY_UNKNOWN', `Position ${p.id} leg ${idx} order state unknown - reconciliation required`);
        return p;
      }
      if (ratio < 0.999) {
        if (ratio < 0.5 || idx !== order[0]) {
          log.warn({ pos: p.id, leg: idx, ratio, status: st.status, reason: st.rejectReason }, 'leg not filled - unwinding');
          await this.unwind(p, `leg ${idx} ${st.status}: ${st.rejectReason ?? 'partial'}`);
          return p;
        }
        fillRatio *= ratio; // first leg partially filled: scale the rest of the structure
      }
    }
    // Normalise units to what actually filled
    p.units = r.units * fillRatio;
    p.maxLoss = ev.maxLoss * p.units;
    p.maxProfit = ev.maxProfit === null ? null : ev.maxProfit * p.units;
    p.evAtEntry = ev.expectedValue * p.units;
    p.entryCost = p.legs.reduce((s, l) => s + sgn(l.side) * l.entryPrice * l.filledQty * legMult(l), 0) + p.fees;
    p.entryFees = p.fees;
    p.bookings = [];
    if (isV2Eligible(p)) {
      p.stopPrice = initialStop(p);
      p.stopKind = 'INITIAL';
      p.highWater = p.legs[0].entryPrice;
      p.lowWater = p.legs[0].entryPrice;
      p.milestonesHit = [];
    }
    p.status = 'OPEN';
    await this.d.repos.positions.upsert(p);
    if (this.d.mode() === 'PAPER') await this.d.account().save();
    log.info({ pos: p.id, strategy: p.strategy, units: p.units, entryCost: p.entryCost.toFixed(2), maxLoss: p.maxLoss.toFixed(2) }, 'position opened');
    return p;
  }

  /** Close whatever filled during a failed entry. */
  private async unwind(p: Position, why: string) {
    p.status = 'CLOSING';
    await this.d.repos.positions.upsert(p);
    await this.closeLegs(p);
    p.status = 'FAILED';
    p.exitReason = `ENTRY_FAILED: ${why}`;
    p.closedAt = this.d.clock.now();
    p.realizedPnl = this.realized(p);
    await this.d.repos.positions.upsert(p);
    if (this.d.mode() === 'PAPER') await this.d.account().save();
    this.alert('warn', 'ENTRY_UNWOUND', `Position ${p.id} (${p.strategy}) unwound: ${why}`);
  }

  private async closeLegs(p: Position): Promise<boolean> {
    p.closeAttempts = (p.closeAttempts ?? 0) + 1;
    const attempt = p.closeAttempts;
    await this.d.repos.positions.upsert(p);
    // buy back shorts first, then sell longs
    const order = p.legs.map((_, i) => i).sort((a, b) => sgn(p.legs[a].side) - sgn(p.legs[b].side));
    let ok = true;
    for (const idx of order) {
      const l = p.legs[idx];
      const remaining = l.filledQty - (l.exitQty ?? 0);
      if (remaining <= 1e-12) continue;
      if (l.kind === 'OPTION' && l.side === 'BUY') {
        const q = this.d.quoter.quote(l.instrument, l.kind);
        if (q && q.bid <= 0) {
          // zero-bid long option cannot be sold: abandon it at 0 (it can only expire worthless or be a free lottery)
          const prevQty = l.exitQty ?? 0;
          l.exitPrice = ((l.exitPrice ?? 0) * prevQty) / (prevQty + remaining);
          l.exitQty = prevQty + remaining;
          log.info({ pos: p.id, leg: idx, instrument: l.instrument }, 'zero-bid long option abandoned at 0');
          continue;
        }
      }
      const st = await this.d.orders.execute(this.orderFor(p, l, idx, 'close', remaining, attempt));
      if (st.filledQty > 0) {
        const prevQty = l.exitQty ?? 0;
        l.exitPrice = ((l.exitPrice ?? 0) * prevQty + st.avgPrice * st.filledQty) / (prevQty + st.filledQty);
        l.exitQty = prevQty + st.filledQty;
        p.fees += st.fees;
        this.applyFillCash(l, st.request.side, st.filledQty, st.avgPrice, st.fees, l.kind === 'FUTURE' ? l.entryPrice : undefined);
      }
      if (l.filledQty - (l.exitQty ?? 0) > 1e-9) ok = false;
    }
    return ok;
  }

  private grossRealized(p: Position): number {
    let g = 0;
    for (const l of p.legs) g += sgn(l.side) * ((l.exitPrice ?? 0) - l.entryPrice) * (l.exitQty ?? 0) * legMult(l);
    return g;
  }

  private realized(p: Position): number {
    let pnl = 0;
    for (const l of p.legs) {
      const q = l.exitQty ?? 0;
      if (q <= 0) continue;
      pnl += sgn(l.side) * ((l.exitPrice ?? 0) - l.entryPrice) * q * legMult(l);
    }
    return pnl - p.fees - p.fundingPaid;
  }

  /** Current P&L if closed at the touch now (includes paid fees and an estimate of exit fees). */
  mark(p: Position): { pnl: number; value: number } | null {
    let pnl = 0;
    let value = 0;
    for (const l of p.legs) {
      const q = l.filledQty - (l.exitQty ?? 0);
      if (q <= 0) continue;
      const quote = this.d.quoter.quote(l.instrument, l.kind);
      if (!quote) return null;
      const exitPx = l.side === 'BUY' ? quote.bid : quote.ask;
      pnl += sgn(l.side) * (exitPx - l.entryPrice) * q * legMult(l);
      if (l.kind === 'OPTION') value += sgn(l.side) * exitPx * q * legMult(l);
      else value += sgn(l.side) * (exitPx - l.entryPrice) * q;
    }
    // realised part of partially closed legs
    for (const l of p.legs) if ((l.exitQty ?? 0) > 0) pnl += sgn(l.side) * ((l.exitPrice ?? 0) - l.entryPrice) * (l.exitQty ?? 0) * legMult(l);
    // exit fees: same schedule as entry, on the quantity still open (was 0.5 x all fees paid, which
    // under-estimated the exit fee and over-stated withdrawable profit)
    let estExitFees = 0;
    if (p.status === 'OPEN') {
      if (p.entryFees !== undefined) {
        const filled = p.legs.reduce((a, l) => a + l.filledQty, 0);
        const open = p.legs.reduce((a, l) => a + (l.filledQty - (l.exitQty ?? 0)), 0);
        estExitFees = filled > 0 ? p.entryFees * (open / filled) : 0;
      } else estExitFees = p.fees * 0.5;
    }
    return { pnl: pnl - p.fees - estExitFees - p.fundingPaid, value };
  }

  async close(p: Position, reason: ExitReason | string, detail = '', triggerPrice?: number): Promise<Position> {
    if (p.status === 'CLOSED' || p.status === 'FAILED') return p;
    p.status = 'CLOSING';
    p.exitReason = reason;
    await this.d.repos.positions.upsert(p);
    const before = this.legSnapshot(p);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const run = () => this.closeLegs(p);
      ok = triggerPrice !== undefined && this.d.execAt ? await this.d.execAt(p.underlying, triggerPrice, run) : await run();
      if (!ok) await this.d.clock.sleep(1000 * attempt);
    }
    this.recordBooking(p, 'CLOSE', reason, before, detail);
    if (!ok) {
      await this.d.repos.positions.upsert(p);
      this.alert('critical', 'CLOSE_INCOMPLETE', `Position ${p.id} could not be fully closed (${reason}). Manual intervention / reconciliation required.`);
      return p;
    }
    p.status = 'CLOSED';
    p.closedAt = this.d.clock.now();
    p.realizedPnl = this.realized(p);
    await this.d.repos.positions.upsert(p);
    await this.recordTrade(p);
    log.info({ pos: p.id, strategy: p.strategy, pnl: p.realizedPnl.toFixed(2), reason, detail }, 'position closed');
    return p;
  }

  private legSnapshot(p: Position) {
    return { qty: p.legs.map((l) => l.exitQty ?? 0), px: p.legs.map((l) => l.exitPrice ?? 0), fees: p.fees };
  }

  /** Append an exit booking (only what actually FILLED since `before`). */
  private recordBooking(p: Position, kind: 'PARTIAL' | 'CLOSE', reason: string, before: ReturnType<PositionManager['legSnapshot']>, detail?: string) {
    let qty = 0;
    let gross = 0;
    let notional = 0;
    p.legs.forEach((l, i) => {
      const q0 = before.qty[i];
      const q1 = l.exitQty ?? 0;
      const dq = q1 - q0;
      if (dq <= 1e-12) return;
      const px = (((l.exitPrice ?? 0) * q1) - before.px[i] * q0) / dq; // avg price of the new fills
      qty += dq;
      notional += px * dq;
      gross += sgn(l.side) * (px - l.entryPrice) * dq * legMult(l);
    });
    if (qty <= 0) return;
    (p.bookings ??= []).push({ ts: this.d.clock.now(), kind, reason, qty, price: notional / qty, grossPnl: gross, fees: p.fees - before.fees, detail });
  }

  /**
   * Book part of a futures position at a profit milestone. The clientOrderId is deterministic per
   * (position, milestone), so a retry after a crash returns the same order instead of booking twice.
   * The milestone is only marked done once a fill is confirmed.
   */
  async reduce(p: Position, qty: number, milestoneIndex: number, reason: string, detail: string, triggerPrice?: number): Promise<number> {
    const l = p.legs[0];
    const remaining = l.filledQty - (l.exitQty ?? 0);
    const q = Math.min(qty, remaining);
    if (q <= 0 || p.status !== 'OPEN') return 0;
    const before = this.legSnapshot(p);
    const run = () => this.d.orders.execute(this.orderFor(p, l, 0, 'adjust', q, 100 + milestoneIndex));
    const st = triggerPrice !== undefined && this.d.execAt ? await this.d.execAt(p.underlying, triggerPrice, run) : await run();
    if (st.status === 'UNKNOWN') {
      this.alert('critical', 'REDUCE_UNKNOWN', `Position ${p.id} milestone ${milestoneIndex} order state unknown - reconciliation required (no duplicate will be sent)`);
      return 0;
    }
    if (st.filledQty > 0) {
      const prevQty = l.exitQty ?? 0;
      l.exitPrice = ((l.exitPrice ?? 0) * prevQty + st.avgPrice * st.filledQty) / (prevQty + st.filledQty);
      l.exitQty = prevQty + st.filledQty;
      p.fees += st.fees;
      this.applyFillCash(l, st.request.side, st.filledQty, st.avgPrice, st.fees, l.entryPrice);
      p.milestonesHit = [...new Set([...(p.milestonesHit ?? []), milestoneIndex])];
      this.recordBooking(p, 'PARTIAL', reason, before, detail);
      log.info({ pos: p.id, milestone: milestoneIndex, qty: st.filledQty, px: st.avgPrice }, 'profit booked');
    } else {
      this.alert('warn', 'REDUCE_NOT_FILLED', `Position ${p.id} milestone ${milestoneIndex} not filled (${st.status}: ${st.rejectReason ?? ''}); will retry on next pass`);
    }
    await this.d.repos.positions.upsert(p);
    if (this.d.mode() === 'PAPER') await this.d.account().save();
    return st.filledQty;
  }

  private async recordTrade(p: Position) {
    const pnl = p.realizedPnl ?? 0;
    const t: TradeRecord = {
      positionId: p.id,
      decisionId: p.decisionId,
      mode: p.mode,
      source: p.mode === 'LIVE' ? 'LIVE' : 'PAPER',
      underlying: p.underlying,
      strategy: p.strategy,
      params: p.params,
      modelVersion: p.modelVersion,
      regime: p.regimeAtEntry,
      regimeConfidence: p.regimeConfidence,
      featuresAtEntry: p.featuresAtEntry,
      openedAt: p.openedAt,
      closedAt: p.closedAt!,
      holdingMs: p.closedAt! - p.openedAt,
      entryCost: p.entryCost,
      maxLoss: p.maxLoss,
      realizedPnl: pnl,
      returnOnRisk: p.maxLoss > 0 ? pnl / p.maxLoss : 0,
      fees: p.fees,
      funding: p.fundingPaid,
      slippageCost: p.slippageCost,
      mae: p.troughPnl,
      mfe: p.peakPnl,
      exitReason: p.exitReason ?? 'UNKNOWN',
      grossPnl: this.grossRealized(p),
      entryPrice: p.legs.length === 1 ? p.legs[0].entryPrice : undefined,
      exitPrice: p.legs.length === 1 ? p.legs[0].exitPrice : undefined,
      qty: p.legs.length === 1 ? p.legs[0].filledQty : undefined,
      bookings: p.bookings,
      expectedValueAtEntry: p.evAtEntry,
      popAtEntry: p.popAtEntry,
    };
    await this.d.repos.trades.append(t);
    await this.d.repos.outcomes.append({ decisionId: p.decisionId, positionId: p.id, ts: p.closedAt!, realizedPnl: pnl, returnOnRisk: t.returnOnRisk, exitReason: t.exitReason });
    await this.d.account().recordClosedTrade(pnl);
  }

  /** Funding accrual for futures legs (PAPER simulation; LIVE funding is reflected in wallet). */
  async accrueFunding(p: Position): Promise<void> {
    const fr = this.d.fundingRate(p.underlying);
    if (fr === undefined || !p.legs.some((l) => l.kind === 'FUTURE')) return;
    const now = this.d.clock.now();
    const interval = this.d.fundingIntervalHours * MS.h;
    const last = p.lastFundingAt ?? p.openedAt;
    const periods = Math.floor((now - last) / interval);
    if (periods <= 0) return;
    let amt = 0;
    for (const l of p.legs) {
      if (l.kind !== 'FUTURE') continue;
      const q = l.filledQty - (l.exitQty ?? 0);
      amt += sgn(l.side) * fr * l.entryPrice * q * periods;
    }
    p.fundingPaid += amt;
    p.lastFundingAt = last + periods * interval;
    if (this.d.mode() === 'PAPER') this.d.account().applyFunding(amt);
  }

  /** One monitoring pass over open positions. */
  async monitor(regimeOf: (underlying: string) => RegimeClassification | null, featuresOf?: (underlying: string) => Record<string, number> | null): Promise<void> {
    const open = await this.listOpen();
    for (const p of open) {
      if (p.status !== 'OPEN') continue;
      await this.accrueFunding(p);
      const m = this.mark(p);
      if (!m) continue;
      p.peakPnl = Math.max(p.peakPnl, m.pnl);
      p.troughPnl = Math.min(p.troughPnl, m.pnl);
      p.lastMarkPnl = m.pnl;
      p.lastMarkAt = this.d.clock.now();
      const features = featuresOf?.(p.underlying) ?? null;
      const useV2 = shouldUseV2(p, this.d.mode(), this.d.v2Live === true);
      if (useV2) {
        const done = await this.manageV2(p, features);
        if (done) continue;
        // remaining rules (time, signal/target, regime) on a plan with the replaced %-rules neutralised
        const ex = checkExit({ ...p, exitPlan: residualPlan(p.exitPlan) }, m.pnl, this.d.clock.now(), regimeOf(p.underlying), features);
        if (ex.exit) await this.close(p, ex.reason!, ex.detail);
        else await this.d.repos.positions.upsert(p);
        continue;
      }
      const ex = checkExit(p, m.pnl, this.d.clock.now(), regimeOf(p.underlying), features);
      if (ex.profitFloorPct !== undefined) p.profitFloorPct = ex.profitFloorPct;
      if (ex.exit) await this.close(p, ex.reason!, ex.detail);
      else await this.d.repos.positions.upsert(p);
    }
  }

  /** Exit Engine v2 pass. Returns true when the position was closed. */
  private async manageV2(p: Position, features: Record<string, number> | null): Promise<boolean> {
    const l = p.legs[0];
    const q = this.d.quoter.quote(l.instrument, l.kind);
    if (!q) return false; // no valid market data: never act on a stale/absent price
    const price = l.side === 'BUY' ? q.bid : q.ask;
    if (!(price > 0)) return false;
    let bar = this.d.barOf?.(p.underlying) ?? undefined;
    // a bar that opened before the position cannot be used (look-ahead into the entry bar)
    if (bar && bar.t < p.openedAt - 1) bar = undefined;
    const atrPct = features?.[p.exitPlan.v2!.atrFeature] ?? features?.atrPct;
    const act = evaluateExitV2(p, {
      price,
      bar: bar ? { o: bar.o, h: bar.h, l: bar.l } : undefined,
      atr: atrPct && atrPct > 0 ? atrPct * price : null,
      features,
      qtyStep: this.d.qtyStep?.(l.instrument) ?? 0.001,
    });
    p.stopPrice = act.newStop;
    p.highWater = act.highWater;
    p.lowWater = act.lowWater;
    if (act.kind === 'HOLD') {
      p.milestonesHit = act.milestonesHit;
      if (act.stopKind) p.stopKind = act.stopKind;
      return false;
    }
    if (act.kind === 'PARTIAL') {
      if (act.stopKind) p.stopKind = act.stopKind;
      const filled = await this.reduce(p, act.qty, act.milestoneIndex, `PROFIT_BOOKED_${p.exitPlan.v2!.milestones[act.milestoneIndex].r}R`, act.detail, bar ? act.triggerPrice : undefined);
      if (filled <= 0) return false;
      if (openQty(p) <= 1e-12) {
        await this.close(p, 'PROFIT_BOOKED', act.detail);
        return true;
      }
      return false;
    }
    await this.close(p, act.reason, act.detail, bar ? act.triggerPrice : undefined);
    return true;
  }

  /** Open positions of THIS manager's mode and exchange. */
  async listOpen(): Promise<Position[]> {
    const ex = this.d.exchange ?? 'coindcx';
    return (await this.d.repos.positions.listOpen(this.d.mode())).filter((p) => positionExchange(p) === ex);
  }

  async flattenAll(reason: string): Promise<number> {
    const open = await this.listOpen();
    for (const p of open) await this.close(p, reason);
    return open.length;
  }

  /**
   * Equity identity: `equity = cash + unrealized`.
   * `unrealized` is open-position NAV (futures mark-to-market vs entry; options at touch).
   * Close-out P&L after remaining exit fees lives on `mark().pnl` / `lastMarkPnl`, not here.
   */
  async equity(cash: number): Promise<{ equity: number; unrealized: number; marginInUse: number; open: Position[] }> {
    const open = await this.listOpen();
    let value = 0;
    let margin = 0;
    for (const p of open) {
      const m = this.mark(p);
      if (m) value += m.value;
      for (const l of p.legs) {
        if (l.kind === 'FUTURE') margin += (l.entryPrice * (l.filledQty - (l.exitQty ?? 0))) / Math.max(1, p.leverage ?? 1);
      }
      if (p.entryCost < 0) margin += p.maxLoss; // credit structures lock collateral
    }
    return { equity: cash + value, unrealized: value, marginInUse: margin, open };
  }
}
