/**
 * Signed trade flow. True OFI still needs sequenced L2 updates (see microstructure.ts).
 * Public CoinDCX trades often omit aggressor side; we then use Lee-Ready vs mid.
 * No tape in historical MarketView → all availability flags stay 0 (not invented).
 */
import { clamp } from '../lib/math.js';

export interface PublicTrade {
  ts: number;
  price: number;
  qty: number;
  side?: 'buy' | 'sell';
  isMaker?: boolean;
}

export interface OrderFlowFeatures {
  signedFlowAvail: number;
  /** Signed volume / total volume in the window, [-1, 1]. */
  signedFlow: number;
  vpinAvail: number;
  /** Volume-synchronised buy/sell imbalance in [0, 1]. High = toxic / one-sided. */
  vpin: number;
}

const empty: OrderFlowFeatures = { signedFlowAvail: 0, signedFlow: 0, vpinAvail: 0, vpin: 0 };

export function leeReadySide(price: number, mid: number, prevPrice?: number): 1 | -1 | 0 {
  if (!(price > 0) || !(mid > 0)) return 0;
  if (price > mid) return 1;
  if (price < mid) return -1;
  if (prevPrice && price > prevPrice) return 1;
  if (prevPrice && price < prevPrice) return -1;
  return 0;
}

function aggressor(t: PublicTrade, mid?: number, prev?: number): 1 | -1 | 0 {
  if (t.side === 'buy') return 1;
  if (t.side === 'sell') return -1;
  if (t.isMaker === true) return 0; // maker is the resting side; unknown aggressor without quote
  if (t.isMaker === false && mid) return leeReadySide(t.price, mid, prev);
  if (mid) return leeReadySide(t.price, mid, prev);
  return 0;
}

export function orderFlowFeatures(trades: PublicTrade[] | undefined, now: number, mid?: number, windowMs = 60_000): OrderFlowFeatures {
  if (!trades?.length) return empty;
  const from = now - windowMs;
  const w = trades.filter((t) => t.ts >= from && t.ts <= now && t.qty > 0 && t.price > 0);
  if (w.length < 8) return empty;
  let signed = 0;
  let vol = 0;
  let prev = w[0].price;
  for (const t of w) {
    const s = aggressor(t, mid, prev);
    prev = t.price;
    if (!s) continue;
    signed += s * t.qty;
    vol += t.qty;
  }
  if (!(vol > 0)) return empty;
  const of: OrderFlowFeatures = {
    signedFlowAvail: 1,
    signedFlow: clamp(signed / vol, -1, 1),
    vpinAvail: 0,
    vpin: 0,
  };
  const vpin = vpinOf(w, mid);
  if (vpin !== null) {
    of.vpinAvail = 1;
    of.vpin = vpin;
  }
  return of;
}

/** Equal-volume buckets; needs enough prints. Returns null if the tape is too thin. */
export function vpinOf(trades: PublicTrade[], mid?: number, buckets = 10): number | null {
  const total = trades.reduce((a, t) => a + t.qty, 0);
  if (!(total > 0) || trades.length < buckets * 4) return null;
  const vBucket = total / buckets;
  let buy = 0;
  let sell = 0;
  let acc = 0;
  let imb = 0;
  let n = 0;
  let prev = trades[0].price;
  for (const t of trades) {
    const s = aggressor(t, mid, prev);
    prev = t.price;
    if (s > 0) buy += t.qty;
    else if (s < 0) sell += t.qty;
    acc += t.qty;
    if (acc >= vBucket) {
      const d = buy + sell;
      if (d > 0) {
        imb += Math.abs(buy - sell) / d;
        n++;
      }
      buy = 0;
      sell = 0;
      acc = 0;
    }
  }
  return n >= Math.max(5, Math.floor(buckets / 2)) ? clamp(imb / n, 0, 1) : null;
}
