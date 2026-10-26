/**
 * TEST FIXTURE ONLY - a CoinDCX/Deribit protocol double used by integration tests to exercise the
 * real REST client (HMAC signing, GET-with-body wallet call, order/position/reconcile flow) without
 * network access. It is never part of the application runtime and its prices are not market data.
 */
import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateRegimeSeries } from './synthetic-data.js';
import type { Candle } from '../../src/domain/types.js';
import { buildSyntheticChain, standardExpiries } from './synthetic-chain.js';
import { yangZhangVol } from '../../src/indicators/volatility.js';

const MIN = 60_000;

export interface MockOptions {
  port?: number;
  apiKey?: string;
  apiSecret?: string;
  days?: number;
  seed?: number;
  startingBalance?: number;
}

interface Pos {
  id: string;
  pair: string;
  qty: number;
  avg: number;
}

export async function startMockExchange(o: MockOptions = {}) {
  const apiKey = o.apiKey ?? 'mock-key';
  const apiSecret = o.apiSecret ?? 'mock-secret';
  const days = o.days ?? 120;
  const now0 = Date.now();
  const start = Math.floor((now0 - days * 86_400_000) / MIN) * MIN;
  const bars = days * 1440 + 60 * 24 * 30; // extend 30 days into the future for a long-running sim
  const pairs: Record<string, { candles: Candle[]; instrument: Record<string, unknown>; u: string }> = {};
  const mk = (pair: string, price: number, seed: number, u: string, qtyStep: number, pxStep: number) => {
    const { candles } = generateRegimeSeries({ start, bars, tf: '1m', startPrice: price, seed, meanRegimeBars: 3000 });
    pairs[pair] = {
      candles,
      u,
      instrument: {
        pair,
        status: 'active',
        kind: 'perpetual',
        settle_currency_short_name: 'USDT',
        quote_currency_short_name: 'USDT',
        underlying_currency_short_name: u,
        price_increment: pxStep,
        quantity_increment: qtyStep,
        min_quantity: qtyStep,
        max_quantity: 1000,
        min_notional: 5,
        max_leverage_long: 25,
        max_leverage_short: 25,
        maker_fee: 0.02,
        taker_fee: 0.05,
        max_market_order_quantity: 100,
        funding_frequency: 8,
        order_types: ['market_order', 'limit_order', 'stop_market', 'take_profit_market'],
        time_in_force_options: ['good_till_cancel', 'immediate_or_cancel', 'fill_or_kill'],
      },
    };
  };
  mk('B-BTC_USDT', 60000, o.seed ?? 7, 'BTC', 0.001, 0.1);
  mk('B-ETH_USDT', 3000, (o.seed ?? 7) + 1, 'ETH', 0.01, 0.01);

  const idx = (t: number) => Math.max(0, Math.min(bars - 1, Math.floor((t - start) / MIN)));
  const priceAt = (pair: string, t = Date.now()) => pairs[pair].candles[idx(t)].c;
  const aggregate = (pair: string, from: number, to: number, resMin: number) => {
    const out: Array<{ open: number; high: number; low: number; close: number; volume: number; time: number }> = [];
    const step = resMin * MIN;
    const now = Date.now();
    for (let b = Math.floor(from / step) * step; b <= Math.min(to, now); b += step) {
      const i0 = idx(b);
      const i1 = idx(Math.min(b + step, now + MIN) - 1);
      if (b < start) continue;
      const cs = pairs[pair].candles.slice(i0, i1 + 1);
      if (!cs.length) continue;
      out.push({
        open: cs[0].o,
        high: Math.max(...cs.map((c) => c.h)),
        low: Math.min(...cs.map((c) => c.l)),
        close: cs[cs.length - 1].c,
        volume: cs.reduce((a, c) => a + c.v, 0),
        time: b,
      });
    }
    return out;
  };

  // ---------------------------------------------------------------- account state
  let balance = o.startingBalance ?? 10_000;
  const positions = new Map<string, Pos>();
  const orders: Array<Record<string, unknown>> = [];
  const trades: Array<Record<string, unknown>> = [];
  let seq = 0;

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const auth = (req: { headers: Record<string, unknown>; rawBody?: string; body?: unknown }) => {
    const key = String(req.headers['x-auth-apikey'] ?? '');
    const sig = String(req.headers['x-auth-signature'] ?? '');
    const raw = (req as { rawBody?: string }).rawBody ?? '';
    const expect = createHmac('sha256', apiSecret).update(raw).digest('hex');
    if (key !== apiKey || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return 'invalid signature';
    const ts = Number((req.body as { timestamp?: number })?.timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) return 'timestamp out of window';
    return null;
  };
  const guard = (req: never, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    const err = auth(req);
    if (err) {
      reply.code(401).send({ code: 401, message: err, status: 'error' });
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------- public
  app.get('/exchange/v1/derivatives/futures/data/active_instruments', async () => Object.keys(pairs));
  app.get<{ Querystring: { pair: string } }>('/exchange/v1/derivatives/futures/data/instrument', async (req, reply) => {
    const p = pairs[req.query.pair];
    if (!p) return reply.code(404).send({ message: 'pair not found' });
    return { instrument: p.instrument };
  });
  app.get<{ Querystring: { pair: string } }>('/exchange/v1/derivatives/futures/data/trades', async (req) => {
    const p = priceAt(req.query.pair);
    return Array.from({ length: 20 }, (_, i) => ({ price: p * (1 + (Math.sin(i) * 0.0002)), quantity: 0.01 * (1 + (i % 5)), timestamp: Date.now() - i * 1500, is_maker: i % 2 === 0 }));
  });
  app.get<{ Querystring: { pair: string; from: string; to: string; resolution: string; pcode: string } }>('/market_data/candlesticks', async (req, reply) => {
    const p = pairs[req.query.pair];
    if (!p || req.query.pcode !== 'f') return reply.code(400).send({ s: 'error', message: 'invalid pair/pcode' });
    const res = req.query.resolution === '1D' ? 1440 : Number(req.query.resolution);
    if (!Number.isFinite(res) || res <= 0) return reply.code(400).send({ s: 'error', message: 'invalid resolution' });
    return { s: 'ok', data: aggregate(req.query.pair, Number(req.query.from) * 1000, Number(req.query.to) * 1000, res) };
  });
  app.get<{ Params: { inst: string; depth: string } }>('/market_data/v3/orderbook/:inst/:depth', async (req, reply) => {
    const pair = req.params.inst.replace(/-futures$/, '');
    if (!pairs[pair]) return reply.code(404).send({ message: 'not found' });
    const p = priceAt(pair);
    const step = Number(pairs[pair].instrument.price_increment);
    const depth = Number(req.params.depth) || 10;
    const asks: Record<string, number> = {};
    const bids: Record<string, number> = {};
    for (let i = 1; i <= depth; i++) {
      asks[(Math.ceil(p / step) * step + i * step).toFixed(2)] = +(0.5 * i).toFixed(3);
      bids[(Math.floor(p / step) * step - (i - 1) * step).toFixed(2)] = +(0.5 * i).toFixed(3);
    }
    return { ts: Date.now(), vs: ++seq, asks, bids };
  });
  app.get('/market_data/v3/current_prices/futures/rt', async () => {
    const prices: Record<string, Record<string, number>> = {};
    for (const pair of Object.keys(pairs)) {
      const p = priceAt(pair);
      const p24 = priceAt(pair, Date.now() - 86_400_000);
      prices[pair] = { mp: p, ls: p, fr: 0.0001 * Math.sin(Date.now() / 3_600_000), pc: ((p - p24) / p24) * 100, v: 12345 };
    }
    return { ts: Date.now(), vs: ++seq, prices };
  });

  // ---------------------------------------------------------------- Deribit public reference (subset)
  app.get<{ Querystring: { currency: string; kind?: string } }>('/api/v2/public/get_book_summary_by_currency', async (req, reply) => {
    const pair = Object.keys(pairs).find((k) => pairs[k].u === req.query.currency);
    if (!pair) return reply.code(400).send({ error: { message: 'unknown currency' } });
    const now = Date.now();
    const spot = priceAt(pair);
    const hist = pairs[pair].candles.slice(Math.max(0, idx(now) - 60 * 24 * 7), idx(now) + 1);
    const hourly: Candle[] = [];
    for (let i = 0; i + 60 <= hist.length; i += 60) {
      const w = hist.slice(i, i + 60);
      hourly.push({ t: w[0].t, o: w[0].o, h: Math.max(...w.map((x) => x.h)), l: Math.min(...w.map((x) => x.l)), c: w[w.length - 1].c, v: 1 });
    }
    const rv = yangZhangVol(hourly, Math.min(100, hourly.length - 2), '1h');
    const chain = buildSyntheticChain({
      underlying: req.query.currency,
      spot,
      now,
      surface: { atmIv: Math.max(0.2, (Number.isFinite(rv) ? rv : 0.6) * 1.15), skew: -0.12, smile: 0.4, termSlope: 0.05 },
      spreadPct: 4,
      expiries: standardExpiries(now),
    });
    const fmt = (e: number) => {
      const d = new Date(e);
      return `${d.getUTCDate()}${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
    };
    return {
      jsonrpc: '2.0',
      result: chain.contracts.map((c, i) => ({
        instrument_name: `${req.query.currency}-${fmt(c.expiry)}-${c.strike}-${c.type}`,
        bid_price: c.bid / spot,
        ask_price: c.ask / spot,
        mark_price: c.mark / spot,
        mark_iv: c.iv * 100,
        underlying_price: spot,
        open_interest: 50 + ((i * 37) % 400),
        volume: 5 + ((i * 13) % 60),
        interest_rate: 0,
        creation_timestamp: now,
      })),
    };
  });

  // ---------------------------------------------------------------- authenticated futures
  const settle = (pair: string, side: 'buy' | 'sell', qty: number, px: number, fee: number) => {
    const s = side === 'buy' ? 1 : -1;
    const cur = positions.get(pair) ?? { id: `pos-${pair}`, pair, qty: 0, avg: 0 };
    const nq = cur.qty + s * qty;
    if (cur.qty === 0 || Math.sign(cur.qty) === s) {
      cur.avg = (cur.avg * Math.abs(cur.qty) + px * qty) / Math.abs(nq);
    } else {
      const closed = Math.min(qty, Math.abs(cur.qty));
      balance += closed * (px - cur.avg) * Math.sign(cur.qty);
      if (Math.abs(nq) > 1e-12 && Math.sign(nq) !== Math.sign(cur.qty)) cur.avg = px;
    }
    cur.qty = Math.abs(nq) < 1e-12 ? 0 : nq;
    balance -= fee;
    positions.set(pair, cur);
  };

  const listOrders = (req: { body: Record<string, unknown> }) => orders.filter((x) => !req.body.status || String(req.body.status).split(',').includes(String(x.status))).filter((x) => !req.body.side || x.side === req.body.side).slice(-Number(req.body.size ?? 50)).reverse();
  app.post('/exchange/v1/derivatives/futures/orders', async (req, reply) => (guard(req as never, reply) ? listOrders(req as never) : undefined));
  app.post('/exchange/v1/derivatives/futures/orders/create', async (req, reply) => {
    if (!guard(req as never, reply)) return;
    const o2 = (req.body as { order?: Record<string, unknown> }).order ?? {};
    const pair = String(o2.pair);
    const inst = pairs[pair]?.instrument;
    if (!inst) return reply.code(422).send({ code: 422, message: 'Invalid pair', status: 'error' });
    const qty = Number(o2.total_quantity);
    const step = Number(inst.quantity_increment);
    if (!(qty >= Number(inst.min_quantity)) || Math.abs(Math.round(qty / step) * step - qty) > 1e-9) return reply.code(422).send({ code: 422, message: 'Invalid quantity', status: 'error' });
    const lev = Number(o2.leverage ?? 1);
    if (lev > 25) return reply.code(422).send({ code: 422, message: 'Leverage too high', status: 'error' });
    const px = priceAt(pair) * (o2.side === 'buy' ? 1.0001 : 0.9999);
    const margin = (qty * px) / lev;
    if (margin > balance) return reply.code(422).send({ code: 422, message: 'Insufficient funds', status: 'error' });
    const fee = qty * px * 0.0005;
    const id = `ord-${++seq}`;
    const isMarket = o2.order_type === 'market_order';
    const row = {
      id,
      pair,
      side: o2.side,
      status: isMarket ? 'filled' : 'open',
      order_type: o2.order_type,
      leverage: lev,
      price: Number(o2.price ?? 0),
      avg_price: isMarket ? px : 0,
      total_quantity: qty,
      remaining_quantity: isMarket ? 0 : qty,
      cancelled_quantity: 0,
      fee_amount: isMarket ? fee : 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      client_order_id: o2.client_order_id,
    };
    orders.push(row);
    if (isMarket) {
      settle(pair, o2.side as 'buy' | 'sell', qty, px, fee);
      trades.push({ price: px, quantity: qty, is_maker: false, fee_amount: fee, pair, side: o2.side, timestamp: Date.now(), order_id: id });
    }
    return [row];
  });
  app.post('/exchange/v1/derivatives/futures/orders/cancel', async (req, reply) => {
    if (!guard(req as never, reply)) return;
    const o2 = orders.find((x) => x.id === (req.body as { id: string }).id);
    if (!o2) return reply.code(404).send({ code: 404, message: 'order not found', status: 'error' });
    if (o2.status === 'open') Object.assign(o2, { status: 'cancelled', cancelled_quantity: o2.remaining_quantity, remaining_quantity: 0 });
    return { message: 'success', status: 200, code: 200 };
  });
  app.post('/exchange/v1/derivatives/futures/positions', async (req, reply) => {
    if (!guard(req as never, reply)) return;
    return [...positions.values()].map((p) => ({
      id: p.id,
      pair: p.pair,
      active_pos: p.qty,
      avg_price: p.avg,
      liquidation_price: p.qty > 0 ? p.avg * 0.8 : p.avg * 1.2,
      locked_margin: Math.abs(p.qty) * p.avg * 0.2,
      updated_at: Date.now(),
    }));
  });
  app.post('/exchange/v1/derivatives/futures/positions/exit', async (req, reply) => {
    if (!guard(req as never, reply)) return;
    const p = [...positions.values()].find((x) => x.id === (req.body as { id: string }).id);
    if (p && p.qty !== 0) {
      const px = priceAt(p.pair);
      settle(p.pair, p.qty > 0 ? 'sell' : 'buy', Math.abs(p.qty), px, Math.abs(p.qty) * px * 0.0005);
    }
    return { message: 'success', status: 200, code: 200, data: { group_id: `grp-${++seq}` } };
  });
  app.post('/exchange/v1/derivatives/futures/positions/cancel_all_open_orders', async (req, reply) => {
    if (!guard(req as never, reply)) return;
    for (const o2 of orders) if (o2.status === 'open') o2.status = 'cancelled';
    return { message: 'success', status: 200, code: 200 };
  });
  app.post('/exchange/v1/derivatives/futures/positions/create_tpsl', async (req, reply) => (guard(req as never, reply) ? { stop_loss: { success: true }, take_profit: { success: true } } : undefined));
  app.post('/exchange/v1/derivatives/futures/trades', async (req, reply) => (guard(req as never, reply) ? trades.slice(-50).reverse() : undefined));
  const wallet = async (req: unknown, reply: never) => {
    if (!guard(req as never, reply)) return;
    const locked = [...positions.values()].reduce((a, p) => a + Math.abs(p.qty) * p.avg * 0.2, 0);
    return [{ currency_short_name: 'USDT', balance, locked_balance: locked, cross_order_margin: 0, cross_user_margin: 0 }];
  };
  // Fastify ignores bodies on GET: read the signed JSON body from the raw stream ourselves.
  app.get('/exchange/v1/derivatives/futures/wallets', async (req, reply) => {
    const chunks: Buffer[] = [];
    for await (const c of req.raw) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const r = req as unknown as { rawBody: string; body: unknown };
    r.rawBody = raw;
    r.body = raw ? JSON.parse(raw) : {};
    return wallet(req, reply as never);
  });
  app.post('/exchange/v1/derivatives/futures/wallets', wallet as never);

  await app.listen({ port: o.port ?? 9090, host: '127.0.0.1' });
  return { app, priceAt, positions, orders, getBalance: () => balance };
}

