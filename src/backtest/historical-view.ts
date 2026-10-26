/**
 * MarketView over REAL historical data with a moving "now" cursor. Strictly no look-ahead:
 * closedCandles() only returns bars whose close time <= now, and option chains are the most recent
 * REAL snapshot recorded at or before `now` (recorded live from the Deribit public API). When no
 * recorded chain exists for a period, there is no chain and option strategies cannot trade there.
 */
import type { Candle, OptionChainSnapshot, Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import { type MarketView, aggregate } from '../marketdata/view.js';
import type { Clock } from '../lib/clock.js';

export interface HistoricalViewOptions {
  baseTf: Timeframe;
  timeframes: Timeframe[];
  historyBars: number;
  underlyingMap: Record<string, string>;
  /**
   * Futures half-spread as a fraction of price. Historical order books are not available from the
   * API, so this is an explicit COST ASSUMPTION (default 1 bp), not market data.
   */
  futuresHalfSpread: number;
  /** Funding per interval for paper futures in backtests - COST ASSUMPTION (historical funding is not stored). */
  fundingRate?: number;
  /** Real recorded option-chain snapshots per futures symbol (sorted by ts), if any. */
  chains?: Record<string, OptionChainSnapshot[]>;
  /** A recorded chain older than this is not used (ms). */
  maxChainAgeMs?: number;
  /** test hook: custom chain source (unit tests only) */
  chainProvider?: (symbol: string, now: number, view: HistoricalMarketView) => OptionChainSnapshot | null;
}

export class HistoricalMarketView implements MarketView {
  private data = new Map<string, Partial<Record<Timeframe, Candle[]>>>();
  private chainCache = new Map<string, { at: number; chain: OptionChainSnapshot | null }>();
  private ivHist = new Map<string, number[]>();

  constructor(private readonly o: HistoricalViewOptions, private readonly clock: Clock, base: Record<string, Candle[]>) {
    for (const [sym, candles] of Object.entries(base)) {
      const m: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of new Set([o.baseTf, ...o.timeframes])) {
        m[tf] = TIMEFRAME_MS[tf] === TIMEFRAME_MS[o.baseTf] ? candles : aggregate(candles, tf);
      }
      this.data.set(sym, m);
      this.ivHist.set(sym, []);
    }
  }

  symbols(): string[] {
    return [...this.data.keys()];
  }

  baseCandles(sym: string): Candle[] {
    return this.data.get(sym)?.[this.o.baseTf] ?? [];
  }

  now(): number {
    return this.clock.now();
  }

  /** binary search: number of bars with close time <= now */
  private closedCount(arr: Candle[], tf: Timeframe): number {
    const ms = TIMEFRAME_MS[tf];
    const now = this.clock.now();
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t + ms <= now) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  closedCandles(symbol: string, tf: Timeframe): Candle[] {
    const arr = this.data.get(symbol)?.[tf] ?? [];
    const n = this.closedCount(arr, tf);
    return arr.slice(Math.max(0, n - this.o.historyBars), n);
  }

  lastPrice(symbol: string) {
    const arr = this.data.get(symbol)?.[this.o.baseTf] ?? [];
    const n = this.closedCount(arr, this.o.baseTf);
    if (!n) return null;
    const ov = this.execOverride.get(symbol);
    return { price: ov ?? arr[n - 1].c, ts: arr[n - 1].t + TIMEFRAME_MS[this.o.baseTf] };
  }

  /** Last CLOSED base-timeframe bar (for intrabar stop/target detection in backtests). */
  lastBar(symbol: string): Candle | null {
    const arr = this.data.get(symbol)?.[this.o.baseTf] ?? [];
    const n = this.closedCount(arr, this.o.baseTf);
    return n ? arr[n - 1] : null;
  }

  private execOverride = new Map<string, number>();
  /**
   * Run fn while fills reference `price` instead of the bar close: models a resting stop/target order
   * that triggered inside the bar (or at the open after a gap). Spread, slippage and fees still apply.
   */
  async withExecPrice<T>(symbol: string, price: number, fn: () => Promise<T>): Promise<T> {
    this.execOverride.set(symbol, price);
    try {
      return await fn();
    } finally {
      this.execOverride.delete(symbol);
    }
  }

  topOfBook(symbol: string) {
    const p = this.lastPrice(symbol);
    if (!p) return null;
    const h = p.price * this.o.futuresHalfSpread;
    return { bid: p.price - h, ask: p.price + h, ts: p.ts };
  }

  mark(symbol: string) {
    const p = this.lastPrice(symbol);
    return p ? { mark: p.price, fundingRate: this.o.fundingRate, ts: p.ts } : null;
  }

  chain(symbol: string): OptionChainSnapshot | null {
    const now = this.clock.now();
    const c = this.chainCache.get(symbol);
    if (c && c.at === now) return c.chain;
    let chain: OptionChainSnapshot | null = null;
    if (this.o.chainProvider) chain = this.o.chainProvider(symbol, now, this);
    else {
      const list = this.o.chains?.[symbol];
      if (list?.length) {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].ts <= now) lo = mid + 1;
          else hi = mid;
        }
        const snap = lo ? list[lo - 1] : null;
        if (snap && now - snap.ts <= (this.o.maxChainAgeMs ?? 30 * 60_000)) chain = snap;
      }
    }
    this.chainCache.set(symbol, { at: now, chain });
    if (chain && Number.isFinite(chain.metrics.atmIv)) {
      const h = this.ivHist.get(symbol)!;
      if (!h.length || h[h.length - 1] !== chain.metrics.atmIv) h.push(chain.metrics.atmIv);
      if (h.length > 3000) h.splice(0, h.length - 3000);
    }
    return chain;
  }

  ivHistory(symbol: string): number[] {
    return this.ivHist.get(symbol) ?? [];
  }
  oiHistory(): Array<{ ts: number; oi: number }> {
    return [];
  }
  dataAgeMs(): number {
    return 0;
  }
}
