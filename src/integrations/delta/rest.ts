/**
 * Delta Exchange REST client (perpetual futures + public market data), implementing the
 * exchange-neutral FuturesExchangeClient port.
 *
 * Verified against Delta's official python client (delta-rest-client 1.0.14, PyPI) and the API docs
 * (docs.delta.exchange, "Kickstarting your trading journey with Delta India APIs"):
 *  - base URLs: India https://api.india.delta.exchange (default), India testnet
 *    https://cdn-ind.testnet.deltaex.org, Global https://api.delta.exchange. Keys are per environment.
 *  - auth headers: api-key, timestamp (unix SECONDS), signature, User-Agent, Content-Type: application/json
 *  - signature = hex(HMAC-SHA256(secret, METHOD + timestamp + path + query + body)), where query is
 *    '?k=v&...' (values quote_plus-encoded, '' when absent) and body is compact JSON ('' when absent).
 *    Signatures expire after ~5 seconds.
 *  - envelope: { success: true, result } | { success: false, error }
 *  - orders/orderbook/positions sizes are integer CONTRACTS; contract_value converts to the underlying.
 *  - ticker funding_rate is in PERCENT per funding interval (ccxt divides by 100).
 *
 * Every quantity this client returns or accepts is in UNDERLYING units (see integrations/exchange.ts).
 */
import { createHmac } from 'node:crypto';
import type { Candle, OrderBook, Timeframe } from '../../domain/types.js';
import { ExchangeError } from '../../lib/errors.js';
import { RateLimiter, CircuitBreaker, withRetry } from '../../lib/resilience.js';
import { childLogger } from '../../lib/logger.js';
import type { Clock } from '../../lib/clock.js';
import { systemClock } from '../../lib/clock.js';
import type { CdxInstrument, CdxOrder, CdxPosition, CdxTrade, CdxWalletEntry } from '../coindcx/types.js';
import type { EndpointStats } from '../coindcx/rest.js';
import type { CreateOrderInput, CurrentPrice, FuturesExchangeClient, PublicTradeRow } from '../exchange.js';

const log = childLogger('delta-rest');

export const DELTA_URLS = {
  india: 'https://api.india.delta.exchange',
  indiaTestnet: 'https://cdn-ind.testnet.deltaex.org',
  global: 'https://api.delta.exchange',
} as const;

/** Public market-data websocket (new compact channels: ticker, ob_l1, ob_l2, trades). */
export const DELTA_WS = {
  india: 'wss://public-socket.india.delta.exchange',
  indiaTestnet: 'wss://socket-ind-pub.testnet.deltaex.org',
  global: 'wss://socket.delta.exchange',
} as const;

