/**
 * Exchange views for the dashboard (CoinDCX or Delta Exchange, whichever this process connected to): market overview (instrument specs, prices, funding, 24h
 * stats), order book, public trades, the authenticated futures account (wallet, positions, open
 * orders, fills) and per-endpoint API health telemetry. All read-only.
 */
import type { FastifyInstance } from 'fastify';
import type { FuturesExchangeClient } from '../integrations/exchange.js';
import type { ExchangeInfo } from './server.js';
import { FUTURES_PATHS } from '../integrations/coindcx/rest.js';
import type { AppConfig } from '../config/index.js';
import { parseMap } from '../config/index.js';
import type { MarketView } from '../marketdata/view.js';
import { LiveOptionsVenue } from '../execution/live.js';

export interface ExchangeDeps {
  config: AppConfig;
  exchange?: FuturesExchangeClient;
  exchangeInfo?: ExchangeInfo;
  market: MarketView & { stats?: (s: string) => { change24h?: number; volume24h?: number; ts: number } | null; socketStatus?: () => unknown };
}

/** Catalogue of CoinDCX endpoints the engine uses and how each was verified. */
export const ENDPOINT_CATALOGUE = [
  { name: 'Active instruments', method: 'GET', path: FUTURES_PATHS.activeInstruments, auth: false, verified: 'official docs + Futures API PDF', usedFor: 'instrument discovery' },
  { name: 'Instrument details', method: 'GET', path: FUTURES_PATHS.instrument, auth: false, verified: 'official docs + PDF', usedFor: 'qty/price increments, min qty/notional, max leverage (pre-trade validation)' },
  { name: 'Public trades', method: 'GET', path: FUTURES_PATHS.tradesPublic, auth: false, verified: 'official docs + PDF', usedFor: 'market tape' },
  { name: 'Candlesticks', method: 'GET', path: 'public: ' + FUTURES_PATHS.candles + '?pcode=f', auth: false, verified: 'official docs + PDF', usedFor: 'all indicators, regimes, backtests' },
  { name: 'Order book', method: 'GET', path: 'public: /market_data/v3/orderbook/{pair}-futures/{depth}', auth: false, verified: 'official docs + PDF', usedFor: 'bid/ask, spread, paper fills' },
  { name: 'Current prices (RT)', method: 'GET', path: 'public: /market_data/v3/current_prices/futures/rt', auth: false, verified: 'docs TOC (Get Current Prices RT); fields parsed defensively', usedFor: 'mark price, funding, 24h stats' },
  { name: 'List orders', method: 'POST', path: FUTURES_PATHS.listOrders, auth: true, verified: 'official docs + PDF', usedFor: 'order status, reconcile-before-retry' },
  { name: 'Create order', method: 'POST', path: FUTURES_PATHS.createOrder, auth: true, verified: 'official docs + PDF', usedFor: 'LIVE futures entries/exits' },
  { name: 'Cancel order', method: 'POST', path: FUTURES_PATHS.cancelOrder, auth: true, verified: 'official docs + PDF', usedFor: 'timeouts, cancel remainder' },
  { name: 'List positions', method: 'POST', path: FUTURES_PATHS.listPositions, auth: true, verified: 'official docs + PDF', usedFor: 'reconciliation' },
  { name: 'Exit position', method: 'POST', path: FUTURES_PATHS.exitPosition, auth: true, verified: 'official docs + PDF', usedFor: 'emergency flatten' },
  { name: 'Cancel all open orders', method: 'POST', path: FUTURES_PATHS.cancelAllOpenOrders, auth: true, verified: 'official docs + PDF', usedFor: 'emergency flatten' },
  { name: 'Create TP/SL', method: 'POST', path: FUTURES_PATHS.createTpSl, auth: true, verified: 'official docs + PDF', usedFor: 'optional exchange-side stops' },
  { name: 'Trades (fills)', method: 'POST', path: FUTURES_PATHS.trades, auth: true, verified: 'official docs + PDF', usedFor: 'fill history' },
  { name: 'Wallet details', method: 'GET (signed body)', path: FUTURES_PATHS.wallets, auth: true, verified: 'docs TOC; path/method configurable, falls back GET<->POST', usedFor: 'balance, margin, LIVE readiness' },
  { name: 'Socket.IO stream', method: 'WS', path: 'wss://stream.coindcx.com', auth: false, verified: 'official docs + PDF (socket.io-client 2.4.0)', usedFor: 'LTP, mark, private order/position/balance updates' },
  { name: 'Options trading', method: '-', path: '(none published)', auth: true, verified: 'NOT AVAILABLE - options are app-only on CoinDCX', usedFor: LiveOptionsVenue.REASON },
];

