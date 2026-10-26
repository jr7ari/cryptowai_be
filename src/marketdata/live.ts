/**
 * Real-time market-data pipeline:
 *  - Candles: DB warm start -> REST backfill -> periodic REST refresh (source of truth), persisted.
 *  - Prices: CoinDCX socket ticks (LTP + mark/funding), REST order-book fallback when the socket is stale.
 *  - Options: REAL Deribit public options chain (bid/ask/mark/IV/OI exactly as quoted). If it is
 *    unavailable there is NO chain and option strategies are simply not tradable (never synthetic)
 *    surface from realized vol; snapshots persisted for IV-rank history.
 *  - Staleness tracked per symbol; the risk engine refuses entries on stale data.
 */
import { EventEmitter } from 'node:events';
import type { Candle, OptionChainSnapshot, Timeframe, OrderBook } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import type { Repositories } from '../persistence/ports.js';
import type { FuturesExchangeClient } from '../integrations/exchange.js';
import type { PriceTick, MarkTick, TradeTick } from '../integrations/coindcx/socket.js';

/** Optional streaming source. Without one, prices come from REST polling. */
export interface MarketSocket {
  on(e: 'price', l: (t: PriceTick) => void): unknown;
  on(e: 'mark', l: (t: MarkTick) => void): unknown;
  on(e: 'trade', l: (t: TradeTick) => void): unknown;
  on(e: 'book', l: (t: OrderBook) => void): unknown;
  connect(): Promise<void>;
  close(): void;
  connected: boolean;
  lastMessageAt: number;
}
import type { PublicTrade } from '../signals/orderflow.js';
import type { DeribitReference } from '../integrations/deribit/reference.js';
import { type MarketView, closedOnly, mergeCandles } from './view.js';
import { childLogger } from '../lib/logger.js';
import type { Clock } from '../lib/clock.js';
import { MS } from '../lib/clock.js';

const log = childLogger('marketdata');

export interface LiveMarketDataOptions {
  symbols: string[];
  timeframes: Timeframe[];
  decisionTf: Timeframe;
  historyBars: number;
  underlyingMap: Record<string, string>;
  referenceEnabled: boolean;
  referenceRefreshSec: number;
  /** persist a (trimmed) real chain snapshot at most every N ms - used for IV history & backtest replay */
  persistChainEveryMs: number;
  currentPricesPath?: string;
}

interface SymState {
  candles: Partial<Record<Timeframe, Candle[]>>;
  price?: { price: number; ts: number };
  tob?: { bid: number; ask: number; ts: number };
  mark?: { mark: number; fundingRate?: number; ts: number };
  chain?: OptionChainSnapshot;
  chainRefreshedAt: number;
  chainPersistedAt: number;
  ivHistory: number[];
  oi: Array<{ ts: number; oi: number }>;
  lastBarT: number;
  stats?: { change24h?: number; volume24h?: number; ts: number };
  book?: OrderBook;
  trades: PublicTrade[];
  fundingHist: number[];
  basisHist: number[];
}