export interface DeltaRestOptions {
  baseUrl: string;
  apiKey?: string;
  apiSecret?: string;
  timeoutMs: number;
  maxRequestsPerMinute: number;
  /** settling asset of the wallet used for margin (Delta India: USD) */
  marginCurrency: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

interface DeltaProduct {
  id: number;
  symbol: string;
  contract_value: string | number;
  tick_size: string | number;
  state?: string;
  trading_status?: string;
  contract_type?: string;
  initial_margin?: string | number;
  default_leverage?: string | number;
  position_size_limit?: number;
  settling_asset?: { symbol?: string };
  quoting_asset?: { symbol?: string };
  underlying_asset?: { symbol?: string };
}

export interface DeltaOrder {
  id: number | string;
  product_id?: number;
  product_symbol?: string;
  side: 'buy' | 'sell';
  size: number;
  unfilled_size?: number;
  state: string;
  order_type?: string;
  limit_price?: string | null;
  average_fill_price?: string | null;
  paid_commission?: string | null;
  client_order_id?: string | null;
  created_at?: string | number;
  reduce_only?: boolean | string;
}

/** Python client's query_string(): '?k=v&k2=v2' with quote_plus values, '' when no params. */
export function deltaQuery(q?: Record<string, string | number | undefined>): string {
  if (!q) return '';
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function deltaSignature(secret: string, method: string, timestampSec: string, path: string, query: string, body: string): string {
  return createHmac('sha256', secret).update(method + timestampSec + path + query + body).digest('hex');
}

/** Delta list endpoints return `result: T[]`; a few wrap the array in a named field. */
export function deltaRows(raw: unknown, keys: string[] = ['orders', 'positions', 'fills', 'trades', 'balances']): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/** Human-readable Delta error (IP whitelist, wrong environment, clock skew). */
export function deltaErrorMessage(json: { error?: unknown; message?: unknown }, fallback: string): string {
  const e = json.error;
  const obj = e && typeof e === 'object' ? (e as { code?: unknown; context?: Record<string, unknown>; message?: unknown }) : undefined;
  const code = String(obj?.code ?? (typeof e === 'string' ? e : json.message ?? '')).trim();
  const ip = obj?.context && (obj.context.client_ip ?? obj.context.ip);
  if (code === 'ip_not_whitelisted_for_api_key') {
    return `Delta API key IP whitelist rejected this machine${ip ? ` (${ip})` : ''}. On india.delta.exchange go to Account → API Keys, add that IP, then retry.`;
  }
  if (code === 'invalid_api_key') {
    return 'Delta rejected the API key (deleted, regenerated, or wrong environment). India keys only work with api.india.delta.exchange.';
  }
  if (code === 'SignatureExpired' || code === 'invalid_signature') {
    return `Delta ${code}: signatures last ~5s — sync the PC clock (Windows Time service) and retry.`;
  }
  if (obj) return JSON.stringify(e);
  if (typeof e === 'string' && e) return e;
  return fallback;
}

const num = (x: unknown): number => (x === null || x === undefined || x === '' ? NaN : Number(x));
const tsToMs = (t: unknown): number | undefined => {
  if (t === null || t === undefined) return undefined;
  if (typeof t === 'string' && t.includes('-')) return Date.parse(t);
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  if (n > 1e15) return Math.floor(n / 1000); // microseconds
  if (n > 1e12) return n; // ms
  return n * 1000; // seconds
};

/** Delta order state -> the CoinDCX status vocabulary the venue already maps. */
export function deltaStatus(o: Pick<DeltaOrder, 'state' | 'size' | 'unfilled_size'>): string {
  const filled = Number(o.size) - Number(o.unfilled_size ?? o.size);
  switch (o.state) {
    case 'open':
    case 'pending':
      return filled > 0 ? 'partially_filled' : 'open';
    case 'closed':
      return 'filled';
    case 'cancelled':
      return filled > 0 ? 'partially_cancelled' : 'cancelled';
    default:
      return o.state ?? 'unknown';
  }
}

export class DeltaRestClient implements FuturesExchangeClient {
  readonly exchange = 'delta' as const;
  private limiter: RateLimiter;
  readonly breaker: CircuitBreaker;
  private clock: Clock;
  private fetchImpl: typeof fetch;
  private products = new Map<string, { at: number; p: DeltaProduct }>();
  private productsById = new Map<number, DeltaProduct>();
  private orderProduct = new Map<string, number>();
  private leverageSet = new Map<number, number>();
  private assetSymbols = new Map<number, string>();
  private calls = new Map<string, EndpointStats>();

  constructor(private readonly o: DeltaRestOptions) {
    this.clock = o.clock ?? systemClock;
    this.limiter = new RateLimiter(Math.max(5, Math.floor(o.maxRequestsPerMinute / 6)), o.maxRequestsPerMinute / 60, this.clock);
    this.breaker = new CircuitBreaker('delta', 5, 30_000, this.clock);
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get authenticated(): boolean {
    return !!(this.o.apiKey && this.o.apiSecret);
  }

  stats(): EndpointStats[] {
    return [...this.calls.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  }

  // --------------------------------------------------------------- transport
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    o: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown>; auth?: boolean } = {},
  ): Promise<T> {
    await this.limiter.acquire();
    const key = `${method} ${path.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/(orders\/client_order_id|l2orderbook|trades|products|tickers)\/[^/]+$/, '/$1/{x}')}`;
    const st = this.calls.get(key) ?? { endpoint: key, auth: !!o.auth, count: 0, errors: 0, lastStatus: 0, lastAt: 0, lastLatencyMs: 0 };
    this.calls.set(key, st);
    const t0 = Date.now();
    try {
      const r = await this.breaker.exec(() => this.send<T>(method, path, o));
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

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    o: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown>; auth?: boolean },
  ): Promise<T> {
    const query = deltaQuery(o.query);
    const body = o.body ? JSON.stringify(o.body) : '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'rest-client' };
    if (o.auth) {
      if (!this.o.apiKey || !this.o.apiSecret) throw new ExchangeError('Delta API credentials not configured', 401, false);
      const ts = String(Math.floor(this.clock.now() / 1000));
      headers['api-key'] = this.o.apiKey;
      headers.timestamp = ts;
      headers.signature = deltaSignature(this.o.apiSecret, method, ts, path, query, body);
    }
    const url = `${this.o.baseUrl}${path}${query}`;
    let res: Response;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    try {
      res = await this.fetchImpl(url, { method, headers, body: body || undefined, signal: ctrl.signal });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError' || /timeout/i.test((e as Error).message);
      throw new ExchangeError(`network error ${method} ${path}: ${aborted ? 'timeout' : (e as Error).message}`, undefined, true, { ambiguous: true });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: { success?: boolean; result?: unknown; error?: unknown; meta?: unknown };
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 300) };
    }
    if (!res.ok || json.success === false) {
      const status = res.ok ? 400 : res.status;
      const retryable = status === 429 || status >= 500;
      if (status === 429) log.warn({ path }, 'rate limited by Delta');
      const err = deltaErrorMessage(json, String(json.error ?? text.slice(0, 200)));
      throw new ExchangeError(`Delta ${status} ${method} ${path}: ${err}`, status, retryable, json);
    }
    return json.result as T;
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

  // --------------------------------------------------------------- products & conversions
  private async product(symbol: string, maxAgeMs = 3_600_000): Promise<DeltaProduct> {
    const c = this.products.get(symbol);
    if (c && this.clock.now() - c.at < maxAgeMs) return c.p;
    const p = await this.read(() => this.request<DeltaProduct>('GET', `/v2/products/${encodeURIComponent(symbol)}`));
    if (!p || !Number.isFinite(num(p.contract_value)) || !(num(p.contract_value) > 0) || !Number.isFinite(num(p.tick_size))) {
      throw new ExchangeError(`invalid Delta product spec for ${symbol}`, undefined, false, p);
    }
    this.products.set(symbol, { at: this.clock.now(), p });
    this.productsById.set(Number(p.id), p);
    return p;
  }

  private async productById(id: number): Promise<DeltaProduct | undefined> {
    const known = this.productsById.get(id);
    if (known) return known;
    const p = await this.read(() => this.request<DeltaProduct>('GET', `/v2/products/${id}`)).catch(() => undefined);
    if (p) {
      this.productsById.set(Number(p.id), p);
      this.products.set(p.symbol, { at: this.clock.now(), p });
    }
    return p;
  }

  private async cvOf(order: { product_id?: number; product_symbol?: string }): Promise<{ cv: number; symbol: string }> {
    let p: DeltaProduct | undefined;
    if (order.product_symbol) p = await this.product(order.product_symbol).catch(() => undefined);
    if (!p && order.product_id !== undefined) p = await this.productById(Number(order.product_id));
    if (!p) throw new ExchangeError(`unknown Delta product ${order.product_symbol ?? order.product_id}`, undefined, false);
    return { cv: num(p.contract_value), symbol: p.symbol };
  }

  async instrument(pair: string, maxAgeMs = 3_600_000): Promise<CdxInstrument> {
    const p = await this.product(pair, maxAgeMs);
    const cv = num(p.contract_value);
    const im = num(p.initial_margin);
    const maxLev = Number.isFinite(im) && im > 0 ? Math.floor(100 / im) : Number.isFinite(num(p.default_leverage)) ? num(p.default_leverage) : undefined;
    const live = (p.state ?? 'live') === 'live' && (p.trading_status ?? 'operational') === 'operational';
    return {
      pair: p.symbol,
      status: live ? 'active' : p.trading_status ?? p.state ?? 'unknown',
      kind: p.contract_type,
      settle_currency_short_name: p.settling_asset?.symbol,
      quote_currency_short_name: p.quoting_asset?.symbol,
      underlying_currency_short_name: p.underlying_asset?.symbol,
      price_increment: num(p.tick_size),
      quantity_increment: cv,
      min_quantity: cv,
      max_quantity: p.position_size_limit ? p.position_size_limit * cv : undefined,
      max_leverage_long: maxLev,
      max_leverage_short: maxLev,
      unit_contract_value: cv,
      funding_frequency: 8,
    };
  }

  // --------------------------------------------------------------- public market data
  async candles(pair: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]> {
    const rows = await this.read(() =>
      this.request<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>('GET', '/v2/history/candles', {
        query: { resolution: tf, symbol: pair, start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) },
      }),
    );
    if (!Array.isArray(rows)) throw new ExchangeError('unexpected Delta candles payload', undefined, false, rows);
    return rows
      .map((d) => ({ t: tsToMs(d.time)!, o: num(d.open), h: num(d.high), l: num(d.low), c: num(d.close), v: num(d.volume) || 0 }))
      .filter((c) => Number.isFinite(c.t) && c.h >= c.l && c.o > 0 && c.c > 0)
      .sort((a, b) => a.t - b.t)
      .filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
  }

