/**
 * Order manager: the single path every order takes, in every mode.
 *  1. idempotency: the deterministic clientOrderId is inserted with a UNIQUE index BEFORE submission;
 *     a duplicate (e.g. retry after crash) returns the existing order instead of placing a new one
 *  2. venue-side validation (instrument specs, balance, leverage)
 *  3. submission; every state transition appended to the immutable order_events ledger, fills to fills
 *  4. drive to a terminal state (poll/refresh with timeout, cancel remainder), resolve UNKNOWNs
 */
import type { Mode, OrderRequest, OrderState } from '../domain/types.js';
import { TERMINAL_ORDER_STATUSES } from '../domain/types.js';
import type { Repositories } from '../persistence/ports.js';
import { DuplicateOrderError } from '../persistence/ports.js';
import type { ExecutionVenue } from './venue.js';
import { newOrderState } from './venue.js';
import type { Clock } from '../lib/clock.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('orders');

export class OrderManager {
  private recentSubmits: number[] = [];
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly getVenue: () => ExecutionVenue,
    private readonly onAlert?: (level: 'warn' | 'error' | 'critical', code: string, msg: string) => void,
  ) {}

  get mode(): Mode {
    return this.getVenue().mode;
  }

  ordersLastMinute(): number {
    const cut = this.clock.now() - 60_000;
    this.recentSubmits = this.recentSubmits.filter((t) => t >= cut);
    return this.recentSubmits.length;
  }

  private async record(o: OrderState, note?: string) {
    const mode = this.mode;
    await this.repos.orders.update(o, mode);
    await this.repos.orderEvents.append({
      clientOrderId: o.request.clientOrderId,
      ts: this.clock.now(),
      status: o.status,
      filledQty: o.filledQty,
      avgPrice: o.avgPrice,
      venueOrderId: o.venueOrderId,
      note: note ?? o.rejectReason,
      mode,
    });
  }

  private async recordNewFills(o: OrderState, already: number) {
    for (const f of o.fills.slice(already)) await this.repos.fills.append({ ...f, mode: this.mode });
  }

  /** Place an order idempotently. Returns the (possibly pre-existing) order state. */
  async place(req: OrderRequest): Promise<OrderState> {
    const venue = this.getVenue();
    const initial = newOrderState(req, this.clock.now());
    try {
      await this.repos.orders.create(initial, venue.mode);
    } catch (e) {
      if (e instanceof DuplicateOrderError) {
        log.warn({ coid: req.clientOrderId, pos: req.positionId, leg: req.legIndex }, 'duplicate order intent suppressed');
        const existing = await this.repos.orders.get(req.clientOrderId);
        if (existing) return existing;
      }
      throw e;
    }
    await this.repos.orderEvents.append({ clientOrderId: req.clientOrderId, ts: this.clock.now(), status: 'PENDING_NEW', filledQty: 0, avgPrice: 0, mode: venue.mode, note: 'intent recorded' });

    const v = await venue.validate(req).catch((e) => ({ ok: false, reason: `validation error: ${(e as Error).message}` }) as const);
    if (!v.ok) {
      initial.status = 'REJECTED';
      initial.rejectReason = v.reason;
      initial.updatedAt = this.clock.now();
      await this.record(initial, `pre-trade validation failed: ${v.reason}`);
      return initial;
    }
    const finalReq: OrderRequest = { ...req, qty: v.qty ?? req.qty, limitPrice: v.price ?? req.limitPrice };
    this.recentSubmits.push(this.clock.now());
    let state: OrderState;
    try {
      state = await venue.submit(finalReq);
    } catch (e) {
      state = { ...initial, request: finalReq, status: 'UNKNOWN', rejectReason: (e as Error).message, updatedAt: this.clock.now() };
    }
    await this.recordNewFills(state, 0);
    await this.record(state);
    if (state.status === 'UNKNOWN') this.onAlert?.('error', 'ORDER_UNKNOWN', `Order ${req.clientOrderId} outcome unknown: ${state.rejectReason}`);
    if (state.status === 'REJECTED') log.warn({ coid: req.clientOrderId, reason: state.rejectReason }, 'order rejected');
    return state;
  }

  /** Poll until terminal or timeout; cancel any unfilled remainder at timeout. */
  async drive(o: OrderState, timeoutMs = 20_000, pollMs = 500): Promise<OrderState> {
    const venue = this.getVenue();
    const deadline = this.clock.now() + timeoutMs;
    let cur = o;
    while (!TERMINAL_ORDER_STATUSES.includes(cur.status) && this.clock.now() < deadline) {
      await this.clock.sleep(pollMs);
      const before = cur.fills.length;
      const prevStatus = cur.status;
      const prevFilled = cur.filledQty;
      try {
        cur = await venue.refresh(cur);
      } catch (e) {
        log.warn({ coid: cur.request.clientOrderId, err: (e as Error).message }, 'refresh failed');
        continue;
      }
      await this.recordNewFills(cur, before);
      if (cur.status !== prevStatus || cur.filledQty !== prevFilled) await this.record(cur);
    }
    if (!TERMINAL_ORDER_STATUSES.includes(cur.status)) {
      if (cur.status === 'UNKNOWN') {
        this.onAlert?.('critical', 'ORDER_UNRESOLVED', `Order ${cur.request.clientOrderId} unresolved after ${timeoutMs}ms - reconciliation required`);
        return cur;
      }
      try {
        const before = cur.fills.length;
        cur = await venue.cancel(cur);
        await this.recordNewFills(cur, before);
        await this.record(cur, 'timeout: remainder cancelled');
      } catch (e) {
        this.onAlert?.('error', 'CANCEL_FAILED', `Cancel failed for ${cur.request.clientOrderId}: ${(e as Error).message}`);
      }
    }
    return cur;
  }

  async execute(req: OrderRequest, timeoutMs?: number): Promise<OrderState> {
    const placed = await this.place(req);
    if (TERMINAL_ORDER_STATUSES.includes(placed.status)) return placed;
    return this.drive(placed, timeoutMs);
  }

  /** Re-drive all non-terminal orders (startup recovery / periodic). */
  async resolveOpen(): Promise<number> {
    const open = await this.repos.orders.listOpen(this.mode);
    for (const o of open) await this.drive(o, 5_000);
    return open.length;
  }
}