/** Delta Exchange endpoints used by the engine (verified against Delta's official python client 1.0.14 + docs). */
export const DELTA_ENDPOINT_CATALOGUE = [
  { name: 'Product (contract spec)', method: 'GET', path: '/v2/products/{symbol}', auth: false, verified: 'official python client + docs', usedFor: 'contract_value (qty conversion), tick_size, state, leverage limits' },
  { name: 'Candles', method: 'GET', path: '/v2/history/candles?resolution&symbol&start&end', auth: false, verified: 'official python client + docs', usedFor: 'all indicators, regimes, backtests' },
  { name: 'L2 order book', method: 'GET', path: '/v2/l2orderbook/{symbol}', auth: false, verified: 'official python client + docs', usedFor: 'bid/ask, spread, paper fills (sizes converted from contracts)' },
  { name: 'Public trades', method: 'GET', path: '/v2/trades/{symbol}', auth: false, verified: 'official python client + docs', usedFor: 'market tape' },
  { name: 'Tickers (perpetuals)', method: 'GET', path: '/v2/tickers?contract_types=perpetual_futures', auth: false, verified: 'docs', usedFor: 'mark price, funding (percent -> fraction), 24h stats' },
  { name: 'Set leverage', method: 'POST', path: '/v2/products/{product_id}/orders/leverage', auth: true, verified: 'official python client', usedFor: 'leverage before entries' },
  { name: 'Place order', method: 'POST', path: '/v2/orders', auth: true, verified: 'official python client + docs', usedFor: 'LIVE futures entries/exits (integer contracts, reduce_only, client_order_id)' },
  { name: 'Cancel order', method: 'DELETE', path: '/v2/orders', auth: true, verified: 'official python client + docs', usedFor: 'timeouts, cancel remainder' },
  { name: 'Cancel all', method: 'DELETE', path: '/v2/orders/all', auth: true, verified: 'official python client', usedFor: 'emergency flatten' },
  { name: 'Order by id / client id', method: 'GET', path: '/v2/orders/{id}, /v2/orders/client_order_id/{id}', auth: true, verified: 'official python client', usedFor: 'fill status, reconcile-before-retry' },
  { name: 'Open orders / history', method: 'GET', path: '/v2/orders, /v2/orders/history', auth: true, verified: 'official python client + docs', usedFor: 'reconciliation' },
  { name: 'Margined positions', method: 'GET', path: '/v2/positions/margined', auth: true, verified: 'official python client', usedFor: 'reconciliation, emergency flatten (reduce-only market)' },
  { name: 'Fills', method: 'GET', path: '/v2/fills', auth: true, verified: 'official python client', usedFor: 'fill history' },
  { name: 'Wallet balances', method: 'GET', path: '/v2/wallet/balances', auth: true, verified: 'official python client', usedFor: 'balance, margin, LIVE readiness' },
  { name: 'WebSocket stream', method: 'WS', path: 'wss://public-socket.india.delta.exchange', auth: false, verified: 'docs (public channels ticker, ob_l1, ob_l2, trades, mark_price, funding_rate)', usedFor: 'tick-by-tick LTP, top-of-book, L2 for paper fills; REST is fallback if the stream is stale' },
  { name: 'Options trading', method: '-', path: '(API exists; adapter not implemented)', auth: true, verified: '-', usedFor: LiveOptionsVenue.DELTA_REASON },
];

