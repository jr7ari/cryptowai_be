/**
 * Exchange-neutral port for perpetual-futures venues.
 *
 * The engine was built on CoinDCX, so the canonical internal shapes are the CoinDCX ones
 * (CdxInstrument / CdxOrder / CdxPosition / CdxTrade / CdxWalletEntry). Every adapter converts its
 * exchange's payloads into these shapes and - importantly - expresses ALL quantities in units of the
 * underlying asset (e.g. BTC), never in exchange contracts. Delta Exchange trades integer contracts
 * (BTCUSD = 0.001 BTC each); the Delta adapter converts at the boundary so sizing, P&L, paper fills,
 * reconciliation and the exit engine are identical for both venues.
 */
import type { Candle, OrderBook, Timeframe } from '../domain/types.js';
import type { CdxInstrument, CdxOrder, CdxPosition, CdxTrade, CdxWalletEntry } from './coindcx/types.js';
import type { EndpointStats } from './coindcx/rest.js';

export type ExchangeId = 'coindcx' | 'delta';

export const EXCHANGE_LABEL: Record<ExchangeId, string> = { coindcx: 'CoinDCX', delta: 'Delta Exchange' };

export interface CurrentPrice {
  mark?: number;
  last?: number;
  /** funding per funding interval, as a fraction (0.0001 = 0.01%) */
  fundingRate?: number;
  change24h?: number;
  volume24h?: number;
}

export interface PublicTradeRow {
  price: number;
  /** underlying units */
  quantity: number;
  timestamp: number;
  /** true when the BUYER was the maker (i.e. the aggressor sold) */
  is_maker: boolean;
}

export interface CreateOrderInput {
  pair: string;
  side: 'buy' | 'sell';
  order_type: 'market_order' | 'limit_order';
  /** underlying units */
  total_quantity: number;
  price?: number;
  leverage: number;
  time_in_force?: 'good_till_cancel' | 'immediate_or_cancel' | 'fill_or_kill';
  client_order_id?: string;
  reduce_only?: boolean;
}

export interface FuturesExchangeClient {
  readonly exchange: ExchangeId;
  readonly authenticated: boolean;
  readonly breaker: { snapshot(): unknown };
  stats(): EndpointStats[];

  instrument(pair: string, maxAgeMs?: number): Promise<CdxInstrument>;
  candles(pair: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]>;
  orderbook(pair: string, depth?: 10 | 20 | 50): Promise<OrderBook>;
  publicTrades(pair: string): Promise<PublicTradeRow[]>;
  currentPrices(path?: string): Promise<Record<string, CurrentPrice>>;

  listOrders(status: string, side?: 'buy' | 'sell', page?: number, size?: number): Promise<CdxOrder[]>;
  createOrder(o: CreateOrderInput): Promise<CdxOrder[]>;
  cancelOrder(id: string): Promise<void>;
  listPositions(page?: number, size?: number): Promise<CdxPosition[]>;
  exitPosition(positionId: string): Promise<unknown>;
  cancelAllOpenOrders(): Promise<void>;
  trades(params: { pair?: string; orderId?: string; page?: number; size?: number }): Promise<CdxTrade[]>;
  wallets(path?: string, method?: 'GET' | 'POST'): Promise<CdxWalletEntry[]>;

  /** Direct lookups when the exchange supports them (Delta does; preferred over list scans). */
  orderById?(id: string): Promise<CdxOrder | null>;
  orderByClientId?(clientOrderId: string): Promise<CdxOrder | null>;
}

/** Positions created before multi-exchange support carry no tag: they belong to CoinDCX. */
export function positionExchange(p: { exchange?: string }): ExchangeId {
  return (p.exchange as ExchangeId) ?? 'coindcx';
}
