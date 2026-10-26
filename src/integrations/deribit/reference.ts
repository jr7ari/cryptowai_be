/**
 * REAL options data from Deribit's PUBLIC API (no keys, read-only), used because
 * CoinDCX does not publish an options chain API. Provides real IV surface, skew, OI and volume for
 * regime features and for pricing PAPER/backtest option trades. Clearly tagged source=DERIBIT_REF.
 *
 * Endpoint (verified, docs.deribit.com): GET /api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option
 * Prices are quoted in the underlying coin; we convert to USD using `underlying_price`.
 */
import type { OptionChainSnapshot, OptionContract } from '../../domain/types.js';
import { computeChainMetrics } from '../../options/chain.js';
import { ExchangeError } from '../../lib/errors.js';
import { withRetry } from '../../lib/resilience.js';

interface BookSummary {
  instrument_name: string;
  bid_price: number | null;
  ask_price: number | null;
  mark_price: number;
  mark_iv?: number;
  underlying_price?: number;
  open_interest: number;
  volume: number;
  interest_rate?: number;
  creation_timestamp: number;
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** BTC-27DEC24-60000-C -> {expiry 08:00 UTC, strike, type} */
export function parseDeribitName(name: string): { underlying: string; expiry: number; strike: number; type: 'C' | 'P' } | null {
  const m = /^([A-Z]+)(?:_[A-Z]+)?-(\d{1,2})([A-Z]{3})(\d{2})-([\dd.]+)-([CP])$/.exec(name);
  if (!m) return null;
  const [, u, dd, mon, yy, strike, type] = m;
  if (MONTHS[mon] === undefined) return null;
  return {
    underlying: u,
    expiry: Date.UTC(2000 + Number(yy), MONTHS[mon], Number(dd), 8, 0, 0),
    strike: Number(strike.replace('d', '.')),
    type: type as 'C' | 'P',
  };
}

export class DeribitReference {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async chain(currency: string, now = Date.now()): Promise<OptionChainSnapshot> {
    const url = `${this.baseUrl}/public/get_book_summary_by_currency?currency=${encodeURIComponent(currency)}&kind=option`;
    const json = await withRetry(
      async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10_000);
        try {
          const r = await this.fetchImpl(url, { signal: ctrl.signal });
          if (!r.ok) throw new ExchangeError(`deribit ${r.status}`, r.status, r.status >= 500 || r.status === 429);
          return (await r.json()) as { result: BookSummary[] };
        } catch (e) {
          if (e instanceof ExchangeError) throw e;
          throw new ExchangeError(`deribit network: ${(e as Error).message}`, undefined, true);
        } finally {
          clearTimeout(t);
        }
      },
      { retries: 2, baseDelayMs: 500, maxDelayMs: 3000 },
    );
    const rows = json.result ?? [];
    let spot = 0;
    let rate = 0;
    const contracts: OptionContract[] = [];
    for (const b of rows) {
      const p = parseDeribitName(b.instrument_name);
      if (!p || p.expiry <= now) continue;
      const u = b.underlying_price ?? 0;
      if (u > 0) spot = spot || u;
      if (b.interest_rate !== undefined) rate = b.interest_rate;
      const toUsd = (x: number | null | undefined) => (x && x > 0 ? x * (u || spot) : 0);
      const mark = toUsd(b.mark_price);
      if (!(mark > 0) || !b.mark_iv) continue;
      const bid = toUsd(b.bid_price);
      const ask = toUsd(b.ask_price);
      // only contracts with a REAL two-sided market are usable; never invent bid/ask
      if (!(bid > 0) || !(ask > 0) || ask < bid) continue;
      contracts.push({
        symbol: b.instrument_name,
        underlying: p.underlying,
        strike: p.strike,
        expiry: p.expiry,
        type: p.type,
        bid,
        ask,
        mark,
        iv: b.mark_iv / 100,
        openInterest: b.open_interest,
        volume24h: b.volume,
        contractSize: 1,
        source: 'DERIBIT_REF',
      });
    }
    if (!contracts.length || !(spot > 0)) throw new ExchangeError(`empty deribit chain for ${currency}`, undefined, true);
    const expiries = [...new Set(contracts.map((c) => c.expiry))].sort((a, b) => a - b);
    const snap: OptionChainSnapshot = {
      underlying: currency,
      ts: now,
      spot,
      rate,
      contracts,
      expiries,
      source: 'DERIBIT_REF',
      metrics: { atmIv: NaN },
    };
    snap.metrics = computeChainMetrics(snap);
    return snap;
  }
}