export class LiveMarketData extends EventEmitter implements MarketView {
  private s = new Map<string, SymState>();
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly o: LiveMarketDataOptions,
    private readonly rest: FuturesExchangeClient,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly socket?: MarketSocket,
    private readonly deribit?: DeribitReference,
  ) {
    super();
    for (const sym of o.symbols) this.s.set(sym, { candles: {}, chainRefreshedAt: 0, chainPersistedAt: 0, ivHistory: [], oi: [], lastBarT: 0, trades: [], fundingHist: [], basisHist: [] });
  }

  now() {
    return this.clock.now();
  }

  private st(sym: string): SymState {
    const x = this.s.get(sym);
    if (!x) throw new Error(`unknown symbol ${sym}`);
    return x;
  }

  async start(): Promise<void> {
    this.running = true;
    for (const sym of this.o.symbols) {
      for (const tf of this.o.timeframes) await this.backfill(sym, tf);
      const hist = await this.repos.chains.metricsHistory(this.o.underlyingMap[sym] ?? sym, this.clock.now() - 90 * MS.d);
      this.st(sym).ivHistory = hist.map((h) => h.atmIv).filter(Number.isFinite);
      await this.refreshTopOfBook(sym).catch((e) => log.warn({ sym, err: (e as Error).message }, 'orderbook fetch failed'));
      await this.refreshChain(sym).catch((e) => log.warn({ sym, err: (e as Error).message }, 'chain refresh failed'));
    }
    if (this.socket) {
      this.socket.on('price', (t) => {
        const x = this.s.get(t.pair);
        if (x) x.price = { price: t.price, ts: Math.min(t.ts, this.clock.now()) };
      });
      this.socket.on('mark', (t) => {
        const x = this.s.get(t.pair);
        if (!x) return;
        const mark = t.mark > 0 ? t.mark : x.mark?.mark;
        if (mark === undefined && t.fundingRate === undefined) return;
        x.mark = { mark: mark ?? x.mark?.mark ?? 0, fundingRate: t.fundingRate ?? x.mark?.fundingRate, ts: this.clock.now() };
      });
      this.socket.on('trade', (t) => {
        const x = this.s.get(t.pair);
        if (!x) return;
        x.trades.push({ ts: t.ts, price: t.price, qty: t.qty, side: t.side, isMaker: t.isMaker });
        if (x.trades.length > 2000) x.trades.splice(0, x.trades.length - 2000);
      });
      this.socket.on('book', (ob) => {
        const x = this.s.get(ob.instrument);
        if (!x) return;
        const bid = ob.bids[0]?.price;
        const ask = ob.asks[0]?.price;
        if (bid && ask && ask >= bid) x.tob = { bid, ask, ts: ob.ts };
        // 1-level L1 must not wipe a deeper L2 book used for paper fills
        if (!x.book || ob.bids.length > 1 || ob.asks.length > 1) x.book = ob;
      });
      await this.socket.connect().catch((e) => log.error({ err: (e as Error).message }, 'socket connect failed; REST fallback only'));
    }
    this.loop(() => this.refreshCandles(), 20_000);
    this.loop(() => this.refreshTopsIfStale(), 5_000);
    this.loop(() => this.refreshCurrentPrices(), 10_000);
    this.loop(() => this.refreshPublicTrades(), 15_000);
    this.loop(() => this.refreshChains(), Math.max(15, this.o.referenceRefreshSec) * 1000);
  }

  stop(): void {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.socket?.close();
  }

  private loop(fn: () => Promise<void>, ms: number) {
    let busy = false;
    const t = setInterval(async () => {
      if (!this.running || busy) return;
      busy = true;
      try {
        await fn();
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'market data loop error');
      } finally {
        busy = false;
      }
    }, ms);
    this.timers.push(t);
  }

  private async backfill(sym: string, tf: Timeframe) {
    const ms = TIMEFRAME_MS[tf];
    const now = this.clock.now();
    let candles = await this.repos.candles.latest(sym, tf, this.o.historyBars);
    const from = candles.length ? candles[candles.length - 1].t - ms * 2 : now - ms * this.o.historyBars;
    try {
      // page in chunks to respect API limits
      const chunk = ms * 500;
      for (let start = from; start < now; start += chunk) {
        const got = await this.rest.candles(sym, tf, start, Math.min(now, start + chunk));
        candles = mergeCandles(candles, got, this.o.historyBars + 50);
        await this.repos.candles.upsertMany(sym, tf, closedOnly(got, tf, now));
      }
    } catch (e) {
      log.warn({ sym, tf, err: (e as Error).message }, 'candle backfill failed');
    }
    this.st(sym).candles[tf] = candles;
    const last = candles[candles.length - 1];
    if (last) this.updatePriceFromCandle(sym, last);
    log.info({ sym, tf, bars: candles.length }, 'candles ready');
  }

  private updatePriceFromCandle(sym: string, c: Candle) {
    const x = this.st(sym);
    const ts = Math.min(this.clock.now(), c.t + TIMEFRAME_MS['1m']);
    if (!x.price || x.price.ts < ts) x.price = { price: c.c, ts };
  }

  async refreshCandles(): Promise<void> {
    const now = this.clock.now();
    for (const sym of this.o.symbols) {
      for (const tf of this.o.timeframes) {
        const ms = TIMEFRAME_MS[tf];
        const got = await this.rest.candles(sym, tf, now - ms * 5, now);
        const x = this.st(sym);
        x.candles[tf] = mergeCandles(x.candles[tf] ?? [], got, this.o.historyBars + 50);
        await this.repos.candles.upsertMany(sym, tf, closedOnly(got, tf, now));
        if (tf === this.o.decisionTf) {
          const closed = closedOnly(x.candles[tf]!, tf, now);
          const lastClosed = closed[closed.length - 1];
          if (lastClosed && lastClosed.t > x.lastBarT) {
            x.lastBarT = lastClosed.t;
            this.emit('bar', { symbol: sym, tf, candle: lastClosed });
          }
        }
      }
    }
  }

  private async refreshTopOfBook(sym: string) {
    const ob = await this.rest.orderbook(sym, 50);
    this.st(sym).book = ob;
    const bid = ob.bids[0]?.price;
    const ask = ob.asks[0]?.price;
    if (bid && ask && ask >= bid) {
      const x = this.st(sym);
      x.tob = { bid, ask, ts: this.clock.now() };
      const mid = (bid + ask) / 2;
      if (!x.price || this.clock.now() - x.price.ts > 10_000) x.price = { price: mid, ts: this.clock.now() };
    }
  }

  private async refreshTopsIfStale() {
    for (const sym of this.o.symbols) {
      const x = this.st(sym);
      if (!x.tob || this.clock.now() - x.tob.ts > 4_000) await this.refreshTopOfBook(sym).catch(() => undefined);
    }
  }

  /** REST fallback/augmentation for mark price, funding rate and 24h stats. */
  private async refreshCurrentPrices() {
    const all = await this.rest.currentPrices(this.o.currentPricesPath);
    const now = this.clock.now();
    for (const sym of this.o.symbols) {
      const v = all[sym];
      if (!v) continue;
      const x = this.st(sym);
      if (v.mark !== undefined) x.mark = { mark: v.mark, fundingRate: v.fundingRate ?? x.mark?.fundingRate, ts: now };
      if (v.last !== undefined && (!x.price || now - x.price.ts > 10_000)) x.price = { price: v.last, ts: now };
      x.stats = { change24h: v.change24h, volume24h: v.volume24h, ts: now };
      if (v.fundingRate !== undefined && Number.isFinite(v.fundingRate)) {
        x.fundingHist.push(v.fundingRate);
        if (x.fundingHist.length > 500) x.fundingHist.splice(0, x.fundingHist.length - 500);
      }
      const last = x.price?.price;
      const mk = x.mark?.mark;
      if (last && mk && last > 0 && mk > 0 && Math.abs(Math.log(last / mk)) > 1e-8) {
        x.basisHist.push(Math.log(last / mk));
        if (x.basisHist.length > 500) x.basisHist.splice(0, x.basisHist.length - 500);
      }
    }
  }

  private async refreshPublicTrades() {
    for (const sym of this.o.symbols) {
      try {
        const raw = await this.rest.publicTrades(sym);
        const x = this.st(sym);
        for (const t of raw) {
          const ts = t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp;
          if (!x.trades.some((p) => p.ts === ts && p.price === t.price && p.qty === t.quantity)) {
            x.trades.push({ ts, price: t.price, qty: t.quantity, isMaker: t.is_maker });
          }
        }
        x.trades.sort((a, b) => a.ts - b.ts);
        if (x.trades.length > 2000) x.trades.splice(0, x.trades.length - 2000);
      } catch {
        /* public tape is optional; features stay unavailable */
      }
    }
  }

  recentTrades(symbol: string): PublicTrade[] {
    return this.st(symbol).trades;
  }
  fundingHistory(symbol: string): number[] {
    return this.st(symbol).fundingHist;
  }
  basisHistory(symbol: string): number[] {
    return this.st(symbol).basisHist;
  }

  orderBook(symbol: string): OrderBook | null {
    const b = this.s.get(symbol)?.book;
    return b && this.clock.now() - b.ts < 30_000 ? b : null;
  }

  stats(symbol: string) {
    return this.st(symbol).stats ?? null;
  }

  private async refreshChains() {
    for (const sym of this.o.symbols) await this.refreshChain(sym);
  }

  private async refreshChain(sym: string) {
    const x = this.st(sym);
    const u = this.o.underlyingMap[sym] ?? sym;
    if (!this.o.referenceEnabled || !this.deribit) return;
    let chain: OptionChainSnapshot;
    try {
      chain = await this.deribit.chain(u, this.clock.now());
    } catch (e) {
      // keep the last real chain only while it is fresh; otherwise options become untradable
      if (x.chain && this.clock.now() - x.chain.ts > 10 * MS.m) x.chain = undefined;
      log.warn({ u, err: (e as Error).message }, 'options chain unavailable: option strategies disabled until it recovers');
      return;
    }
    x.chain = chain;
    x.chainRefreshedAt = this.clock.now();
    if (Number.isFinite(chain.metrics.atmIv)) {
      x.ivHistory.push(chain.metrics.atmIv);
      if (x.ivHistory.length > 5000) x.ivHistory.splice(0, x.ivHistory.length - 5000);
    }
    if (chain.metrics.totalOpenInterest) x.oi.push({ ts: chain.ts, oi: chain.metrics.totalOpenInterest });
    if (x.oi.length > 2000) x.oi.splice(0, x.oi.length - 2000);
    if (this.clock.now() - x.chainPersistedAt >= this.o.persistChainEveryMs) {
      x.chainPersistedAt = this.clock.now();
      await this.repos.chains.insert(trimChain(chain)).catch((e) => log.warn({ err: (e as Error).message }, 'chain snapshot persist failed'));
    }
  }

  // ---------------------------------------------------------------- MarketView
  // Read accessors return "no data" for symbols this exchange does not stream (e.g. a position that
  // was opened on the other exchange): never throw from the monitoring path.
  closedCandles(symbol: string, tf: Timeframe): Candle[] {
    const x = this.s.get(symbol);
    return x ? closedOnly(x.candles[tf] ?? [], tf, this.clock.now()) : [];
  }
  lastPrice(symbol: string) {
    return this.s.get(symbol)?.price ?? null;
  }
  topOfBook(symbol: string) {
    return this.s.get(symbol)?.tob ?? null;
  }
  mark(symbol: string) {
    return this.s.get(symbol)?.mark ?? null;
  }
  chain(symbol: string): OptionChainSnapshot | null {
    const x = this.s.get(symbol);
    if (!x) return null;
    if (!x.chain || this.clock.now() - x.chain.ts > 10 * MS.m) return null; // stale chain = no options
    return x.chain;
  }
  ivHistory(symbol: string) {
    return this.st(symbol).ivHistory;
  }
  oiHistory(symbol: string) {
    return this.st(symbol).oi;
  }
  dataAgeMs(symbol: string): number {
    const p = this.s.get(symbol)?.price;
    return p ? Math.max(0, this.clock.now() - p.ts) : Number.POSITIVE_INFINITY;
  }
  socketStatus() {
    if (!this.socket) return { transport: 'rest' as const, connected: false, lastMessageAt: 0 };
    return { transport: 'stream' as const, connected: this.socket.connected, lastMessageAt: this.socket.lastMessageAt ?? 0 };
  }
}

/**
 * Keep only contracts that matter for trading/backtests (<= 60 days, strikes within +/-40% of spot) to
 * bound storage; quotes are stored exactly as received.
 */
export function trimChain(c: OptionChainSnapshot): OptionChainSnapshot {
  const maxExp = c.ts + 60 * MS.d;
  const contracts = c.contracts.filter((k) => k.expiry <= maxExp && k.strike >= c.spot * 0.6 && k.strike <= c.spot * 1.4);
  return { ...c, contracts, expiries: c.expiries.filter((e) => e <= maxExp) };
}
