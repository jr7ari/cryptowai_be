import type { Candle, OptionChainSnapshot, Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';

/**
 * Read-only market view consumed by the decision pipeline. Implemented by the live market-data
 * service AND by the backtester, so the exact same decision code runs live, in paper and in backtests.
 */
export interface MarketView {
  now(): number;
  /** Only fully CLOSED candles (no look-ahead). */
  closedCandles(symbol: string, tf: Timeframe): Candle[];
  lastPrice(symbol: string): { price: number; ts: number } | null;
  topOfBook(symbol: string): { bid: number; ask: number; ts: number } | null;
  mark(symbol: string): { mark: number; fundingRate?: number; ts: number } | null;
  chain(symbol: string): OptionChainSnapshot | null;
  ivHistory(symbol: string): number[];
  oiHistory(symbol: string): Array<{ ts: number; oi: number }>;
  dataAgeMs(symbol: string): number;
  /** Latest REAL order-book levels (if the implementation has them). */
  orderBook?(symbol: string): import('../domain/types.js').OrderBook | null;
  /** Timestamped public prints if the live tape is subscribed. Historical views omit this. */
  recentTrades?(symbol: string): import('../signals/orderflow.js').PublicTrade[];
  /** Past-only funding prints (rates per interval). */
  fundingHistory?(symbol: string): number[];
  /** Past-only ln(last/mark) samples. */
  basisHistory?(symbol: string): number[];
}

export function closedOnly(candles: Candle[], tf: Timeframe, now: number): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  let end = candles.length;
  while (end > 0 && candles[end - 1].t + ms > now) end--;
  return end === candles.length ? candles : candles.slice(0, end);
}

/** Merge candles by open time (newer data wins), keep sorted, cap length. */
export function mergeCandles(existing: Candle[], incoming: Candle[], cap: number): Candle[] {
  if (!incoming.length) return existing;
  const m = new Map<number, Candle>();
  for (const c of existing) m.set(c.t, c);
  for (const c of incoming) m.set(c.t, c);
  const out = [...m.values()].sort((a, b) => a.t - b.t);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Aggregate lower-TF candles into a higher TF (aligned to epoch). */
export function aggregate(candles: Candle[], tf: Timeframe): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles) {
    const b = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

