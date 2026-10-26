/**
 * Builds the exchange stack (REST client, optional stream, LIVE venue) for the configured exchange.
 * Used by the server, fetch-history and any CLI so every entry point talks to the same exchange.
 */
import type { AppConfig, Secrets } from '../config/index.js';
import { parseMap } from '../config/index.js';
import { CoinDcxRestClient } from './coindcx/rest.js';
import { CoinDcxSocket } from './coindcx/socket.js';
import { DeltaRestClient, DELTA_URLS, DELTA_WS } from './delta/rest.js';
import { DeltaPublicSocket } from './delta/socket.js';
import type { FuturesExchangeClient } from './exchange.js';
import { EXCHANGE_LABEL } from './exchange.js';
import { LiveFuturesVenue, LiveOptionsVenue, CompositeLiveVenue } from '../execution/live.js';
import type { MarketSocket } from '../marketdata/live.js';
import type { Clock } from '../lib/clock.js';

export function deltaBaseUrl(env: string): string {
  if (/^https?:\/\//.test(env)) return env.replace(/\/+$/, '');
  if (env === 'india-testnet' || env === 'testnet') return DELTA_URLS.indiaTestnet;
  if (env === 'global') return DELTA_URLS.global;
  return DELTA_URLS.india;
}

export function deltaPublicWsUrl(env: string): string {
  if (/^wss?:\/\//.test(env)) return env.replace(/\/+$/, '');
  if (env === 'india-testnet' || env === 'testnet') return DELTA_WS.indiaTestnet;
  if (env === 'global') return DELTA_WS.global;
  return DELTA_WS.india;
}

export interface ExchangeStack {
  id: AppConfig['app']['exchange'];
  label: string;
  client: FuturesExchangeClient;
  socket?: MarketSocket;
  liveVenue?: CompositeLiveVenue;
  marginCurrency: string;
  baseUrls: Record<string, string>;
  credentialsHint: string;
}

export function createExchange(config: AppConfig, secrets: Secrets, clock: Clock): ExchangeStack {
  if (config.app.exchange === 'delta') {
    const baseUrl = deltaBaseUrl(config.delta.environment);
    const client = new DeltaRestClient({
      baseUrl,
      apiKey: secrets.deltaApiKey,
      apiSecret: secrets.deltaApiSecret,
      timeoutMs: config.delta.httpTimeoutMs,
      maxRequestsPerMinute: config.delta.maxRequestsPerMinute,
      marginCurrency: config.delta.marginCurrency,
      clock,
    });
    const liveVenue = client.authenticated
      ? new CompositeLiveVenue(
          new LiveFuturesVenue(client, { maxLeverage: config.risk.maxLeverage, marginCurrency: config.delta.marginCurrency, sendClientOrderId: true }, clock),
          new LiveOptionsVenue(LiveOptionsVenue.DELTA_REASON),
        )
      : undefined;
    const wsUrl = deltaPublicWsUrl(config.delta.environment);
    const socket = new DeltaPublicSocket({
      url: wsUrl,
      symbols: config.delta.symbols,
      contractValue: async (sym) => {
        const inst = await client.instrument(sym).catch(() => undefined);
        return inst?.quantity_increment;
      },
    });
    return {
      id: 'delta',
      label: EXCHANGE_LABEL.delta,
      client,
      socket,
      liveVenue,
      marginCurrency: config.delta.marginCurrency,
      baseUrls: { api: baseUrl, public: baseUrl, socket: wsUrl },
      credentialsHint: 'DELTA_API_KEY / DELTA_API_SECRET',
    };
  }
  const client = new CoinDcxRestClient({
    apiBaseUrl: config.coindcx.apiBaseUrl,
    publicBaseUrl: config.coindcx.publicBaseUrl,
    apiKey: secrets.coindcxApiKey,
    apiSecret: secrets.coindcxApiSecret,
    timeoutMs: config.coindcx.httpTimeoutMs,
    maxRequestsPerMinute: config.coindcx.maxRequestsPerMinute,
    resolutionMap: parseMap(config.coindcx.resolutionMap),
    marginCurrency: config.coindcx.marginCurrency,
    clock,
  });
  const socket = new CoinDcxSocket({ url: config.coindcx.socketUrl, apiKey: secrets.coindcxApiKey, apiSecret: secrets.coindcxApiSecret, pairs: config.app.symbols });
  const liveVenue = client.authenticated
    ? new CompositeLiveVenue(
        new LiveFuturesVenue(
          client,
          {
            maxLeverage: config.risk.maxLeverage,
            marginCurrency: config.coindcx.marginCurrency,
            sendClientOrderId: config.coindcx.sendClientOrderId,
            walletPath: config.coindcx.futuresWalletPath,
            walletMethod: config.coindcx.futuresWalletMethod,
          },
          clock,
        ),
        new LiveOptionsVenue(),
      )
    : undefined;
  return {
    id: 'coindcx',
    label: EXCHANGE_LABEL.coindcx,
    client,
    socket,
    liveVenue,
    marginCurrency: config.coindcx.marginCurrency,
    baseUrls: { api: config.coindcx.apiBaseUrl, public: config.coindcx.publicBaseUrl, socket: config.coindcx.socketUrl },
    credentialsHint: 'COINDCX_API_KEY / COINDCX_API_SECRET',
  };
}
