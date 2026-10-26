import type { Mode, OrderRequest, OrderState, StrategyName } from '../domain/types.js';
import { STRATEGIES } from '../domain/types.js';

export interface VenueBalances {
  equity: number;
  cash: number;
  marginInUse: number;
  currency: string;
}

export interface VenuePosition {
  instrument: string;
  /** signed quantity: + long, - short */
  qty: number;
  avgPrice: number;
  venuePositionId?: string;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  qty?: number;
  price?: number;
}

/**
 * Common execution interface implemented by PAPER and LIVE venues. The rest of the engine never
 * knows which one it talks to - which is what makes paper results representative of live behaviour.
 */
export interface ExecutionVenue {
  readonly name: string;
  readonly mode: Mode;
  capabilities(): { options: boolean; futures: boolean; reason?: string };
  validate(req: OrderRequest): Promise<ValidationResult>;
  /** Submit; must not throw for business rejects (returns REJECTED). Network ambiguity -> status UNKNOWN. */
  submit(req: OrderRequest): Promise<OrderState>;
  refresh(o: OrderState): Promise<OrderState>;
  cancel(o: OrderState): Promise<OrderState>;
  balances(): Promise<VenueBalances>;
  positions(): Promise<VenuePosition[]>;
  /** Emergency: cancel all working orders and flatten everything this venue holds. */
  emergencyFlatten(reason: string): Promise<void>;
  /** LIVE readiness: fetch & validate the instrument specification (fail-closed if absent). */
  checkInstrument?(instrument: string): Promise<{ ok: boolean; detail: string }>;
}

/** Strategies a venue can trade, derived from its verified capabilities. */
export function tradableStrategies(v: ExecutionVenue): Set<StrategyName> {
  const caps = v.capabilities();
  return new Set(
    STRATEGIES.filter((s) => (s.startsWith('FUTURES_') ? caps.futures : caps.options)),
  );
}

export function newOrderState(req: OrderRequest, now: number): OrderState {
  return { request: req, status: 'PENDING_NEW', filledQty: 0, avgPrice: 0, fees: 0, fills: [], createdAt: now, updatedAt: now };
}
