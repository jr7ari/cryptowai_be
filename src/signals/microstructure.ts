/**
 * Live-only book features. Historical CoinDCX order-book/trade tapes are not stored, so these
 * MUST be marked unavailable in backtests (no look-ahead, no invented L2).
 *
 *  - microprice: size-weighted mid (queue-aware fair value)
 *  - bookImbalance: top-of-book (bidQty - askQty) / (bidQty + askQty)
 *  - ofi: NOT computed from a single snapshot; true OFI needs timestamped book updates
 */
import type { OrderBook } from '../domain/types.js';

export interface MicrostructureFeatures {
  /** 1 if a two-sided book with size was present at decision time. */
  bookImbalanceAvail: number;
  bookImbalance: number;
  microprice: number;
  micropriceDislocationBps: number;
  /** Always 0 unless a sequenced L2 stream is wired; kept so callers do not treat a snapshot as OFI. */
  ofiAvail: number;
  ofi: number;
}

const empty: MicrostructureFeatures = {
  bookImbalanceAvail: 0,
  bookImbalance: 0,
  microprice: 0,
  micropriceDislocationBps: 0,
  ofiAvail: 0,
  ofi: 0,
};

export function microstructureFromBook(book: OrderBook | null | undefined, lastPrice?: number): MicrostructureFeatures {
  if (!book?.bids?.length || !book.asks?.length) return empty;
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!(bid.price > 0 && ask.price > 0 && ask.price >= bid.price && bid.qty > 0 && ask.qty > 0)) return empty;
  const den = bid.qty + ask.qty;
  const imb = (bid.qty - ask.qty) / den;
  const micro = (ask.price * bid.qty + bid.price * ask.qty) / den;
  const ref = lastPrice && lastPrice > 0 ? lastPrice : (bid.price + ask.price) / 2;
  const disBps = ref > 0 ? ((micro - ref) / ref) * 10_000 : 0;
  return {
    bookImbalanceAvail: 1,
    bookImbalance: imb,
    microprice: micro,
    micropriceDislocationBps: disBps,
    ofiAvail: 0,
    ofi: 0,
  };
}
