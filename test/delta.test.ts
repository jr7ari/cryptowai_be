import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { DeltaRestClient, deltaErrorMessage, deltaQuery, deltaRows, deltaSignature, deltaStatus } from '../src/integrations/delta/rest.js';
import { LiveFuturesVenue } from '../src/execution/live.js';
import { createExchange, deltaBaseUrl, deltaPublicWsUrl } from '../src/integrations/factory.js';
import { DeltaPublicSocket } from '../src/integrations/delta/socket.js';
import type { OrderBook } from '../src/domain/types.js';
import type { MarkTick, PriceTick, TradeTick } from '../src/integrations/coindcx/socket.js';
import { SimulatedClock } from '../src/lib/clock.js';
import type { OrderRequest } from '../src/domain/types.js';
import { testConfig } from './helpers.js';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Protocol double for Delta's REST API (shapes from Delta's official python client + docs). */
function deltaDouble() {
  const calls: Call[] = [];
  const product = { id: 27, symbol: 'BTCUSD', contract_value: '0.001', tick_size: '0.5', state: 'live', trading_status: 'operational', contract_type: 'perpetual_futures', initial_margin: '5' };
  const orders = new Map<number, Record<string, unknown>>();
  let nextId = 1000;
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(c);
    const u = new URL(c.url);
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (u.pathname === '/v2/products/BTCUSD' || u.pathname === '/v2/products/27') return ok(product);
    if (u.pathname === '/v2/history/candles')
      return ok([
        { time: 1_700_003_600, open: 101, high: 102, low: 100, close: 101.5, volume: 10 },
        { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 101, volume: 12 },
      ]);
    if (u.pathname === '/v2/l2orderbook/BTCUSD') return ok({ buy: [{ price: '59999.5', size: 1500 }], sell: [{ price: '60000', size: 2000 }], symbol: 'BTCUSD' });
    if (u.pathname === '/v2/trades/BTCUSD') return ok({ trades: [{ price: '60000', size: 250, buyer_role: 'taker', seller_role: 'maker', timestamp: 1_700_000_000_123_456 }] });
    if (u.pathname === '/v2/tickers') return ok([{ symbol: 'BTCUSD', mark_price: '60010', close: 60000, open: 58800, funding_rate: '0.01', turnover_usd: 123 }]);
    if (u.pathname === '/v2/products/27/orders/leverage') return ok({ leverage: 2 });
    if (u.pathname === '/v2/orders' && c.method === 'POST') {
      const b = JSON.parse(c.body!);
      const id = nextId++;
      const o = { id, product_id: b.product_id, product_symbol: 'BTCUSD', side: b.side, size: b.size, unfilled_size: 0, state: 'closed', order_type: b.order_type, average_fill_price: '60000.5', paid_commission: '1.5', client_order_id: b.client_order_id, reduce_only: b.reduce_only };
      orders.set(id, o);
      return ok(o);
    }
    if (u.pathname.startsWith('/v2/orders/client_order_id/')) {
      const coid = decodeURIComponent(u.pathname.split('/').pop()!);
      const o = [...orders.values()].find((x) => x.client_order_id === coid);
      return o ? ok(o) : new Response(JSON.stringify({ success: false, error: { code: 'not_found' } }), { status: 404 });
    }
    if (u.pathname === '/v2/positions/margined') return ok([{ product_id: 27, product_symbol: 'BTCUSD', size: -7, entry_price: '61000' }]);
    if (u.pathname === '/v2/wallet/balances') return ok([{ asset_id: 3, asset_symbol: 'USD', balance: '1000', available_balance: '800' }]);
    if (u.pathname === '/v2/orders/all' && c.method === 'DELETE') return ok({});
    return new Response(JSON.stringify({ success: false, error: { code: 'unhandled', path: u.pathname } }), { status: 400 });
  }) as unknown as typeof fetch;
  return { f, calls, orders };
}

function client(fetchImpl: typeof fetch, auth = true) {
  return new DeltaRestClient({
    baseUrl: 'https://api.india.delta.exchange',
    apiKey: auth ? 'dk-123' : undefined,
    apiSecret: auth ? 'ds-456' : undefined,
    timeoutMs: 1000,
    maxRequestsPerMinute: 6000,
    marginCurrency: 'USD',
    clock: new SimulatedClock(1_700_000_000_000),
    fetchImpl,
  });
}

