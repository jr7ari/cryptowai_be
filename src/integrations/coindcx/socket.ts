/**
 * CoinDCX Socket.IO stream (verified: wss://stream.coindcx.com, socket.io-client v2.4.0, `join`/`leave`
 * events, heartbeat ~25s). Public futures channels:
 *   <pair>@prices-futures          -> 'price-change'   {T, p, pr}
 *   <pair>@trades-futures          -> 'new-trade'      {T, RT, p, q, m, s, pr}
 *   <pair>@orderbook@50-futures    -> 'depth-snapshot' / 'depth-update'
 *   currentPrices@futures@rt       -> 'currentPrices@futures#update' {prices: {pair: {mp, ...}}}
 * Private channel 'coindcx' (signed) -> 'df-position-update', 'df-order-update', 'balance-update'.
 */
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('coindcx-socket');

export interface SocketOptions {
  url: string;
  apiKey?: string;
  apiSecret?: string;
  pairs: string[];
  heartbeatMs?: number;
}

type IoSocket = {
  on(ev: string, fn: (...a: unknown[]) => void): void;
  emit(ev: string, data?: unknown): void;
  close(): void;
  connected: boolean;
};

export interface PriceTick {
  pair: string;
  price: number;
  ts: number;
}
export interface MarkTick {
  pair: string;
  mark: number;
  ts: number;
  fundingRate?: number;
}
export interface TradeTick {
  pair: string;
  ts: number;
  price: number;
  qty: number;
  isMaker?: boolean;
  side?: 'buy' | 'sell';
}

export declare interface CoinDcxSocket {
  on(e: 'price', l: (t: PriceTick) => void): this;
  on(e: 'mark', l: (t: MarkTick) => void): this;
  on(e: 'trade', l: (t: TradeTick) => void): this;
  on(e: 'book', l: (t: import('../../domain/types.js').OrderBook) => void): this;
  on(e: 'order', l: (o: Record<string, unknown>) => void): this;
  on(e: 'position', l: (p: Record<string, unknown>) => void): this;
  on(e: 'balance', l: (b: Record<string, unknown>) => void): this;
  on(e: 'status', l: (s: { connected: boolean; reason?: string }) => void): this;
}

export class CoinDcxSocket extends EventEmitter {
  private socket?: IoSocket;
  private hb?: NodeJS.Timeout;
  lastMessageAt = 0;
  connected = false;

  constructor(private readonly o: SocketOptions) {
    super();
  }

  async connect(): Promise<void> {
    // socket.io-client 2.x is CommonJS
    const mod = (await import('socket.io-client')) as unknown as { default?: (u: string, o: unknown) => IoSocket } & ((u: string, o: unknown) => IoSocket);
    const io = (mod.default ?? mod) as (u: string, o: unknown) => IoSocket;
    const s = io(this.o.url, { transports: ['websocket'], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 15000 });
    this.socket = s;

    s.on('connect', () => {
      this.connected = true;
      log.info('socket connected');
      this.emit('status', { connected: true });
      for (const pair of this.o.pairs) {
        s.emit('join', { channelName: `${pair}@prices-futures` });
        s.emit('join', { channelName: `${pair}@trades-futures` });
      }
      s.emit('join', { channelName: 'currentPrices@futures@rt' });
      if (this.o.apiKey && this.o.apiSecret) {
        const body = JSON.stringify({ channel: 'coindcx' });
        const authSignature = createHmac('sha256', this.o.apiSecret).update(body).digest('hex');
        s.emit('join', { channelName: 'coindcx', authSignature, apiKey: this.o.apiKey });
      }
    });
    s.on('disconnect', (reason) => {
      this.connected = false;
      log.warn({ reason }, 'socket disconnected');
      this.emit('status', { connected: false, reason: String(reason) });
    });
    s.on('connect_error', (e) => log.warn({ err: String((e as Error)?.message ?? e) }, 'socket connect error'));

    const parse = (raw: unknown): Record<string, unknown> | null => {
      this.lastMessageAt = Date.now();
      try {
        const d = (raw as { data?: unknown })?.data ?? raw;
        return typeof d === 'string' ? JSON.parse(d) : (d as Record<string, unknown>);
      } catch {
        return null;
      }
    };

    s.on('new-trade', (raw) => {
      const d = parse(raw);
      if (!d) return;
      const price = Number(d.p);
      const qty = Number(d.q);
      const rawS = String(d.s ?? '');
      const pairFromS = rawS.startsWith('B-') || rawS.includes('_') ? rawS : '';
      const pair = pairFromS || String(d.pair ?? d.pr ?? (raw as { channel?: string })?.channel?.split('@')[0] ?? '');
      if (!(price > 0) || !(qty > 0) || !pair) return;
      const sideRaw = String((pairFromS ? d.S ?? d.side : d.S ?? d.side ?? d.s) ?? '').toLowerCase();
      const side = sideRaw === 'buy' || sideRaw === 'b' ? 'buy' : sideRaw === 'sell' || sideRaw === 'a' ? 'sell' : undefined;
      const isMaker = typeof d.m === 'boolean' ? d.m : undefined;
      this.emit('trade', { pair, ts: Number(d.T ?? d.RT) || Date.now(), price, qty, isMaker, side });
    });
    s.on('price-change', (raw) => {
      const d = parse(raw);
      if (!d) return;
      const p = Number(d.p);
      const pair = String(d.s ?? d.pair ?? (raw as { channel?: string })?.channel?.split('@')[0] ?? '');
      if (Number.isFinite(p) && pair) this.emit('price', { pair, price: p, ts: Number(d.T) || Date.now() });
    });
    s.on('currentPrices@futures#update', (raw) => {
      const d = parse(raw);
      const prices = (d?.prices ?? {}) as Record<string, Record<string, unknown>>;
      for (const [pair, v] of Object.entries(prices)) {
        const mark = Number(v.mp);
        if (!Number.isFinite(mark)) continue;
        const fr = v.fr !== undefined ? Number(v.fr) : undefined; // optional: not documented in all versions
        this.emit('mark', { pair, mark, ts: Number(d?.ts) || Date.now(), fundingRate: Number.isFinite(fr) ? fr : undefined });
        const ls = Number(v.ls);
        if (Number.isFinite(ls)) this.emit('price', { pair, price: ls, ts: Number(d?.ts) || Date.now() });
      }
    });
    s.on('df-order-update', (raw) => {
      const d = parse(raw);
      for (const o of Array.isArray(d) ? d : d ? [d] : []) this.emit('order', o as Record<string, unknown>);
    });
    s.on('df-position-update', (raw) => {
      const d = parse(raw);
      for (const p of Array.isArray(d) ? d : d ? [d] : []) this.emit('position', p as Record<string, unknown>);
    });
    s.on('balance-update', (raw) => {
      const d = parse(raw);
      for (const b of Array.isArray(d) ? d : d ? [d] : []) this.emit('balance', b as Record<string, unknown>);
    });

    this.hb = setInterval(() => {
      if (this.socket?.connected) this.socket.emit('ping', { data: 'Ping message' });
    }, this.o.heartbeatMs ?? 25_000);
  }

  close(): void {
    if (this.hb) clearInterval(this.hb);
    this.socket?.close();
    this.connected = false;
  }
}
