import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { CoinDcxRestClient, sign, FUTURES_PATHS } from '../src/integrations/coindcx/rest.js';
import { LiveFuturesVenue, LiveOptionsVenue, CompositeLiveVenue } from '../src/execution/live.js';
import { PaperVenue } from '../src/execution/paper.js';
import { OrderManager } from '../src/execution/order-manager.js';
import { MarketQuoter } from '../src/execution/quoter.js';
import { PositionManager } from '../src/portfolio/position-manager.js';
import { Account } from '../src/portfolio/account.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { SimulatedClock } from '../src/lib/clock.js';
import { parseDeribitName } from '../src/integrations/deribit/reference.js';
import { buildStrategy } from '../src/strategies/builders.js';
import { evaluate } from '../src/strategies/evaluate.js';
import { defaultModelParams } from '../src/model/params.js';
import { buildExitPlan } from '../src/risk/engine.js';
import { hardRiskLimits } from '../src/config/index.js';
import type { OrderRequest, RegimeClassification } from '../src/domain/types.js';
import { tradableStrategies } from '../src/execution/venue.js';
import { FakeMarket, gbm, testConfig } from './helpers.js';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function mockFetch(handler: (c: Call) => { status?: number; json?: unknown; throw?: boolean }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(c);
    const r = handler(c);
    if (r.throw) throw new Error('socket hang up');
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const instrument = {
  pair: 'B-BTC_USDT', status: 'active', price_increment: 0.1, quantity_increment: 0.001, min_quantity: 0.001, max_quantity: 100, min_notional: 5,
  max_leverage_long: 20, max_leverage_short: 20,
};

function client(handler: Parameters<typeof mockFetch>[0], clock = new SimulatedClock(1_700_000_000_000)) {
  const m = mockFetch(handler);
  const c = new CoinDcxRestClient({
    apiBaseUrl: 'https://api.coindcx.com', publicBaseUrl: 'https://public.coindcx.com', apiKey: 'key-123456', apiSecret: 'secret-abcdef',
    timeoutMs: 1000, maxRequestsPerMinute: 6000, resolutionMap: { '1h': '60' }, marginCurrency: 'USDT', clock, fetchImpl: m.f,
  });
  return { c, calls: m.calls, clock };
}

describe('CoinDCX REST client', () => {
  it('signs the exact JSON body with HMAC-SHA256 and sends auth headers', async () => {
    const { c, calls } = client(() => ({ json: [] }));
    await c.listPositions();
    const call = calls[0];
    expect(call.url).toBe('https://api.coindcx.com' + FUTURES_PATHS.listPositions);
    expect(call.method).toBe('POST');
    const body = JSON.parse(call.body!);
    expect(body.timestamp).toBe(1_700_000_000_000);
    expect(call.headers['X-AUTH-APIKEY']).toBe('key-123456');
    expect(call.headers['X-AUTH-SIGNATURE']).toBe(createHmac('sha256', 'secret-abcdef').update(call.body!).digest('hex'));
    expect(sign('abc', 'k')).toBe(createHmac('sha256', 'k').update('abc').digest('hex'));
  });
  it('parses candles (seconds or ms timestamps) and orderbook maps', async () => {
    const { c } = client((call) =>
      call.url.includes('candlesticks')
        ? { json: { s: 'ok', data: [{ open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, time: 1_700_000_000 }] } }
        : { json: { ts: 1, vs: 2, asks: { '101': 1, '102': 2 }, bids: { '100': 3, '99': 0 } } },
    );
    const k = await c.candles('B-BTC_USDT', '1h', 0, 1);
    expect(k[0].t).toBe(1_700_000_000_000);
    const ob = await c.orderbook('B-BTC_USDT', 10);
    expect(ob.asks[0].price).toBe(101);
    expect(ob.bids.length).toBe(1);
  });
  it('retries reads on 5xx/429 but not on 4xx', async () => {
    let n = 0;
    const { c } = client(() => (++n < 3 ? { status: 503 } : { json: [] }));
    await expect(c.listPositions()).resolves.toEqual([]);
    expect(n).toBe(3);
    let m = 0;
    const { c: c2 } = client(() => (++m, { status: 400, json: { message: 'bad' } }));
    await expect(c2.listPositions()).rejects.toThrow(/400/);
    expect(m).toBe(1);
  });
});

describe('LIVE futures venue', () => {
  const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({
    clientOrderId: 'c1', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE', side: 'BUY', qty: 0.0123, type: 'MARKET', refPrice: 60000, leverage: 2, ...o,
  });
  const handler = (extra: (c: Call) => { status?: number; json?: unknown; throw?: boolean } | null = () => null) => (c: Call) => {
    const e = extra(c);
    if (e) return e;
    if (c.url.includes('/data/instrument')) return { json: { instrument } };
    if (c.url.includes('/wallets')) return { json: [{ currency_short_name: 'USDT', balance: 1000, locked_balance: 100 }] };
    return { json: [] };
  };
  it('validates against instrument spec: rounds qty down, enforces min qty, notional, leverage and margin', async () => {
    const { c, clock } = client(handler());
    const v = new LiveFuturesVenue(c, { maxLeverage: 3, marginCurrency: 'USDT', sendClientOrderId: false }, clock);
    expect(await v.validate(req())).toMatchObject({ ok: true, qty: 0.012 });
    expect((await v.validate(req({ qty: 0.0004 }))).reason).toMatch(/min_quantity/);
    expect((await v.validate(req({ leverage: 10 }))).reason).toMatch(/leverage/);
    expect((await v.validate(req({ qty: 1 }))).reason).toMatch(/insufficient margin/);
    expect((await v.validate(req({ kind: 'OPTION' }))).ok).toBe(false);
  });
  it('maps a filled order and treats 4xx as REJECTED', async () => {
    const { c, clock } = client(
      handler((call) =>
        call.url.endsWith('/orders/create')
          ? { json: [{ id: 'o1', pair: 'B-BTC_USDT', side: 'buy', status: 'filled', order_type: 'market_order', total_quantity: 0.012, remaining_quantity: 0, avg_price: 60010, fee_amount: 0.36 }] }
          : null,
      ),
    );
    const v = new LiveFuturesVenue(c, { maxLeverage: 3, marginCurrency: 'USDT', sendClientOrderId: false }, clock);
    const st = await v.submit(req({ qty: 0.012 }));
    expect(st).toMatchObject({ status: 'FILLED', filledQty: 0.012, avgPrice: 60010, venueOrderId: 'o1' });
    const { c: c2, clock: k2 } = client(handler((call) => (call.url.endsWith('/orders/create') ? { status: 422, json: { message: 'Insufficient funds' } } : null)));
    const st2 = await new LiveFuturesVenue(c2, { maxLeverage: 3, marginCurrency: 'USDT', sendClientOrderId: false }, k2).submit(req());
    expect(st2.status).toBe('REJECTED');
  });
  it('ambiguous network failure on create is NOT retried; order is located instead', async () => {
    let creates = 0;
    const { c, clock } = client(
      handler((call) => {
        if (call.url.endsWith('/orders/create')) {
          creates++;
          return { throw: true };
        }
        if (call.url.endsWith(FUTURES_PATHS.listOrders) && JSON.parse(call.body!).status === 'filled')
          return { json: [{ id: 'found', pair: 'B-BTC_USDT', side: 'buy', status: 'filled', order_type: 'market_order', total_quantity: 0.0123, remaining_quantity: 0, avg_price: 60000, created_at: 1_700_000_000_000 }] };
        return null;
      }),
    );
    const v = new LiveFuturesVenue(c, { maxLeverage: 3, marginCurrency: 'USDT', sendClientOrderId: false }, clock);
    const st = await v.submit(req());
    expect(creates).toBe(1);
    expect(st.venueOrderId).toBe('found');
    expect(st.status).toBe('FILLED');
  });
  it('options venue refuses with a capability error; composite routes correctly', async () => {
    const o = new LiveOptionsVenue();
    expect((await o.submit(req({ kind: 'OPTION' }))).status).toBe('REJECTED');
    const { c, clock } = client(handler());
    const comp = new CompositeLiveVenue(new LiveFuturesVenue(c, { maxLeverage: 3, marginCurrency: 'USDT', sendClientOrderId: false }, clock), o);
    const tr = tradableStrategies(comp);
    expect(tr.has('FUTURES_LONG')).toBe(true);
    expect(tr.has('LONG_CALL')).toBe(false);
  });
});

describe('Deribit reference parsing', () => {
  it('parses instrument names', () => {
    expect(parseDeribitName('BTC-27DEC24-60000-C')).toEqual({ underlying: 'BTC', expiry: Date.UTC(2024, 11, 27, 8), strike: 60000, type: 'C' });
    expect(parseDeribitName('ETH-5JAN25-3500-P')?.type).toBe('P');
    expect(parseDeribitName('BTC-PERPETUAL')).toBeNull();
  });
});

function paperSetup(seedOverrides: Record<string, number> = {}) {
  const cfg = testConfig();
  const clock = new SimulatedClock(Date.UTC(2025, 3, 1));
  const market = new FakeMarket(clock);
  const candles = gbm(400, { s0: 60000, seed: 3, start: Date.UTC(2025, 3, 1) - 400 * 3_600_000 });
  market.setCandles('B-BTC_USDT', '1h', candles);
  const repos = createMemoryRepositories();
  const underlyingOf = (i: string) => (i.startsWith('BTC') || i === 'B-BTC_USDT' ? 'B-BTC_USDT' : i);
  const venue = new PaperVenue({ ...cfg.paper, partialFillProbability: 0, rejectProbability: 0, ...seedOverrides }, market, clock, underlyingOf, true);
  const orders = new OrderManager(repos, clock, () => venue);
  const account = new Account(repos, clock, 'PAPER', 10_000);
  const pm = new PositionManager({ repos, orders, quoter: new MarketQuoter(market, clock, underlyingOf), account: () => account, clock, mode: () => 'PAPER', fundingRate: () => 0.0001, fundingIntervalHours: 8, optionLimitTolerance: 0.05 });
  return { cfg, clock, market, repos, venue, orders, account, pm };
}

describe('order manager & paper venue', () => {
  it('fills market orders with slippage + fees and records ledgers', async () => {
    const { orders, repos } = paperSetup();
    const st = await orders.execute({ clientOrderId: 'x1', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE', side: 'BUY', qty: 0.01, type: 'MARKET', refPrice: 0 });
    expect(st.status).toBe('FILLED');
    expect(st.fees).toBeGreaterThan(0);
    expect(await repos.fills.count()).toBe(1);
    expect(await repos.orderEvents.count()).toBeGreaterThanOrEqual(2);
    expect((await repos.orderEvents.verifyChain()).ok).toBe(true);
  });
  it('duplicate clientOrderId never places a second order', async () => {
    const { orders, repos } = paperSetup();
    const r = { clientOrderId: 'dup', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE' as const, side: 'BUY' as const, qty: 0.01, type: 'MARKET' as const, refPrice: 0 };
    const a = await orders.execute(r);
    const b = await orders.execute(r);
    expect(b.avgPrice).toBe(a.avgPrice);
    expect(await repos.fills.count()).toBe(1);
  });
  it('partial fills complete on refresh', async () => {
    const { orders } = paperSetup({ partialFillProbability: 1 });
    const st = await orders.execute({ clientOrderId: 'pf', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE', side: 'SELL', qty: 0.02, type: 'MARKET', refPrice: 0 });
    expect(st.status).toBe('FILLED');
    expect(st.fills.length).toBe(2);
    expect(st.filledQty).toBeCloseTo(0.02, 10);
  });
  it('rejections are surfaced, never silently filled', async () => {
    const { orders } = paperSetup({ rejectProbability: 1 });
    const st = await orders.execute({ clientOrderId: 'rj', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE', side: 'BUY', qty: 0.01, type: 'MARKET', refPrice: 0 });
    expect(st.status).toBe('REJECTED');
  });
});

describe('position manager', () => {
  const P = defaultModelParams();
  const regime = { primary: 'RANGING', confidence: 0.8 } as RegimeClassification;
  async function open(strategy: 'IRON_CONDOR' | 'LONG_CALL', env = paperSetup()) {
    const chain = env.market.chain('B-BTC_USDT')!;
    const spot = env.market.lastPrice('B-BTC_USDT')!.price;
    const b = buildStrategy(strategy, P.strategies[strategy], { chain, futuresInstrument: 'B-BTC_USDT', spot, now: env.clock.now(), minDte: 2, maxDte: 45, atr: spot * 0.01 });
    if ('error' in b) throw new Error(b.error);
    const ev = evaluate(b.legs, { spot, now: env.clock.now(), rate: 0, forecastVol: 0.6, drift: 0, holdHours: 72, expiryBufferHours: 12, takeProfitPct: 80, stopLossPct: 50, costs: { optionFeePctOfUnderlying: 0.03, optionFeeCapPctOfPremium: 12.5, futuresTakerFeeBps: 5, slippageBps: 5, fundingIntervalHours: 8 } });
    const cand = { strategy, params: b.params, legs: b.legs, evaluation: ev, score: 1, regimeAffinity: 1, eligible: true, rejectedReasons: [] };
    const exp = b.legs[0].option!.expiry;
    const p = await env.pm.open({ decisionId: `d-${strategy}`, candidate: cand, units: 0.1, underlying: 'B-BTC_USDT', regime, modelVersion: 'm1', exitPlan: buildExitPlan(P, hardRiskLimits(env.cfg), env.clock.now(), exp), features: {} });
    return { p, env };
  }
  it('opens a credit structure BUY legs first, then closes shorts first, and writes an immutable trade', async () => {
    const { p, env } = await open('IRON_CONDOR');
    expect(p.status).toBe('OPEN');
    const orders = await env.repos.orders.listByPosition(p.id);
    const firstTwo = orders.slice(0, 2).map((o) => o.request.side);
    expect(firstTwo).toEqual(['BUY', 'BUY']);
    expect(env.account.book.cash).toBeGreaterThan(10_000 - 5); // received a net credit (minus fees)
    const closed = await env.pm.close(p, 'MANUAL');
    expect(closed.status).toBe('CLOSED');
    const all = await env.repos.orders.listByPosition(p.id);
    const closeSides = all.filter((o) => o.request.reduceOnly).map((o) => o.request.side);
    expect(closeSides.slice(0, 2)).toEqual(['BUY', 'BUY']); // buy back shorts first
    const trades = await env.repos.trades.list();
    expect(trades.length).toBe(1);
    expect(trades[0].realizedPnl).toBeCloseTo(closed.realizedPnl!, 8);
    // cash reconciles with realised P&L
    expect(env.account.book.cash).toBeCloseTo(10_000 + closed.realizedPnl!, 6);
  });
  it('unwinds filled legs when a later leg fails', async () => {
    const env = paperSetup();
    // first (BUY) legs fill, then every subsequent order is rejected
    let n = 0;
    const orig = env.venue.submit.bind(env.venue);
    env.venue.submit = async (r) => {
      n++;
      if (n === 3) {
        const s = await orig({ ...r });
        return { ...s, status: 'REJECTED', filledQty: 0, fills: [], rejectReason: 'test reject' };
      }
      return orig(r);
    };
    const { p } = await open('IRON_CONDOR', env);
    expect(p.status).toBe('FAILED');
    expect(p.exitReason).toMatch(/ENTRY_FAILED/);
    const open_ = await env.repos.positions.listOpen('PAPER');
    expect(open_.length).toBe(0);
  });
  it('paper futures NAV identity: equity = cash + unrealized (unrealized is MTM, not close-out P&L)', async () => {
    const env = paperSetup();
    const spot = env.market.lastPrice('B-BTC_USDT')!.price;
    const b = buildStrategy('FUTURES_SHORT', defaultModelParams().strategies.FUTURES_SHORT, {
      chain: env.market.chain('B-BTC_USDT')!,
      futuresInstrument: 'B-BTC_USDT',
      spot,
      now: env.clock.now(),
      minDte: 2,
      maxDte: 45,
      atr: spot * 0.01,
      bid: spot * 0.999,
      ask: spot * 1.001,
    });
    if ('error' in b) throw new Error(b.error);
    const ev = evaluate(b.legs, {
      spot,
      now: env.clock.now(),
      rate: 0,
      forecastVol: 0.6,
      drift: 0,
      holdHours: 72,
      expiryBufferHours: 12,
      takeProfitPct: 1e9,
      stopLossPct: 50,
      costs: { optionFeePctOfUnderlying: 0.03, optionFeeCapPctOfPremium: 12.5, futuresTakerFeeBps: 5, slippageBps: 5, fundingIntervalHours: 8 },
      stopDistance: b.stopDistance,
      leverage: 2,
    });
    const cand = { strategy: 'FUTURES_SHORT' as const, params: b.params, legs: b.legs, evaluation: ev, score: 1, regimeAffinity: 1, eligible: true, rejectedReasons: [] };
    const p = await env.pm.open({
      decisionId: 'd-fut',
      candidate: cand,
      units: 0.01,
      underlying: 'B-BTC_USDT',
      regime,
      modelVersion: 'm1',
      exitPlan: buildExitPlan(defaultModelParams(), hardRiskLimits(env.cfg), env.clock.now(), null, 'FUTURES_SHORT', 'SELL'),
      features: {},
    });
    expect(p.status).toBe('OPEN');
    expect(p.legs[0].entryPrice).toBeGreaterThan(0);
    expect(p.entryCost).toBeLessThan(0); // signed notional of a short — not a fill price
    const nav = await env.pm.equity(env.account.book.cash);
    expect(nav.equity).toBeCloseTo(env.account.book.cash + nav.unrealized, 8);
    const m = env.pm.mark(p)!;
    expect(m.pnl).toBeLessThan(m.value - 1e-9); // close-out haircut (exit fees) is NOT in NAV
  });
  it('UNKNOWN exchange timeout fails the entry; position is not left OPEN', async () => {
    const env = paperSetup();
    env.venue.submit = async () => {
      throw new Error('exchange timeout');
    };
    const { p } = await open('LONG_CALL', env);
    expect(p.status).toBe('FAILED');
    expect(p.exitReason).toBe('ENTRY_UNKNOWN_ORDER_STATE');
    expect((await env.repos.positions.listOpen('PAPER')).length).toBe(0);
  });
  it('monitor triggers stop-loss exits when the market moves against the position', async () => {
    const { p, env } = await open('LONG_CALL');
    env.market.price.set('B-BTC_USDT', env.market.lastPrice('B-BTC_USDT')!.price * 0.85);
    env.clock.advance(3_600_000);
    await env.pm.monitor(() => null);
    const after = await env.repos.positions.get(p.id);
    expect(after!.status).toBe('CLOSED');
    expect(after!.exitReason).toBe('STOP_LOSS');
  });
});
