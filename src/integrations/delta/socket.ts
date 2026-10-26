/**
 * Delta Exchange public websocket (tick-by-tick LTP, top-of-book, L2, mark, funding).
 *
 * Endpoint: wss://public-socket.india.delta.exchange (India). Channels from docs.delta.exchange
 * (new public API; legacy l2_orderbook on socket.india.delta.exchange is deprecated 31 Oct 2026):
 *   trades      — every fill
 *   ob_l1       — best bid/ask ~100 ms
 *   ob_l2       — top 15 levels ~500 ms (paper fills walk this book)
 *   ticker      — 5 s snapshot (mark, 24h close, quotes)
 *   mark_price  — MARK:{symbol}
 *   funding_rate
 *
 * Sizes on the wire are integer contracts; this adapter converts to underlying units using
 * contract_value (BTCUSD = 0.001 BTC). Heartbeat enabled; reconnect on silence > 35 s.
 */
import { EventEmitter } from 'node:events';
import type { OrderBook } from '../../domain/types.js';
import type { PriceTick, MarkTick, TradeTick } from '../coindcx/socket.js';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('delta-ws');

const DEFAULT_CV: Record<string, number> = { BTCUSD: 0.001, ETHUSD: 0.01 };
const HEARTBEAT_MS = 35_000;
const PING_MS = 30_000;

export interface DeltaSocketOptions {
  url: string;
  symbols: string[];
  /** resolve contract_value in underlying units; used once per symbol at connect */
  contractValue?: (symbol: string) => number | Promise<number | undefined>;
  WebSocketImpl?: typeof WebSocket;
}

function tsToMs(t: unknown): number {
  if (t === null || t === undefined || t === '') return Date.now();
  const n = Number(t);
  if (!Number.isFinite(n)) return Date.now();
  if (n > 1e15) return Math.floor(n / 1000);
  if (n > 1e12) return n;
  return n * 1000;
}

const num = (x: unknown): number => Number(x);

export declare interface DeltaPublicSocket {
  on(e: 'price', l: (t: PriceTick) => void): this;
  on(e: 'mark', l: (t: MarkTick) => void): this;
  on(e: 'trade', l: (t: TradeTick) => void): this;
  on(e: 'book', l: (t: OrderBook) => void): this;
  on(e: 'status', l: (s: { connected: boolean; reason?: string }) => void): this;
}

export class DeltaPublicSocket extends EventEmitter {
  private ws?: WebSocket;
  private hb?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private closing = false;
  private attempt = 0;
  private cv = new Map<string, number>();
  lastMessageAt = 0;
  connected = false;

  constructor(private readonly o: DeltaSocketOptions) {
    super();
  }

  private cvOf(sym: string): number {
    return this.cv.get(sym) ?? DEFAULT_CV[sym] ?? 1;
  }

  async connect(): Promise<void> {
    this.closing = false;
    for (const s of this.o.symbols) {
      let v = DEFAULT_CV[s];
      try {
        const got = await this.o.contractValue?.(s);
        if (got && got > 0) v = got;
      } catch {
        /* keep default */
      }
      this.cv.set(s, v ?? 1);
    }
    this.open();
  }

  private open() {
    if (this.closing) return;
    const Impl = this.o.WebSocketImpl ?? globalThis.WebSocket;
    const ws = new Impl(this.o.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      log.info({ url: this.o.url, symbols: this.o.symbols }, 'delta public socket connected');
      this.emit('status', { connected: true });
      this.send({ type: 'enable_heartbeat' });
      const symbols = this.o.symbols;
      this.send({
        type: 'subscribe',
        payload: {
          channels: [
            { name: 'trades', symbols },
            { name: 'ob_l1', symbols },
            { name: 'ob_l2', symbols },
            { name: 'ticker', symbols },
            { name: 'mark_price', symbols: symbols.map((s) => `MARK:${s}`) },
            { name: 'funding_rate', symbols },
          ],
        },
      });
      this.armHeartbeat();
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      this.armHeartbeat();
      const raw = typeof ev.data === 'string' ? ev.data : ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : String(ev.data ?? '');
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = (e) => log.warn({ err: String((e as { message?: string })?.message ?? e) }, 'delta socket error');
    ws.onclose = (ev) => {
      this.connected = false;
      this.emit('status', { connected: false, reason: String(ev?.reason || ev?.code || 'closed') });
      this.clearTimers();
      if (!this.closing) this.scheduleReconnect();
    };
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  private armHeartbeat() {
    if (this.hb) clearTimeout(this.hb);
    this.hb = setTimeout(() => {
      log.warn('delta socket heartbeat timeout; reconnecting');
      try {
        this.ws?.close();
      } catch {
        this.scheduleReconnect();
      }
    }, HEARTBEAT_MS);
  }

  private scheduleReconnect() {
    if (this.closing || this.reconnect) return;
    const delay = Math.min(15_000, 1000 * 2 ** this.attempt);
    this.attempt++;
    log.info({ delayMs: delay, attempt: this.attempt }, 'delta socket reconnect scheduled');
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.open();
    }, delay);
  }

