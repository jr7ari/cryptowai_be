/**
 * LIVE venues.
 *
 * LiveFuturesVenue - CoinDCX perpetual futures on VERIFIED endpoints. Before every order it validates
 * the instrument spec (status, quantity_increment, min/max quantity, min_notional, price_increment,
 * max leverage), the available balance, and rounds quantities DOWN to the increment.
 * Ambiguous submissions (timeouts/5xx after send) are never blindly retried: the order is marked
 * UNKNOWN and resolved by looking it up on the exchange ("reconcile-before-retry").
 *
 * LiveOptionsVenue - CoinDCX publishes no options trading API (verified 2026-10). This venue refuses
 * every order with a clear capability error instead of guessing endpoints.
 */
import type { OrderRequest, OrderState, Mode } from '../domain/types.js';
import type { ExecutionVenue, ValidationResult, VenueBalances, VenuePosition } from './venue.js';
import { newOrderState } from './venue.js';
import type { FuturesExchangeClient } from '../integrations/exchange.js';
import { mapOrderStatus, type CdxOrder } from '../integrations/coindcx/types.js';
import { ExchangeError } from '../lib/errors.js';
import { floorToStep, roundToStep } from '../lib/math.js';
import type { Clock } from '../lib/clock.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('live-venue');

export interface LiveFuturesConfig {
  maxLeverage: number;
  marginCurrency: string;
  walletPath?: string;
  walletMethod?: 'GET' | 'POST';
  /** Send client_order_id in create payload (only if confirmed supported by your account's API version). */
  sendClientOrderId: boolean;
}

export class LiveFuturesVenue implements ExecutionVenue {
  readonly name: string;
  readonly mode: Mode = 'LIVE';
  constructor(private readonly rest: FuturesExchangeClient, private readonly cfg: LiveFuturesConfig, private readonly clock: Clock) {
    this.name = `${rest.exchange}-futures`;
  }

  capabilities() {
    return { options: false, futures: this.rest.authenticated, reason: this.rest.authenticated ? undefined : 'API credentials missing' };
  }

  async validate(req: OrderRequest): Promise<ValidationResult> {
    if (req.kind !== 'FUTURE') return { ok: false, reason: 'futures venue only accepts FUTURE orders' };
    const inst = await this.rest.instrument(req.instrument);
    if (inst.status !== 'active') return { ok: false, reason: `instrument ${req.instrument} status=${inst.status}` };
    const qty = floorToStep(req.qty, inst.quantity_increment);
    if (qty < inst.min_quantity) return { ok: false, reason: `qty ${qty} < min_quantity ${inst.min_quantity}` };
    if (inst.max_quantity && qty > inst.max_quantity) return { ok: false, reason: `qty ${qty} > max_quantity ${inst.max_quantity}` };
    if (req.type === 'MARKET' && inst.max_market_order_quantity && qty > Number(inst.max_market_order_quantity)) {
      return { ok: false, reason: `qty ${qty} > max_market_order_quantity ${inst.max_market_order_quantity}` };
    }
    const px = req.type === 'LIMIT' ? roundToStep(req.limitPrice!, inst.price_increment) : req.refPrice;
    if (inst.min_notional && qty * px < Number(inst.min_notional)) return { ok: false, reason: `notional ${(qty * px).toFixed(2)} < min_notional ${inst.min_notional}` };
    const lev = req.leverage ?? 1;
    const maxLev = Math.min(this.cfg.maxLeverage, req.side === 'BUY' ? inst.max_leverage_long ?? Infinity : inst.max_leverage_short ?? Infinity);
    if (lev > maxLev) return { ok: false, reason: `leverage ${lev} > allowed ${maxLev}` };
    if (!req.reduceOnly) {
      const bal = await this.balances();
      const needed = (qty * px) / lev;
      if (needed > bal.cash - bal.marginInUse) return { ok: false, reason: `insufficient margin: need ${needed.toFixed(2)}, free ${(bal.cash - bal.marginInUse).toFixed(2)}` };
    }
    return { ok: true, qty, price: req.type === 'LIMIT' ? px : undefined };
  }

