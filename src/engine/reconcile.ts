/**
 * Mandatory position reconciliation between the local book and the exchange (LIVE).
 * Runs on startup, before arming LIVE, and periodically. Any unexplained difference blocks new
 * entries (kill switch RECONCILIATION) until an operator resolves it.
 */
import type { Repositories } from '../persistence/ports.js';
import type { ExecutionVenue } from '../execution/venue.js';
import type { OrderManager } from '../execution/order-manager.js';
import { positionExchange, type ExchangeId } from '../integrations/exchange.js';

export interface ReconcileReport {
  ts: number;
  ok: boolean;
  exchange: Array<{ instrument: string; qty: number; avgPrice: number }>;
  local: Array<{ instrument: string; qty: number }>;
  mismatches: Array<{ instrument: string; exchangeQty: number; localQty: number; diff: number }>;
  unresolvedOrders: number;
  balance?: { equity: number; cash: number; marginInUse: number };
  error?: string;
}

export async function reconcile(repos: Repositories, venue: ExecutionVenue, orders: OrderManager, now: number, tolerance = 1e-9, exchange: ExchangeId = 'coindcx'): Promise<ReconcileReport> {
  const rep: ReconcileReport = { ts: now, ok: false, exchange: [], local: [], mismatches: [], unresolvedOrders: 0 };
  try {
    // 1) drive any non-terminal orders to a known state first
    await orders.resolveOpen();
    rep.unresolvedOrders = (await repos.orders.listOpen('LIVE')).filter((o) => o.status === 'UNKNOWN').length;
    // 2) compare net positions per instrument
    const ex = await venue.positions();
    rep.exchange = ex.map((p) => ({ instrument: p.instrument, qty: p.qty, avgPrice: p.avgPrice }));
    const localMap = new Map<string, number>();
    for (const p of await repos.positions.listOpen('LIVE')) {
      if (positionExchange(p) !== exchange) continue; // parked on the other exchange
      for (const l of p.legs) {
        if (l.kind !== 'FUTURE') continue;
        const q = (l.side === 'BUY' ? 1 : -1) * (l.filledQty - (l.exitQty ?? 0));
        localMap.set(l.instrument, (localMap.get(l.instrument) ?? 0) + q);
      }
    }
    rep.local = [...localMap.entries()].map(([instrument, qty]) => ({ instrument, qty }));
    const instruments = new Set([...localMap.keys(), ...ex.map((p) => p.instrument)]);
    for (const i of instruments) {
      const e = ex.filter((p) => p.instrument === i).reduce((s, p) => s + p.qty, 0);
      const l = localMap.get(i) ?? 0;
      if (Math.abs(e - l) > tolerance) rep.mismatches.push({ instrument: i, exchangeQty: e, localQty: l, diff: e - l });
    }
    rep.balance = await venue.balances();
    rep.ok = rep.mismatches.length === 0 && rep.unresolvedOrders === 0;
  } catch (e) {
    rep.error = (e as Error).message;
    rep.ok = false;
  }
  return rep;
}