  private handle(msg: Record<string, unknown>) {
    const type = String(msg.type ?? '');
    if (type === 'heartbeat' || type === 'pong' || type === 'subscriptions') return;
    if (type === 'trades' || type === 'all_trades' || type === 'recent_trade') this.onTrade(msg);
    else if (type === 'ob_l1') this.onL1(msg);
    else if (type === 'ob_l2' || type === 'l2_orderbook') this.onL2(msg);
    else if (type === 'ticker' || type === 'v2/ticker') this.onTicker(msg);
    else if (type === 'mark_price') this.onMark(msg);
    else if (type === 'funding_rate') this.onFunding(msg);
  }

  private onTrade(m: Record<string, unknown>) {
    const pair = String(m.sy ?? m.symbol ?? '');
    const price = num(m.p ?? m.price);
    const size = num(m.s ?? m.size);
    if (!pair || !(price > 0) || !(size > 0)) return;
    const qty = size * this.cvOf(pair);
    const ts = tsToMs(m.t ?? m.ts);
    const role = String(m.r ?? m.buyer_role ?? '').toLowerCase();
    this.emit('price', { pair, price, ts } satisfies PriceTick);
    this.emit('trade', { pair, ts, price, qty, isMaker: role === 'm' || role === 'maker' } satisfies TradeTick);
  }

  private onL1(m: Record<string, unknown>) {
    const pair = String(m.sy ?? m.symbol ?? '');
    const bid = num(m.bp);
    const ask = num(m.ap);
    const cv = this.cvOf(pair);
    if (!pair || !(bid > 0) || !(ask > 0) || ask < bid) return;
    const ts = tsToMs(m.ts ?? m.lts);
    const bids = [{ price: bid, qty: Math.max(0, num(m.bs)) * cv }];
    const asks = [{ price: ask, qty: Math.max(0, num(m.as)) * cv }];
    this.emit('book', { instrument: pair, ts, bids, asks } satisfies OrderBook);
    this.emit('price', { pair, price: (bid + ask) / 2, ts } satisfies PriceTick);
  }

  private onL2(m: Record<string, unknown>) {
    const pair = String(m.sy ?? m.symbol ?? '');
    if (!pair) return;
    const cv = this.cvOf(pair);
    const lv = (side: unknown) =>
      (Array.isArray(side) ? side : []).map((row) => {
        const [p, s] = Array.isArray(row) ? row : [ (row as { price?: unknown }).price, (row as { size?: unknown }).size ];
        return { price: num(p), qty: num(s) * cv };
      }).filter((x) => x.price > 0 && x.qty > 0);
    const bids = lv(m.b ?? m.buy).sort((a, b) => b.price - a.price);
    const asks = lv(m.a ?? m.sell).sort((a, b) => a.price - b.price);
    if (!bids.length || !asks.length) return;
    const ts = tsToMs(m.ts ?? m.lts);
    this.emit('book', { instrument: pair, ts, bids, asks } satisfies OrderBook);
  }

  private onTicker(m: Record<string, unknown>) {
    const rows = Array.isArray(m.d) ? (m.d as Record<string, unknown>[]) : [m];
    const ts = tsToMs(m.ts);
    for (const r of rows) {
      const pair = String(r.s ?? r.symbol ?? m.sy ?? '');
      if (!pair || !this.o.symbols.includes(pair)) continue;
      const mark = num(r.m ?? r.mark_price);
      const ohlc = r.ohlc as unknown[] | undefined;
      const last = num(ohlc?.[3] ?? r.close);
      if (Number.isFinite(mark) && mark > 0) this.emit('mark', { pair, mark, ts } satisfies MarkTick);
      if (Number.isFinite(last) && last > 0) this.emit('price', { pair, price: last, ts } satisfies PriceTick);
    }
  }

  private onMark(m: Record<string, unknown>) {
    const raw = String(m.sy ?? m.symbol ?? '');
    const pair = raw.startsWith('MARK:') ? raw.slice(5) : raw;
    const mark = num(m.p ?? m.mark_price);
    if (!pair || !(mark > 0)) return;
    this.emit('mark', { pair, mark, ts: tsToMs(m.ts) } satisfies MarkTick);
  }

  private onFunding(m: Record<string, unknown>) {
    const pair = String(m.sy ?? m.symbol ?? '');
    const fr = num(m.fr ?? m.funding_rate);
    if (!pair || !Number.isFinite(fr)) return;
    this.emit('mark', { pair, mark: 0, ts: tsToMs(m.ts), fundingRate: fr / 100 } satisfies MarkTick);
  }

  private clearTimers() {
    if (this.hb) clearTimeout(this.hb);
    if (this.ping) clearInterval(this.ping);
    this.hb = undefined;
    this.ping = undefined;
  }

  close(): void {
    this.closing = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
  }
}