describe('Delta Exchange REST adapter', () => {
  it('signs METHOD + timestamp(seconds) + path + ?query + body exactly like the official python client', async () => {
    expect(deltaQuery({ product_id: 1, state: 'open' })).toBe('?product_id=1&state=open');
    expect(deltaQuery({ states: 'open,pending' })).toBe('?states=open%2Cpending');
    expect(deltaQuery()).toBe('');
    const d = deltaDouble();
    await client(d.f).wallets();
    const c = d.calls.find((x) => x.url.includes('/v2/wallet/balances'))!;
    expect(c.headers['api-key']).toBe('dk-123');
    expect(c.headers['User-Agent']).toBe('rest-client');
    expect(c.headers.timestamp).toBe('1700000000');
    expect(c.headers.signature).toBe(createHmac('sha256', 'ds-456').update('GET1700000000/v2/wallet/balances').digest('hex'));
    expect(deltaSignature('s', 'GET', '1542110948', '/v2/orders', '?product_id=1&state=open', '')).toBe(
      createHmac('sha256', 's').update('GET1542110948/v2/orders?product_id=1&state=open').digest('hex'),
    );
  });

  it('converts contracts to underlying units everywhere (BTCUSD = 0.001 BTC per contract)', async () => {
    const d = deltaDouble();
    const c = client(d.f);
    const inst = await c.instrument('BTCUSD');
    expect(inst.quantity_increment).toBe(0.001);
    expect(inst.min_quantity).toBe(0.001);
    expect(inst.price_increment).toBe(0.5);
    expect(inst.status).toBe('active');
    expect(inst.max_leverage_long).toBe(20); // 100 / 5% initial margin
    const ob = await c.orderbook('BTCUSD');
    expect(ob.bids[0]).toEqual({ price: 59999.5, qty: 1.5 });
    expect(ob.asks[0].qty).toBe(2);
    const [t] = await c.publicTrades('BTCUSD');
    expect(t.quantity).toBeCloseTo(0.25);
    expect(t.timestamp).toBe(1_700_000_000_123);
    expect(t.is_maker).toBe(false);
    const [pos] = await c.listPositions();
    expect(pos.active_pos).toBeCloseTo(-0.007);
    expect(pos.pair).toBe('BTCUSD');
  });

  it('candles are ascending, in ms; funding converts from percent to a fraction', async () => {
    const d = deltaDouble();
    const c = client(d.f, false);
    const k = await c.candles('BTCUSD', '1h', 1_700_000_000_000, 1_700_007_200_000);
    expect(k.map((x) => x.t)).toEqual([1_700_000_000_000, 1_700_003_600_000]);
    expect(d.calls[0].url).toContain('resolution=1h&symbol=BTCUSD&start=1700000000&end=1700007200');
    const px = await c.currentPrices();
    expect(px.BTCUSD.fundingRate).toBeCloseTo(0.0001);
    expect(px.BTCUSD.change24h).toBeCloseTo(((60000 - 58800) / 58800) * 100);
  });

  it('maps Delta order states to the venue vocabulary without double-counting cancelled size', () => {
    expect(deltaStatus({ state: 'open', size: 10, unfilled_size: 10 })).toBe('open');
    expect(deltaStatus({ state: 'open', size: 10, unfilled_size: 4 })).toBe('partially_filled');
    expect(deltaStatus({ state: 'closed', size: 10, unfilled_size: 0 })).toBe('filled');
    expect(deltaStatus({ state: 'cancelled', size: 10, unfilled_size: 10 })).toBe('cancelled');
    expect(deltaStatus({ state: 'cancelled', size: 10, unfilled_size: 3 })).toBe('partially_cancelled');
  });

  it('LIVE venue sends integer contracts with reduce_only + client_order_id, sets leverage first, and reads fills back in BTC', async () => {
    const d = deltaDouble();
    const c = client(d.f);
    const v = new LiveFuturesVenue(c, { maxLeverage: 3, marginCurrency: 'USD', sendClientOrderId: true }, new SimulatedClock(1_700_000_000_000));
    expect(v.name).toBe('delta-futures');
    const req: OrderRequest = { clientOrderId: 'ch-abc', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'BTCUSD', kind: 'FUTURE', side: 'BUY', qty: 0.0129, type: 'MARKET', refPrice: 60000, leverage: 2 };
    const val = await v.validate(req);
    expect(val.ok).toBe(true);
    expect(val.qty).toBeCloseTo(0.012); // floored to whole contracts
    const st = await v.submit({ ...req, qty: val.qty! });
    const post = d.calls.filter((x) => x.method === 'POST');
    expect(post[0].url).toContain('/v2/products/27/orders/leverage');
    const body = JSON.parse(post[1].body!);
    expect(body).toMatchObject({ product_id: 27, size: 12, side: 'buy', order_type: 'market_order', reduce_only: false, client_order_id: 'ch-abc' });
    expect(st.status).toBe('FILLED');
    expect(st.filledQty).toBeCloseTo(0.012);
    expect(st.avgPrice).toBe(60000.5);
    expect(st.fees).toBe(1.5);
    // exits are reduce-only and do not touch leverage
    await v.submit({ ...req, clientOrderId: 'ch-close', side: 'SELL', qty: 0.012, reduceOnly: true });
    const last = JSON.parse(d.calls.filter((x) => x.method === 'POST').pop()!.body!);
    expect(last.reduce_only).toBe(true);
    expect(d.calls.filter((x) => x.url.includes('/orders/leverage')).length).toBe(1);
  });

  it('an ambiguous submission is resolved by client_order_id lookup, never resubmitted', async () => {
    const d = deltaDouble();
    const inner = d.f;
    let fail = true;
    const flaky = (async (url: string, init: RequestInit) => {
      const r = await inner(url, init);
      if (fail && String(url).endsWith('/v2/orders') && init.method === 'POST') {
        fail = false;
        throw new Error('socket hang up'); // order WAS created by the double, response lost
      }
      return r;
    }) as unknown as typeof fetch;
    const v = new LiveFuturesVenue(client(flaky), { maxLeverage: 3, marginCurrency: 'USD', sendClientOrderId: true }, new SimulatedClock(1_700_000_000_000));
    const st = await v.submit({ clientOrderId: 'ch-amb', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'BTCUSD', kind: 'FUTURE', side: 'BUY', qty: 0.005, type: 'MARKET', refPrice: 60000, leverage: 1 });
    expect(st.status).toBe('FILLED');
    expect(d.orders.size).toBe(1);
  });

  it('wallet: locked = balance - available; venue balances in USD', async () => {
    const d = deltaDouble();
    const v = new LiveFuturesVenue(client(d.f), { maxLeverage: 3, marginCurrency: 'USD', sendClientOrderId: true }, new SimulatedClock(1_700_000_000_000));
    expect(await v.balances()).toEqual({ equity: 1000, cash: 1000, marginInUse: 200, currency: 'USD' });
  });

  it('formats IP-whitelist / bad-key errors the operator can act on', async () => {
    expect(deltaErrorMessage({ error: { code: 'ip_not_whitelisted_for_api_key', context: { client_ip: '103.58.155.89' } } }, 'x')).toMatch(
      /103\.58\.155\.89.*API Keys/,
    );
    expect(deltaErrorMessage({ error: { code: 'invalid_api_key' } }, 'x')).toMatch(/wrong environment/);
    expect(deltaRows({ orders: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(deltaRows([{ id: 2 }])).toEqual([{ id: 2 }]);
    const deny = (async () =>
      new Response(JSON.stringify({ success: false, error: { code: 'ip_not_whitelisted_for_api_key', context: { client_ip: '1.2.3.4' } } }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(client(deny).wallets()).rejects.toThrow(/1\.2\.3\.4/);
  });

  it('cancel-all signs an empty body; client_order_id is capped at 32 chars', async () => {
    const d = deltaDouble();
    const c = client(d.f);
    await c.cancelAllOpenOrders();
    const all = d.calls.find((x) => x.url.endsWith('/v2/orders/all'))!;
    expect(all.method).toBe('DELETE');
    expect(all.body).toBeUndefined();
    expect(all.headers.signature).toBe(createHmac('sha256', 'ds-456').update('DELETE1700000000/v2/orders/all').digest('hex'));
    await c.createOrder({ pair: 'BTCUSD', side: 'buy', order_type: 'market_order', total_quantity: 0.001, leverage: 1, client_order_id: 'x'.repeat(40) });
    const post = d.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/v2/orders')).pop()!;
    expect(JSON.parse(post.body!).client_order_id).toHaveLength(32);
  });
});

describe('exchange selection', () => {
  it('EXCHANGE=delta switches the traded symbols and builds the Delta stack (PAPER without keys)', () => {
    const cfg = testConfig({ app: { exchange: 'delta' } });
    expect(cfg.app.symbols).toEqual(['BTCUSD', 'ETHUSD']);
    expect(cfg.app.underlyingMap).toBe('BTCUSD:BTC,ETHUSD:ETH');
    const ex = createExchange(cfg, { mongoUri: 'x' }, new SimulatedClock(0));
    expect(ex.id).toBe('delta');
    expect(ex.client.exchange).toBe('delta');
    expect(ex.liveVenue).toBeUndefined();
    expect(ex.socket).toBeDefined();
    expect(ex.baseUrls.socket).toBe('wss://public-socket.india.delta.exchange');
    const withKeys = createExchange(cfg, { mongoUri: 'x', deltaApiKey: 'k', deltaApiSecret: 's' }, new SimulatedClock(0));
    expect(withKeys.liveVenue?.capabilities().futures).toBe(true);
    expect(withKeys.liveVenue?.capabilities().options).toBe(false);
  });
  it('default stays CoinDCX with its own symbols', () => {
    const cfg = testConfig();
    expect(cfg.app.exchange).toBe('coindcx');
    expect(cfg.app.symbols).toEqual(['B-BTC_USDT', 'B-ETH_USDT']);
    expect(createExchange(cfg, { mongoUri: 'x' }, new SimulatedClock(0)).id).toBe('coindcx');
  });
  it('environment names map to official base URLs', () => {
    expect(deltaBaseUrl('india')).toBe('https://api.india.delta.exchange');
    expect(deltaBaseUrl('india-testnet')).toBe('https://cdn-ind.testnet.deltaex.org');
    expect(deltaBaseUrl('global')).toBe('https://api.delta.exchange');
    expect(deltaBaseUrl('https://x.example/')).toBe('https://x.example');
    expect(deltaPublicWsUrl('india')).toBe('wss://public-socket.india.delta.exchange');
    expect(deltaPublicWsUrl('india-testnet')).toBe('wss://socket-ind-pub.testnet.deltaex.org');
  });
});

class FakeWs {
  static last: FakeWs | undefined;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWs.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'test' });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe('Delta public websocket', () => {
  it('subscribes to trades + L1/L2 and converts contract sizes to BTC', async () => {
    const sock = new DeltaPublicSocket({
      url: 'wss://public-socket.india.delta.exchange',
      symbols: ['BTCUSD'],
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    const prices: PriceTick[] = [];
    const trades: TradeTick[] = [];
    const books: OrderBook[] = [];
    const marks: MarkTick[] = [];
    sock.on('price', (t) => prices.push(t));
    sock.on('trade', (t) => trades.push(t));
    sock.on('book', (t) => books.push(t));
    sock.on('mark', (t) => marks.push(t));
    await sock.connect();
    FakeWs.last!.open();
    const sub = FakeWs.last!.sent.map((s) => JSON.parse(s));
    expect(sub[0]).toEqual({ type: 'enable_heartbeat' });
    const channels = (sub[1].payload.channels as Array<{ name: string }>).map((c) => c.name);
    expect(channels).toEqual(expect.arrayContaining(['trades', 'ob_l1', 'ob_l2', 'ticker', 'mark_price', 'funding_rate']));
    FakeWs.last!.push({ type: 'trades', p: '80100.5', r: 't', s: 3, sy: 'BTCUSD', t: 1_700_000_000_000_000 });
    expect(trades[0]).toMatchObject({ pair: 'BTCUSD', price: 80100.5, qty: 0.003, isMaker: false });
    expect(prices[0].price).toBe(80100.5);
    FakeWs.last!.push({
      type: 'ob_l2',
      sy: 'BTCUSD',
      ts: 1_700_000_000_000_000,
      b: [['80099.5', '1500']],
      a: [['80100', '2000']],
    });
    expect(books[0].bids[0]).toEqual({ price: 80099.5, qty: 1.5 });
    expect(books[0].asks[0].qty).toBe(2);
    FakeWs.last!.push({ type: 'mark_price', sy: 'MARK:BTCUSD', p: '80110', ts: 1_700_000_000_000_000 });
    expect(marks[0]).toMatchObject({ pair: 'BTCUSD', mark: 80110 });
    FakeWs.last!.push({ type: 'funding_rate', sy: 'BTCUSD', fr: 0.01, ts: 1_700_000_000_000_000 });
    expect(marks.at(-1)?.fundingRate).toBeCloseTo(0.0001);
    sock.close();
  });
});