  async orderbook(pair: string, depth: 10 | 20 | 50 = 50): Promise<OrderBook> {
    const [p, r] = await Promise.all([
      this.product(pair),
      this.read(() => this.request<{ buy?: Array<{ price: string; size: number }>; sell?: Array<{ price: string; size: number }>; last_updated_at?: number }>('GET', `/v2/l2orderbook/${encodeURIComponent(pair)}`, { query: { depth } })),
    ]);
    const cv = num(p.contract_value);
    const lv = (a?: Array<{ price: string; size: number }>) => (a ?? []).map((x) => ({ price: num(x.price), qty: num(x.size) * cv })).filter((x) => x.qty > 0 && x.price > 0);
    return {
      instrument: pair,
      ts: tsToMs(r?.last_updated_at) ?? this.clock.now(),
      bids: lv(r?.buy).sort((a, b) => b.price - a.price),
      asks: lv(r?.sell).sort((a, b) => a.price - b.price),
    };
  }

  async publicTrades(pair: string): Promise<PublicTradeRow[]> {
    const [p, r] = await Promise.all([this.product(pair), this.read(() => this.request<unknown>('GET', `/v2/trades/${encodeURIComponent(pair)}`))]);
    const cv = num(p.contract_value);
    const list = deltaRows(r, ['trades']) as Array<{ price: string; size: number; timestamp: number; buyer_role?: string }>;
    return list.map((t) => ({ price: num(t.price), quantity: num(t.size) * cv, timestamp: tsToMs(t.timestamp) ?? 0, is_maker: t.buyer_role === 'maker' })).filter((t) => t.price > 0 && t.quantity > 0);
  }

