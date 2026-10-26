import type { MarketView } from '../marketdata/view.js';
import type { Clock } from '../lib/clock.js';

export interface Quote {
  bid: number;
  ask: number;
  mark: number;
  spot: number;
}

/** Parses option symbols produced by optionSymbol()/Deribit: UNDERLYING-DMMMYY-STRIKE-C|P */
export function parseOptionSymbol(sym: string): { expiry: number; strike: number; type: 'C' | 'P' } | null {
  const m = /-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/.exec(sym);
  if (!m) return null;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const mo = months.indexOf(m[2]);
  if (mo < 0) return null;
  return { expiry: Date.UTC(2000 + Number(m[3]), mo, Number(m[1]), 8), strike: Number(m[4]), type: m[5] as 'C' | 'P' };
}

/**
 * Executable quotes from REAL market data only (CoinDCX order book for futures, Deribit book for
 * options). Never interpolates or invents a price: if no real quote exists, returns null and the
 * caller does not trade (or marks with the last real quote seen within `maxQuoteAgeMs`).
 */
export class MarketQuoter {
  private lastOption = new Map<string, { q: Quote; ts: number }>();
  constructor(
    private readonly market: MarketView,
    private readonly clock: Clock,
    readonly underlyingOf: (instrument: string) => string,
    private readonly maxQuoteAgeMs = 15 * 60_000,
  ) {}

  quote(instrument: string, kind: 'OPTION' | 'FUTURE'): Quote | null {
    const pair = this.underlyingOf(instrument);
    const last = this.market.lastPrice(pair);
    if (kind === 'FUTURE') {
      const tob = this.market.topOfBook(pair);
      if (!tob || !(tob.ask >= tob.bid) || !(tob.bid > 0)) return null;
      return { bid: tob.bid, ask: tob.ask, mark: (tob.bid + tob.ask) / 2, spot: last?.price ?? (tob.bid + tob.ask) / 2 };
    }
    const now = this.clock.now();
    const p = parseOptionSymbol(instrument);
    const chain = this.market.chain(pair);
    if (p && p.expiry <= now) {
      // cash settlement at intrinsic vs the option venue's underlying (real index from the chain)
      const settle = chain?.spot ?? last?.price;
      if (!settle) return null;
      const intrinsic = Math.max(0, p.type === 'C' ? settle - p.strike : p.strike - settle);
      return { bid: intrinsic, ask: intrinsic, mark: intrinsic, spot: settle };
    }
    const c = chain?.contracts.find((x) => x.symbol === instrument);
    if (c && chain) {
      const q = { bid: c.bid, ask: c.ask, mark: c.mark, spot: chain.spot };
      this.lastOption.set(instrument, { q, ts: now });
      return q;
    }
    const cached = this.lastOption.get(instrument);
    return cached && now - cached.ts <= this.maxQuoteAgeMs ? cached.q : null;
  }
}
