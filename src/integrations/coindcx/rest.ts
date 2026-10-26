/**
 * CoinDCX REST client (futures + public market data).
 *
 * Authentication (verified, docs.coindcx.com "Authentication"): authenticated endpoints are POST with a
 * JSON body containing `timestamp` (ms); headers X-AUTH-APIKEY and X-AUTH-SIGNATURE where the signature
 * is hex(HMAC-SHA256(secret, JSON body)). The exact serialised body string that was signed is sent.
 *
 * Safety:
 *  - read-only calls are retried with backoff; order CREATE is NEVER blindly retried (ambiguous
 *    outcomes are resolved by the order manager via reconcile-before-retry)
 *  - token-bucket rate limiting + circuit breaker per client
 *  - secrets never logged (logger scrubs registered secrets)
 */
import { createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import type { Candle, OrderBook, Timeframe } from '../../domain/types.js';
import { ExchangeError, CapabilityUnavailableError } from '../../lib/errors.js';
import { RateLimiter, CircuitBreaker, withRetry } from '../../lib/resilience.js';
import { childLogger } from '../../lib/logger.js';
import type { CdxInstrument, CdxOrder, CdxPosition, CdxTrade, CdxWalletEntry } from './types.js';
import type { Clock } from '../../lib/clock.js';
import type { CreateOrderInput, FuturesExchangeClient } from '../exchange.js';
import { systemClock } from '../../lib/clock.js';

const log = childLogger('coindcx-rest');

export interface CoinDcxRestOptions {
  apiBaseUrl: string;
  publicBaseUrl: string;
  apiKey?: string;
  apiSecret?: string;
  timeoutMs: number;
  maxRequestsPerMinute: number;
  resolutionMap: Record<string, string>;
  marginCurrency: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

/** Paths verified in the official CoinDCX Futures API documentation. */
export const FUTURES_PATHS = {
  activeInstruments: '/exchange/v1/derivatives/futures/data/active_instruments',
  instrument: '/exchange/v1/derivatives/futures/data/instrument',
  tradesPublic: '/exchange/v1/derivatives/futures/data/trades',
  listOrders: '/exchange/v1/derivatives/futures/orders',
  createOrder: '/exchange/v1/derivatives/futures/orders/create',
  cancelOrder: '/exchange/v1/derivatives/futures/orders/cancel',
  listPositions: '/exchange/v1/derivatives/futures/positions',
  addMargin: '/exchange/v1/derivatives/futures/positions/add_margin',
  removeMargin: '/exchange/v1/derivatives/futures/positions/remove_margin',
  cancelAllOpenOrders: '/exchange/v1/derivatives/futures/positions/cancel_all_open_orders',
  cancelAllForPosition: '/exchange/v1/derivatives/futures/positions/cancel_all_open_orders_for_position',
  exitPosition: '/exchange/v1/derivatives/futures/positions/exit',
  createTpSl: '/exchange/v1/derivatives/futures/positions/create_tpsl',
  transactions: '/exchange/v1/derivatives/futures/positions/transactions',
  trades: '/exchange/v1/derivatives/futures/trades',
  // Listed in the docs' table of contents ("Wallet Details") but the path could not be verified
  // from the published page; overridable and probed by the LIVE readiness check.
  wallets: '/exchange/v1/derivatives/futures/wallets',
  candles: '/market_data/candlesticks',
  orderbook: (pair: string, depth: 10 | 20 | 50) => `/market_data/v3/orderbook/${pair}-futures/${depth}`,
} as const;

const num = z.coerce.number();
const CandlesResp = z.object({
  s: z.string().optional(),
  data: z.array(z.object({ open: num, high: num, low: num, close: num, volume: num, time: num })).default([]),
});
const OrderbookResp = z.object({
  ts: num.optional(),
  vs: num.optional(),
  asks: z.record(z.string(), num).default({}),
  bids: z.record(z.string(), num).default({}),
});

export function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export class CoinDcxRestClient implements FuturesExchangeClient {
  readonly exchange = 'coindcx' as const;
  private limiter: RateLimiter;
  readonly breaker: CircuitBreaker;
  private clock: Clock;
  private fetchImpl: typeof fetch;
  private customFetch: boolean;
  private instrumentCache = new Map<string, { at: number; inst: CdxInstrument }>();
  /** Per-endpoint call telemetry (for the dashboard's API health panel). */
  private calls = new Map<string, EndpointStats>();

  constructor(private readonly o: CoinDcxRestOptions) {
    this.clock = o.clock ?? systemClock;
    this.limiter = new RateLimiter(Math.max(5, Math.floor(o.maxRequestsPerMinute / 6)), o.maxRequestsPerMinute / 60, this.clock);
    this.breaker = new CircuitBreaker('coindcx', 5, 30_000, this.clock);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.customFetch = !!o.fetchImpl;
  }

  get authenticated(): boolean {
    return !!(this.o.apiKey && this.o.apiSecret);
  }

  // --------------------------------------------------------------- transport
  private async request<T>(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>, auth = false): Promise<T> {
    await this.limiter.acquire();
    const key = `${method} ${endpointKey(url)}`;
    const st = this.calls.get(key) ?? { endpoint: key, auth, count: 0, errors: 0, lastStatus: 0, lastAt: 0, lastLatencyMs: 0 };
    this.calls.set(key, st);
    const t0 = Date.now();
    try {
      const r = await this.requestInner<T>(method, url, body, auth);
      st.count++;
      st.lastStatus = 200;
      st.lastAt = Date.now();
      st.lastLatencyMs = Date.now() - t0;
      st.lastError = undefined;
      return r;
    } catch (e) {
      st.count++;
      st.errors++;
      st.lastAt = Date.now();
      st.lastLatencyMs = Date.now() - t0;
      st.lastStatus = e instanceof ExchangeError ? e.status ?? -1 : -1;
      st.lastError = (e as Error).message.slice(0, 200);
      throw e;
    }
  }

  /** Telemetry snapshot of every CoinDCX endpoint this client has called. */
  stats(): EndpointStats[] {
    return [...this.calls.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  }

  private async requestInner<T>(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>, auth = false): Promise<T> {
    return this.breaker.exec(async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      let payload: string | undefined;
      if (body) {
        payload = JSON.stringify(auth ? { ...body, timestamp: this.clock.now() } : body);
      }
      if (auth) {
        if (!this.o.apiKey || !this.o.apiSecret) throw new ExchangeError('API credentials not configured', 401, false);
        headers['X-AUTH-APIKEY'] = this.o.apiKey;
        headers['X-AUTH-SIGNATURE'] = sign(payload ?? '', this.o.apiSecret);
      }
      let res: { status: number; ok: boolean; text: () => Promise<string> };
      try {
        if (method === 'GET' && payload !== undefined && !this.customFetch) {
          // Some CoinDCX authenticated endpoints are GET with a signed JSON body; WHATWG fetch forbids
          // bodies on GET, so use node:http(s) directly for those.
          res = await rawRequest(url, method, headers, payload, this.o.timeoutMs);
        } else {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
          try {
            res = await this.fetchImpl(url, { method, headers, body: payload, signal: ctrl.signal });
          } finally {
            clearTimeout(timer);
          }
        }
      } catch (e) {
        const aborted = (e as Error).name === 'AbortError' || /timeout/i.test((e as Error).message);
        throw new ExchangeError(`network error ${method} ${redactUrl(url)}: ${aborted ? 'timeout' : (e as Error).message}`, undefined, true, {
          ambiguous: true,
        });
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const msg = (json as { message?: string })?.message ?? text.slice(0, 200);
        if (res.status === 429) log.warn({ url: redactUrl(url) }, 'rate limited by CoinDCX');
        throw new ExchangeError(`CoinDCX ${res.status} ${method} ${redactUrl(url)}: ${msg}`, res.status, retryable, json);
      }
      return json as T;
    });
  }

  private read<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      retries: 3,
      baseDelayMs: 300,
      maxDelayMs: 4000,
      clock: this.clock,
      onRetry: (a, e, d) => log.warn({ attempt: a, delayMs: d, err: (e as Error).message }, 'retrying read'),
    });
  }

  /** Margin-currency selector (USDT/INR margined futures). Set coindcx.margin-currency= (empty) to omit. */
  private mc = (): Record<string, unknown> => (this.o.marginCurrency ? { margin_currency_short_name: [this.o.marginCurrency] } : {});

  private api = (p: string) => `${this.o.apiBaseUrl}${p}`;
  private pub = (p: string) => `${this.o.publicBaseUrl}${p}`;

  // --------------------------------------------------------------- public market data
  async activeInstruments(): Promise<string[]> {
    const q = this.o.marginCurrency ? `?margin_currency_short_name[]=${encodeURIComponent(this.o.marginCurrency)}` : '';
    const r = await this.read(() => this.request<unknown>('GET', this.api(FUTURES_PATHS.activeInstruments) + q));
    return Array.isArray(r) ? (r as string[]) : [];
  }

  async instrument(pair: string, maxAgeMs = 3_600_000): Promise<CdxInstrument> {
    const cached = this.instrumentCache.get(pair);
    if (cached && this.clock.now() - cached.at < maxAgeMs) return cached.inst;
    const r = await this.read(() =>
      this.request<{ instrument: CdxInstrument }>(
        'GET',
        `${this.api(FUTURES_PATHS.instrument)}?pair=${encodeURIComponent(pair)}${
          this.o.marginCurrency ? `&margin_currency_short_name=${encodeURIComponent(this.o.marginCurrency)}` : ''
        }`,
      ),
    );
    const inst = r.instrument;
    if (!inst || !Number.isFinite(Number(inst.quantity_increment)) || !Number.isFinite(Number(inst.price_increment))) {
      throw new ExchangeError(`invalid instrument spec for ${pair}`, undefined, false, r);
    }
    const norm: CdxInstrument = {
      ...inst,
      price_increment: Number(inst.price_increment),
      quantity_increment: Number(inst.quantity_increment),
      min_quantity: Number(inst.min_quantity ?? inst.quantity_increment),
      max_quantity: inst.max_quantity !== undefined ? Number(inst.max_quantity) : undefined,
      min_notional: inst.min_notional !== undefined ? Number(inst.min_notional) : undefined,
      max_leverage_long: inst.max_leverage_long !== undefined ? Number(inst.max_leverage_long) : undefined,
      max_leverage_short: inst.max_leverage_short !== undefined ? Number(inst.max_leverage_short) : undefined,
    };
    this.instrumentCache.set(pair, { at: this.clock.now(), inst: norm });
    return norm;
  }

  async candles(pair: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]> {
    const resolution = this.o.resolutionMap[tf];
    if (!resolution) throw new ExchangeError(`no resolution mapping for ${tf}`, undefined, false);
    const url = `${this.pub(FUTURES_PATHS.candles)}?pair=${encodeURIComponent(pair)}&from=${Math.floor(fromMs / 1000)}&to=${Math.floor(
      toMs / 1000,
    )}&resolution=${encodeURIComponent(resolution)}&pcode=f`;
    const raw = await this.read(() => this.request<unknown>('GET', url));
    const parsed = CandlesResp.safeParse(raw);
    if (!parsed.success) throw new ExchangeError('unexpected candles payload', undefined, false, parsed.error.flatten());
    return parsed.data.data
      .map((d) => ({ t: d.time < 1e12 ? d.time * 1000 : d.time, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume }))
      .filter((c) => c.h >= c.l && c.o > 0 && c.c > 0)
      .sort((a, b) => a.t - b.t);
  }

  async orderbook(pair: string, depth: 10 | 20 | 50 = 50): Promise<OrderBook> {
    const raw = await this.read(() => this.request<unknown>('GET', this.pub(FUTURES_PATHS.orderbook(pair, depth))));
    const p = OrderbookResp.parse(raw);
    const lv = (m: Record<string, number>) =>
      Object.entries(m)
        .map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }))
        .filter((x) => x.qty > 0);
    return {
      instrument: pair,
      ts: p.ts ?? this.clock.now(),
      bids: lv(p.bids).sort((a, b) => b.price - a.price),
      asks: lv(p.asks).sort((a, b) => a.price - b.price),
    };
  }

  // --------------------------------------------------------------- authenticated (futures)
  /** Public recent trades for a futures pair. */
  async publicTrades(pair: string): Promise<Array<{ price: number; quantity: number; timestamp: number; is_maker: boolean }>> {
    const r = await this.read(() => this.request<unknown>('GET', `${this.api(FUTURES_PATHS.tradesPublic)}?pair=${encodeURIComponent(pair)}`));
    return Array.isArray(r) ? (r as Array<{ price: number; quantity: number; timestamp: number; is_maker: boolean }>).map((t) => ({ ...t, price: Number(t.price), quantity: Number(t.quantity) })) : [];
  }

  async listOrders(status: string, side?: 'buy' | 'sell', page = 1, size = 50): Promise<CdxOrder[]> {
    const body: Record<string, unknown> = { status, page: String(page), size: String(size), ...this.mc() };
    if (side) body.side = side;
    const r = await this.read(() => this.request<unknown>('POST', this.api(FUTURES_PATHS.listOrders), body, true));
    return Array.isArray(r) ? (r as CdxOrder[]) : [];
  }

  /** NOT retried here: an ambiguous failure is reported with details.ambiguous=true. */
  async createOrder(o: CreateOrderInput): Promise<CdxOrder[]> {
    const order: Record<string, unknown> = {
      side: o.side,
      pair: o.pair,
      order_type: o.order_type,
      total_quantity: o.total_quantity,
      leverage: o.leverage,
      notification: 'no_notification',
      hidden: false,
      post_only: false,
    };
    if (this.o.marginCurrency) order.margin_currency_short_name = this.o.marginCurrency;
    if (o.order_type === 'limit_order') {
      order.price = o.price;
      order.time_in_force = o.time_in_force ?? 'good_till_cancel';
    }
    if (o.client_order_id) order.client_order_id = o.client_order_id;
    const r = await this.request<unknown>('POST', this.api(FUTURES_PATHS.createOrder), { order }, true);
    return Array.isArray(r) ? (r as CdxOrder[]) : r && typeof r === 'object' && 'id' in (r as object) ? [r as CdxOrder] : [];
  }

  async cancelOrder(id: string): Promise<void> {
    await withRetry(() => this.request('POST', this.api(FUTURES_PATHS.cancelOrder), { id }, true), {
      retries: 2,
      baseDelayMs: 300,
      maxDelayMs: 2000,
      clock: this.clock,
    });
  }

  async listPositions(page = 1, size = 50): Promise<CdxPosition[]> {
    const r = await this.read(() =>
      this.request<unknown>('POST', this.api(FUTURES_PATHS.listPositions), { page: String(page), size: String(size), ...this.mc() }, true),
    );
    return Array.isArray(r) ? (r as CdxPosition[]) : [];
  }

  async exitPosition(positionId: string): Promise<{ group_id?: string }> {
    const r = await this.request<{ data?: { group_id?: string } }>('POST', this.api(FUTURES_PATHS.exitPosition), { id: positionId }, true);
    return r?.data ?? {};
  }

  async cancelAllOpenOrders(): Promise<void> {
    await this.request('POST', this.api(FUTURES_PATHS.cancelAllOpenOrders), { ...this.mc() }, true);
  }

  async createTpSl(positionId: string, tp?: { stopPrice: number; limitPrice?: number }, sl?: { stopPrice: number; limitPrice?: number }): Promise<unknown> {
    const body: Record<string, unknown> = { id: positionId };
    if (tp) body.take_profit = { stop_price: tp.stopPrice, limit_price: tp.limitPrice ?? tp.stopPrice, order_type: 'take_profit_market' };
    if (sl) body.stop_loss = { stop_price: sl.stopPrice, limit_price: sl.limitPrice ?? sl.stopPrice, order_type: 'stop_market' };
    return this.request('POST', this.api(FUTURES_PATHS.createTpSl), body, true);
  }

  async trades(params: { pair?: string; orderId?: string; fromDate?: string; toDate?: string; page?: number; size?: number }): Promise<CdxTrade[]> {
    const body: Record<string, unknown> = { page: String(params.page ?? 1), size: String(params.size ?? 50) };
    if (params.pair) body.pair = params.pair;
    if (params.orderId) body.order_id = params.orderId;
    if (params.fromDate) body.from_date = params.fromDate;
    if (params.toDate) body.to_date = params.toDate;
    const r = await this.read(() => this.request<unknown>('POST', this.api(FUTURES_PATHS.trades), body, true));
    return Array.isArray(r) ? (r as CdxTrade[]) : [];
  }

  /**
   * Futures wallet details. CoinDCX documents this as a signed request with a {timestamp} JSON body;
   * the HTTP method is configurable (default GET-with-body) and we fall back to POST on 404/405.
   */
  async wallets(path: string = FUTURES_PATHS.wallets, method: 'GET' | 'POST' = 'GET'): Promise<CdxWalletEntry[]> {
    const call = (m: 'GET' | 'POST') => this.read(() => this.request<unknown>(m, this.api(path), {}, true));
    let r: unknown;
    try {
      r = await call(method);
    } catch (e) {
      if (e instanceof ExchangeError && (e.status === 404 || e.status === 405)) r = await call(method === 'GET' ? 'POST' : 'GET');
      else throw e;
    }
    if (Array.isArray(r)) return r as CdxWalletEntry[];
    if (r && typeof r === 'object' && Array.isArray((r as { data?: unknown }).data)) return (r as { data: CdxWalletEntry[] }).data;
    throw new ExchangeError('unexpected wallet payload', undefined, false, r);
  }

  /** Public real-time futures prices (mark `mp`, last `ls`, optional funding `fr`). Path configurable. */
  async currentPrices(path = '/market_data/v3/current_prices/futures/rt'): Promise<Record<string, { mark?: number; last?: number; fundingRate?: number; change24h?: number; volume24h?: number }>> {
    const r = await this.read(() => this.request<{ prices?: Record<string, Record<string, unknown>> }>('GET', this.pub(path)));
    const out: Record<string, { mark?: number; last?: number; fundingRate?: number; change24h?: number; volume24h?: number }> = {};
    for (const [pair, v] of Object.entries(r?.prices ?? {})) {
      const n = (k: string) => (v[k] !== undefined && Number.isFinite(Number(v[k])) ? Number(v[k]) : undefined);
      out[pair] = { mark: n('mp'), last: n('ls'), fundingRate: n('fr') ?? n('efr'), change24h: n('pc'), volume24h: n('v') };
    }
    return out;
  }

  /** Options are NOT available via the documented CoinDCX API (verified 2026-10). */
  async optionsUnavailable(): Promise<never> {
    throw new CapabilityUnavailableError('CoinDCX options trading API');
  }
}

function rawRequest(url: string, method: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; ok: boolean; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = mod(
      u,
      { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, text: async () => text });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export interface EndpointStats {
  endpoint: string;
  auth: boolean;
  count: number;
  errors: number;
  lastStatus: number;
  lastAt: number;
  lastLatencyMs: number;
  lastError?: string;
}

/** Normalise a URL to a path template (pairs/ids removed) for telemetry. */
function endpointKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname.replace(/\/[A-Z]-[A-Z0-9]+_[A-Z0-9]+-futures\//, '/{pair}-futures/')}`;
  } catch {
    return u;
  }
}

function redactUrl(u: string): string {
  return u.replace(/(signature|apikey|key)=[^&]+/gi, '$1=[REDACTED]');
}