  /** Perpetual tickers: mark, last, funding (percent -> fraction), 24h change and USD turnover. */
  async currentPrices(): Promise<Record<string, CurrentPrice>> {
    const rows = await this.read(() =>
      this.request<Array<Record<string, unknown>>>('GET', '/v2/tickers', { query: { contract_types: 'perpetual_futures' } }),
    );
    const out: Record<string, CurrentPrice> = {};
    for (const t of Array.isArray(rows) ? rows : []) {
      const sym = String(t.symbol);
      const open = num(t.open);
      const close = num(t.close);
      const fr = num(t.funding_rate);
      out[sym] = {
        mark: Number.isFinite(num(t.mark_price)) ? num(t.mark_price) : undefined,
        last: Number.isFinite(close) ? close : undefined,
        fundingRate: Number.isFinite(fr) ? fr / 100 : undefined,
        change24h: Number.isFinite(open) && open > 0 && Number.isFinite(close) ? ((close - open) / open) * 100 : undefined,
        volume24h: Number.isFinite(num(t.turnover_usd)) ? num(t.turnover_usd) : undefined,
      };
    }
    return out;
  }

  // --------------------------------------------------------------- orders
  private async mapOrder(d: DeltaOrder): Promise<CdxOrder> {
    const { cv, symbol } = await this.cvOf(d);
    const size = num(d.size);
    const unfilled = num(d.unfilled_size ?? d.size);
    const cancelled = d.state === 'cancelled';
    if (d.product_id !== undefined) this.orderProduct.set(String(d.id), Number(d.product_id));
    return {
      id: String(d.id),
      pair: symbol,
      side: d.side,
      status: deltaStatus(d),
      order_type: d.order_type ?? 'market_order',
      price: d.limit_price ? num(d.limit_price) : undefined,
      avg_price: d.average_fill_price ? num(d.average_fill_price) : undefined,
      total_quantity: size * cv,
      // filled = total - remaining - cancelled (venue formula): a cancelled order's unfilled part is "cancelled"
      remaining_quantity: cancelled ? 0 : unfilled * cv,
      cancelled_quantity: cancelled ? unfilled * cv : 0,
      fee_amount: d.paid_commission ? num(d.paid_commission) : undefined,
      created_at: tsToMs(d.created_at),
      client_order_id: d.client_order_id ?? undefined,
    };
  }