export function registerExchangeRoutes(app: FastifyInstance, d: ExchangeDeps) {
  const ex = d.exchange;
  const isDelta = d.config.app.exchange === 'delta';
  const label = d.exchangeInfo?.label ?? (isDelta ? 'Delta Exchange' : 'CoinDCX');
  const marginCurrency = d.exchangeInfo?.marginCurrency ?? (isDelta ? d.config.delta.marginCurrency : d.config.coindcx.marginCurrency);

  app.get('/api/exchange/info', async () => ({
    exchange: d.config.app.exchange,
    label,
    symbols: d.config.app.symbols,
    authenticated: !!ex?.authenticated,
    credentials: d.exchangeInfo?.credentialsHint,
    marginCurrency,
    switchHint: 'Restart with `npm run dev` and choose the exchange, or set EXCHANGE=coindcx|delta.',
  }));

  app.get('/api/exchange/endpoints', async () => ({
    exchange: d.config.app.exchange,
    label,
    authenticated: !!ex?.authenticated,
    baseUrls: d.exchangeInfo?.baseUrls ?? { api: d.config.coindcx.apiBaseUrl, public: d.config.coindcx.publicBaseUrl, socket: d.config.coindcx.socketUrl },
    socket: d.market.socketStatus?.() ?? null,
    breaker: ex?.breaker.snapshot() ?? null,
    catalogue: isDelta ? DELTA_ENDPOINT_CATALOGUE : ENDPOINT_CATALOGUE,
    telemetry: ex?.stats() ?? [],
  }));

  app.get('/api/exchange/overview', async () => {
    const rows = [];
    for (const s of d.config.app.symbols) {
      let instrument: unknown = null;
      let instrumentError: string | undefined;
      if (ex) {
        try {
          instrument = await ex.instrument(s);
        } catch (e) {
          instrumentError = (e as Error).message;
        }
      }
      const px = d.market.lastPrice(s);
      const tob = d.market.topOfBook(s);
      const mk = d.market.mark(s);
      const st = d.market.stats?.(s) ?? null;
      const mid = tob ? (tob.bid + tob.ask) / 2 : undefined;
      rows.push({
        symbol: s,
        underlying: parseMap(d.config.app.underlyingMap)[s] ?? null,
        price: px?.price ?? null,
        priceTs: px?.ts ?? null,
        bid: tob?.bid ?? null,
        ask: tob?.ask ?? null,
        spreadBps: tob && mid ? ((tob.ask - tob.bid) / mid) * 10_000 : null,
        mark: mk?.mark ?? null,
        fundingRate: mk?.fundingRate ?? null,
        fundingAnnualPct:
          mk?.fundingRate !== undefined
            ? mk.fundingRate * (24 / (Number((instrument as { funding_frequency?: number } | null)?.funding_frequency) || 8)) * 365 * 100
            : null,
        change24hPct: st?.change24h ?? null,
        volume24h: st?.volume24h ?? null,
        dataAgeMs: Number.isFinite(d.market.dataAgeMs(s)) ? d.market.dataAgeMs(s) : null,
        instrument,
        instrumentError,
      });
    }
    return rows;
  });

  app.get<{ Params: { symbol: string }; Querystring: { depth?: string } }>('/api/exchange/orderbook/:symbol', async (req, reply) => {
    if (!ex) return reply.code(503).send({ error: 'exchange client unavailable' });
    if (!d.config.app.symbols.includes(req.params.symbol)) return reply.code(404).send({ error: 'unknown symbol' });
    const depth = ([10, 20, 50] as const).find((x) => x === Number(req.query.depth)) ?? 20;
    const ob = await ex.orderbook(req.params.symbol, depth);
    return { ...ob, bids: ob.bids.slice(0, depth), asks: ob.asks.slice(0, depth) };
  });

  app.get<{ Params: { symbol: string } }>('/api/exchange/trades/:symbol', async (req, reply) => {
    if (!ex) return reply.code(503).send({ error: 'exchange client unavailable' });
    if (!d.config.app.symbols.includes(req.params.symbol)) return reply.code(404).send({ error: 'unknown symbol' });
    return (await ex.publicTrades(req.params.symbol)).slice(0, 50);
  });

  /** Authenticated futures account straight from CoinDCX (each section fails independently). */
  app.get('/api/exchange/account', async () => {
    if (!ex?.authenticated) return { authenticated: false, message: `${d.exchangeInfo?.credentialsHint ?? 'API key'} not configured for ${label}: PAPER only` };
    const settle = async <T>(fn: () => Promise<T>) => {
      try {
        return { ok: true as const, data: await fn() };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
    };
    const [wallet, positions, openOrders, fills] = await Promise.all([
      settle(() => ex.wallets(d.config.coindcx.futuresWalletPath, d.config.coindcx.futuresWalletMethod)),
      settle(() => ex.listPositions(1, 100)),
      settle(() => ex.listOrders('open', undefined, 1, 50)),
      settle(() => ex.trades({ page: 1, size: 50 })),
    ]);
    return { authenticated: true, exchange: d.config.app.exchange, marginCurrency, wallet, positions, openOrders, fills };
  });
}
