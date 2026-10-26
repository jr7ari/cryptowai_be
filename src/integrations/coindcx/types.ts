/**
 * CoinDCX futures API shapes. Field names verified against the official CoinDCX Futures API
 * documentation (docs.coindcx.com "Futures End Points" and CoinDCX-Futures-API.pdf). Fields we do
 * not rely on are typed loosely; everything is validated at runtime with zod in rest.ts.
 */
export interface CdxInstrument {
  pair: string;
  status: string;
  kind?: string;
  settle_currency_short_name?: string;
  quote_currency_short_name?: string;
  position_currency_short_name?: string;
  underlying_currency_short_name?: string;
  max_leverage_long?: number;
  max_leverage_short?: number;
  unit_contract_value?: number;
  price_increment: number;
  quantity_increment: number;
  min_trade_size?: number;
  min_price?: number;
  max_price?: number;
  min_quantity: number;
  max_quantity?: number;
  min_notional?: number;
  maker_fee?: number;
  taker_fee?: number;
  max_market_order_quantity?: number;
  funding_frequency?: number;
  max_notional?: number;
  expiry_time?: number;
  time_in_force_options?: string[];
  order_types?: string[];
  is_inverse?: boolean;
  is_quanto?: boolean;
}

export interface CdxOrder {
  id: string;
  pair: string;
  side: 'buy' | 'sell';
  status: string;
  order_type: string;
  leverage?: number;
  maker_fee?: number;
  taker_fee?: number;
  fee_amount?: number;
  price?: number;
  stop_price?: number;
  avg_price?: number;
  total_quantity: number;
  remaining_quantity?: number;
  cancelled_quantity?: number;
  ideal_margin?: number;
  order_category?: string | null;
  stage?: string;
  group_id?: string | null;
  display_message?: string | null;
  created_at?: number;
  updated_at?: number;
  client_order_id?: string;
}

export interface CdxPosition {
  id: string;
  pair: string;
  active_pos: number;
  inactive_pos_buy?: number;
  inactive_pos_sell?: number;
  avg_price?: number;
  liquidation_price?: number;
  locked_margin?: number;
  locked_user_margin?: number;
  locked_order_margin?: number;
  take_profit_trigger?: number | null;
  stop_loss_trigger?: number | null;
  updated_at?: number;
}

export interface CdxTrade {
  price: number;
  quantity: number;
  is_maker: boolean;
  fee_amount?: number;
  pair: string;
  side: 'buy' | 'sell';
  timestamp: number;
  order_id: string;
}

export interface CdxWalletEntry {
  currency_short_name: string;
  balance: number;
  locked_balance?: number;
  [k: string]: unknown;
}

/** CoinDCX order statuses -> internal statuses. `untriggered` only applies to TP/SL orders. */
export function mapOrderStatus(s: string): import('../../domain/types.js').OrderStatus {
  switch (s) {
    case 'open':
    case 'initial':
    case 'untriggered':
      return 'NEW';
    case 'partially_filled':
      return 'PARTIALLY_FILLED';
    case 'filled':
      return 'FILLED';
    case 'cancelled':
    case 'partially_cancelled':
      return 'CANCELLED';
    case 'rejected':
      return 'REJECTED';
    default:
      return 'UNKNOWN';
  }
}