  private async mapOrders(list: unknown): Promise<CdxOrder[]> {
    const arr = deltaRows(list) as DeltaOrder[];
    const out: CdxOrder[] = [];
    for (const d of arr) {
      try {
        out.push(await this.mapOrder(d));
      } catch (e) {
        log.warn({ id: d.id, err: (e as Error).message }, 'skipping unmappable Delta order');
      }
    }
    return out;
  }

  async listOrders(status: string, side?: 'buy' | 'sell', _page = 1, size = 50): Promise<CdxOrder[]> {
    const open = status === 'open' || status === 'partially_filled' || status === 'initial';
    const raw = open
      ? await this.read(() => this.request<unknown>('GET', '/v2/orders', { query: { states: 'open,pending', contract_types: 'perpetual_futures', page_size: Math.min(50, size) }, auth: true }))
      : await this.read(() => this.request<unknown>('GET', '/v2/orders/history', { query: { contract_types: 'perpetual_futures', page_size: Math.min(50, size) }, auth: true }));
    return (await this.mapOrders(raw)).filter((o) => o.status === status && (!side || o.side === side));
  }

  async orderById(id: string): Promise<CdxOrder | null> {
    try {
      const d = await this.read(() => this.request<DeltaOrder>('GET', `/v2/orders/${encodeURIComponent(id)}`, { auth: true }));
      return d ? this.mapOrder(d) : null;
    } catch (e) {
      if (e instanceof ExchangeError && e.status === 404) return null;
      throw e;
    }
  }

  async orderByClientId(clientOrderId: string): Promise<CdxOrder | null> {
    try {
      const d = await this.read(() => this.request<DeltaOrder>('GET', `/v2/orders/client_order_id/${encodeURIComponent(clientOrderId)}`, { auth: true }));
      return d ? this.mapOrder(d) : null;
    } catch (e) {
      if (e instanceof ExchangeError && e.status === 404) return null;
      throw e;
    }
  }

  private async ensureLeverage(productId: number, leverage: number) {
    const lev = Math.max(1, Math.round(leverage));
    if (this.leverageSet.get(productId) === lev) return;
    await this.request('POST', `/v2/products/${productId}/orders/leverage`, { body: { leverage: lev }, auth: true });
    this.leverageSet.set(productId, lev);
  }

  /**
   * Place an order. Quantity is converted to integer contracts (rounded to the nearest contract after
   * the venue has already floored it to the contract value). NOT retried: an ambiguous failure is
   * resolved by the venue via client_order_id lookup (reconcile-before-retry).
   */
  async createOrder(o: CreateOrderInput): Promise<CdxOrder[]> {
    const p = await this.product(o.pair);
    const cv = num(p.contract_value);
    const contracts = Math.round(o.total_quantity / cv);
    if (contracts < 1) throw new ExchangeError(`quantity ${o.total_quantity} is below one Delta contract (${cv} ${o.pair})`, 400, false);
    if (!o.reduce_only) await this.ensureLeverage(Number(p.id), o.leverage);
    const body: Record<string, unknown> = {
      product_id: Number(p.id),
      size: contracts,
      side: o.side,
      order_type: o.order_type,
      reduce_only: !!o.reduce_only,
    };
    if (o.order_type === 'limit_order') {
      body.limit_price = String(o.price);
      body.time_in_force = o.time_in_force === 'immediate_or_cancel' ? 'ioc' : o.time_in_force === 'fill_or_kill' ? 'fok' : 'gtc';
    }
    if (o.client_order_id) body.client_order_id = o.client_order_id.slice(0, 32);
    const d = await this.request<DeltaOrder>('POST', '/v2/orders', { body, auth: true });
    return d ? [await this.mapOrder({ ...d, product_id: d.product_id ?? Number(p.id), product_symbol: d.product_symbol ?? p.symbol })] : [];
  }