  async checkInstrument(instrument: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const i = await this.rest.instrument(instrument, 0);
      const ok = i.status === 'active' && i.quantity_increment > 0 && i.price_increment > 0 && i.min_quantity > 0;
      return { ok, detail: `status=${i.status} qty_step=${i.quantity_increment} min_qty=${i.min_quantity} px_step=${i.price_increment} min_notional=${i.min_notional ?? 'n/a'}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async submit(req: OrderRequest): Promise<OrderState> {
    const o = newOrderState(req, this.clock.now());
    const submittedAt = this.clock.now();
    try {
      const res = await this.rest.createOrder({
        pair: req.instrument,
        side: req.side === 'BUY' ? 'buy' : 'sell',
        order_type: req.type === 'MARKET' ? 'market_order' : 'limit_order',
        total_quantity: req.qty,
        price: req.limitPrice,
        leverage: req.leverage ?? 1,
        client_order_id: this.cfg.sendClientOrderId ? req.clientOrderId : undefined,
        reduce_only: req.reduceOnly,
      });
      const first = res[0];
      if (!first?.id) {
        o.status = 'UNKNOWN';
        o.rejectReason = 'create returned no order id';
        return o;
      }
      return this.apply(o, first);
    } catch (e) {
      if (e instanceof ExchangeError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) {
        o.status = 'REJECTED';
        o.rejectReason = e.message;
        o.updatedAt = this.clock.now();
        return o;
      }
      // Ambiguous: the order may or may not exist. Try to find it; never resubmit blindly.
      log.error({ coid: req.clientOrderId, err: (e as Error).message }, 'ambiguous order submission; resolving');
      const found = await this.findRecent(req, submittedAt).catch(() => null);
      if (found) return this.apply(o, found);
      o.status = 'UNKNOWN';
      o.rejectReason = `ambiguous submission: ${(e as Error).message}`;
      o.updatedAt = this.clock.now();
      return o;
    }
  }

  private apply(o: OrderState, x: CdxOrder): OrderState {
    o.venueOrderId = x.id;
    o.status = mapOrderStatus(x.status);
    const total = Number(x.total_quantity) || o.request.qty;
    const remaining = Number(x.remaining_quantity ?? total);
    const cancelled = Number(x.cancelled_quantity ?? 0);
    o.filledQty = Math.max(0, total - remaining - cancelled);
    o.avgPrice = Number(x.avg_price) || o.avgPrice;
    o.fees = Number(x.fee_amount) || o.fees;
    if (o.status === 'FILLED' && o.filledQty === 0) o.filledQty = total;
    o.updatedAt = this.clock.now();
    return o;
  }

  /** Locate an order we may have created (same pair/side/qty, created after submit time). */
  private async findRecent(req: OrderRequest, since: number): Promise<CdxOrder | null> {
    // exchanges with a client-order-id lookup (Delta) answer exactly; no heuristics needed
    if (this.cfg.sendClientOrderId && this.rest.orderByClientId) return this.rest.orderByClientId(req.clientOrderId);
    const side = req.side === 'BUY' ? 'buy' : 'sell';
    for (const status of ['open', 'partially_filled', 'filled']) {
      const list = await this.rest.listOrders(status, side, 1, 20);
      const hit = list.find(
        (x) =>
          x.pair === req.instrument &&
          (x.client_order_id === req.clientOrderId ||
            (Math.abs(Number(x.total_quantity) - req.qty) < 1e-9 && (x.created_at ?? 0) >= since - 5_000)),
      );
      if (hit) return hit;
    }
    return null;
  }

  async refresh(o: OrderState): Promise<OrderState> {
    if (o.status === 'UNKNOWN' && !o.venueOrderId) {
      const found = await this.findRecent(o.request, o.createdAt);
      if (found) return this.apply(o, found);
      // still not visible after a grace period -> treat as not placed
      if (this.clock.now() - o.createdAt > 60_000) {
        o.status = 'REJECTED';
        o.rejectReason = 'ambiguous order never appeared on exchange';
      }
      return o;
    }
    if (!o.venueOrderId) return o;
    if (this.rest.orderById) {
      const hit = await this.rest.orderById(o.venueOrderId);
      return hit ? this.apply(o, hit) : o;
    }
    const side = o.request.side === 'BUY' ? 'buy' : 'sell';
    for (const status of ['open', 'partially_filled', 'filled', 'cancelled', 'rejected']) {
      const list = await this.rest.listOrders(status, side, 1, 50);
      const hit = list.find((x) => x.id === o.venueOrderId);
      if (hit) return this.apply(o, hit);
    }
    return o;
  }

  async cancel(o: OrderState): Promise<OrderState> {
    if (!o.venueOrderId) return o;
    await this.rest.cancelOrder(o.venueOrderId);
    return this.refresh(o);
  }

  async balances(): Promise<VenueBalances> {
    const w = await this.rest.wallets(this.cfg.walletPath, this.cfg.walletMethod);
    const e = w.find((x) => x.currency_short_name === this.cfg.marginCurrency);
    if (!e) throw new ExchangeError(`no ${this.cfg.marginCurrency} futures wallet`, undefined, false);
    const balance = Number(e.balance);
    const locked = Number(e.locked_balance ?? 0);
    return { equity: balance, cash: balance, marginInUse: locked, currency: this.cfg.marginCurrency };
  }

  async positions(): Promise<VenuePosition[]> {
    const ps = await this.rest.listPositions(1, 100);
    return ps
      .filter((p) => Number(p.active_pos) !== 0)
      .map((p) => ({ instrument: p.pair, qty: Number(p.active_pos), avgPrice: Number(p.avg_price ?? 0), venuePositionId: p.id }));
  }

  async emergencyFlatten(reason: string): Promise<void> {
    log.error({ reason }, 'EMERGENCY FLATTEN (live futures)');
    try {
      await this.rest.cancelAllOpenOrders();
    } catch (e) {
      log.error({ err: (e as Error).message }, 'cancel-all failed');
    }
    for (const p of await this.positions()) {
      if (!p.venuePositionId) continue;
      try {
        await this.rest.exitPosition(p.venuePositionId);
      } catch (e) {
        log.error({ pair: p.instrument, err: (e as Error).message }, 'exit position failed - MANUAL ACTION REQUIRED');
      }
    }
  }
}

export class LiveOptionsVenue implements ExecutionVenue {
  readonly name = 'live-options-disabled';
  readonly mode: Mode = 'LIVE';
  static readonly REASON =
    'CoinDCX does not publish an options trading API (options are app-only/waitlist as of 2026-10). Options run in PAPER only until official endpoints are verified and an adapter is implemented.';
  static readonly DELTA_REASON =
    'Delta Exchange has an options API, but LIVE options are not implemented in this engine yet (multi-leg margin, expiry and contract handling need their own validated adapter). Options run in PAPER only.';
  constructor(private readonly reason: string = LiveOptionsVenue.REASON) {}
  capabilities() {
    return { options: false, futures: false, reason: this.reason };
  }
  async validate(): Promise<ValidationResult> {
    return { ok: false, reason: this.reason };
  }
  async submit(req: OrderRequest): Promise<OrderState> {
    const o = newOrderState(req, Date.now());
    o.status = 'REJECTED';
    o.rejectReason = this.reason;
    return o;
  }
  async refresh(o: OrderState) {
    return o;
  }
  async cancel(o: OrderState) {
    return o;
  }
  async balances(): Promise<VenueBalances> {
    return { equity: 0, cash: 0, marginInUse: 0, currency: 'USDT' };
  }
  async positions(): Promise<VenuePosition[]> {
    return [];
  }
  async emergencyFlatten(): Promise<void> {}
}

/** Routes OPTION orders to the options venue and FUTURE orders to the futures venue. */
export class CompositeLiveVenue implements ExecutionVenue {
  readonly name: string;
  readonly mode: Mode = 'LIVE';
  constructor(private readonly futures: LiveFuturesVenue, private readonly options: LiveOptionsVenue) {
    this.name = futures.name.replace('-futures', '-live');
  }
  capabilities() {
    const f = this.futures.capabilities();
    const o = this.options.capabilities();
    return { options: o.options, futures: f.futures, reason: [f.reason, o.reason].filter(Boolean).join(' | ') || undefined };
  }
  private pick(req: OrderRequest) {
    return req.kind === 'OPTION' ? this.options : this.futures;
  }
  validate(req: OrderRequest) {
    return this.pick(req).validate(req);
  }
  submit(req: OrderRequest) {
    return this.pick(req).submit(req);
  }
  refresh(o: OrderState) {
    return this.pick(o.request).refresh(o);
  }
  cancel(o: OrderState) {
    return this.pick(o.request).cancel(o);
  }
  balances() {
    return this.futures.balances();
  }
  checkInstrument(instrument: string) {
    return this.futures.checkInstrument(instrument);
  }
  positions() {
    return this.futures.positions();
  }
  async emergencyFlatten(reason: string) {
    await this.futures.emergencyFlatten(reason);
  }
}