  async cancelOrder(id: string): Promise<void> {
    let productId = this.orderProduct.get(id);
    if (productId === undefined) {
      const d = await this.read(() => this.request<DeltaOrder>('GET', `/v2/orders/${encodeURIComponent(id)}`, { auth: true }));
      productId = Number(d?.product_id);
    }
    await withRetry(() => this.request('DELETE', '/v2/orders', { body: { id: Number(id), product_id: productId }, auth: true }), {
      retries: 2,
      baseDelayMs: 300,
      maxDelayMs: 2000,
      clock: this.clock,
    });
  }

  async cancelAllOpenOrders(): Promise<void> {
    await this.request('DELETE', '/v2/orders/all', { auth: true });
  }

  // --------------------------------------------------------------- positions / account
  async listPositions(): Promise<CdxPosition[]> {
    const rows = await this.read(() =>
      this.request<unknown>('GET', '/v2/positions/margined', { query: { contract_types: 'perpetual_futures' }, auth: true }),
    );
    const out: CdxPosition[] = [];
    for (const r of deltaRows(rows) as Array<{ product_id: number; product_symbol?: string; size: number; entry_price?: string; liquidation_price?: string; margin?: string }>) {
      const { cv, symbol } = await this.cvOf(r);
      out.push({
        id: String(r.product_id),
        pair: symbol,
        active_pos: num(r.size) * cv,
        avg_price: num(r.entry_price),
        liquidation_price: num(r.liquidation_price),
        locked_margin: num(r.margin),
      });
    }
    return out;
  }

  /** Close one product's position with a reduce-only market order (positionId = product id). */
  async exitPosition(positionId: string): Promise<unknown> {
    const pos = (await this.listPositions()).find((p) => p.id === positionId);
    if (!pos || pos.active_pos === 0) return {};
    return this.createOrder({ pair: pos.pair, side: pos.active_pos > 0 ? 'sell' : 'buy', order_type: 'market_order', total_quantity: Math.abs(pos.active_pos), leverage: 1, reduce_only: true });
  }

  async trades(params: { pair?: string; orderId?: string; page?: number; size?: number }): Promise<CdxTrade[]> {
    const q: Record<string, string | number | undefined> = { page_size: Math.min(50, params.size ?? 50), contract_types: 'perpetual_futures' };
    if (params.pair) q.product_ids = String((await this.product(params.pair)).id);
    const rows = await this.read(() => this.request<unknown>('GET', '/v2/fills', { query: q, auth: true }));
    const out: CdxTrade[] = [];
    for (const f of deltaRows(rows) as Array<Record<string, unknown>>) {
      const prod = (f.product ?? {}) as { symbol?: string; contract_value?: string; id?: number };
      const cv = num(prod.contract_value) || (await this.cvOf({ product_id: Number(f.product_id) }).catch(() => ({ cv: NaN }))).cv;
      if (params.orderId && String(f.order_id) !== params.orderId) continue;
      out.push({
        price: num(f.price),
        quantity: num(f.size) * cv,
        is_maker: f.role === 'maker',
        fee_amount: num(f.commission),
        pair: String(prod.symbol ?? f.product_symbol ?? ''),
        side: f.side as 'buy' | 'sell',
        timestamp: tsToMs(f.created_at) ?? 0,
        order_id: String(f.order_id),
      });
    }
    return out;
  }

  /** Wallet balances; locked = balance - available_balance. Asset symbols resolved via /v2/assets if absent. */
  async wallets(): Promise<CdxWalletEntry[]> {
    const rows = await this.read(() => this.request<unknown>('GET', '/v2/wallet/balances', { auth: true }));
    const list = deltaRows(rows) as Array<Record<string, unknown>>;
    if (list.some((r) => !r.asset_symbol) && !this.assetSymbols.size) {
      const assets = await this.read(() => this.request<Array<{ id: number; symbol: string }>>('GET', '/v2/assets')).catch(() => []);
      for (const a of assets ?? []) this.assetSymbols.set(Number(a.id), a.symbol);
    }
    return list.map((r) => {
      const balance = num(r.balance);
      const avail = num(r.available_balance);
      return {
        ...r,
        currency_short_name: String(r.asset_symbol ?? this.assetSymbols.get(Number(r.asset_id)) ?? r.asset_id),
        balance,
        locked_balance: Number.isFinite(avail) ? Math.max(0, balance - avail) : 0,
      };
    });
  }
}
