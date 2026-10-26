/**
 * PAPER venue: realistic fill simulation against live (or historical) quotes.
 *  - latency (base + jitter) before the order "reaches" the book; quotes are re-read after latency
 *  - market orders cross the spread + slippage bps + size-dependent impact
 *  - limit orders fill only if marketable after latency (else rest until refresh/cancel)
 *  - random partial fills (remainder filled on later refresh at the then-current price) and rejects
 *  - fees: futures taker/maker bps; options Deribit-like (pct of underlying capped by pct of premium)
 *  - funding accrues on futures positions (applied by the portfolio service)
 * Deterministic given the seed, so backtests are reproducible.
 */
import type { OrderRequest, OrderState, Fill, Mode } from '../domain/types.js';
import type { ExecutionVenue, ValidationResult, VenueBalances, VenuePosition } from './venue.js';
import { newOrderState } from './venue.js';
import type { MarketView } from '../marketdata/view.js';
import type { Clock } from '../lib/clock.js';
import { mulberry32 } from '../lib/math.js';
import { MarketQuoter, parseOptionSymbol, type Quote } from './quoter.js';
import { optionFee } from '../strategies/evaluate.js';

export interface PaperConfig {
  latencyMs: number;
  latencyJitterMs: number;
  slippageBps: number;
  impactBpsPerDepthPct: number;
  takerFeeBps: number;
  makerFeeBps: number;
  optionFeePctOfUnderlying: number;
  optionFeeCapPctOfPremium: number;
  partialFillProbability: number;
  rejectProbability: number;
  seed: number;
  startingBalance: number;
}

export class PaperVenue implements ExecutionVenue {
  readonly name = 'paper';
  readonly mode: Mode = 'PAPER';
  private rng: () => number;
  constructor(
    private readonly cfg: PaperConfig,
    private readonly market: MarketView,
    private readonly clock: Clock,
    private readonly underlyingOf: (instrument: string) => string,
    private readonly simulateLatency = true,
  ) {
    this.rng = mulberry32(cfg.seed);
    this.quoter = new MarketQuoter(market, clock, underlyingOf);
  }

  capabilities() {
    return { options: true, futures: true };
  }

  private quoter: MarketQuoter;

  quote(instrument: string, kind: 'OPTION' | 'FUTURE'): Quote | null {
    return this.quoter.quote(instrument, kind);
  }

  async validate(req: OrderRequest): Promise<ValidationResult> {
    if (!(req.qty > 0)) return { ok: false, reason: 'quantity must be > 0' };
    if (req.type === 'LIMIT' && !(req.limitPrice! > 0)) return { ok: false, reason: 'limit price required' };
    const q = this.quote(req.instrument, req.kind);
    if (!q) return { ok: false, reason: `no quote for ${req.instrument}` };
    if (req.kind === 'OPTION') {
      const p = parseOptionSymbol(req.instrument);
      if (p && p.expiry <= this.clock.now()) return { ok: false, reason: 'option expired' };
    }
    return { ok: true, qty: req.qty };
  }

  private fee(req: OrderRequest, price: number, qty: number, spot: number, liquidity: 'MAKER' | 'TAKER'): number {
    if (req.kind === 'FUTURE') return ((liquidity === 'MAKER' ? this.cfg.makerFeeBps : this.cfg.takerFeeBps) / 10_000) * price * qty;
    return optionFee(price, spot, qty, {
      optionFeePctOfUnderlying: this.cfg.optionFeePctOfUnderlying,
      optionFeeCapPctOfPremium: this.cfg.optionFeeCapPctOfPremium,
      futuresTakerFeeBps: 0,
      slippageBps: 0,
      fundingIntervalHours: 8,
    });
  }

  /**
   * Fill price. FUTURES: walk the REAL CoinDCX order book levels (VWAP of consumed liquidity) when
   * a fresh book is available. OPTIONS: the REAL Deribit touch. Plus a configurable latency/queue
   * slippage allowance (slippageBps) - an execution-cost assumption, not market data.
   */
  private execPrice(req: OrderRequest, q: { bid: number; ask: number; mark: number; spot: number }, qty: number): number {
    const touch = req.side === 'BUY' ? q.ask : q.bid;
    if (req.kind === 'FUTURE') {
      const book = this.market.orderBook?.(this.underlyingOf(req.instrument));
      const levels = book ? (req.side === 'BUY' ? book.asks : book.bids) : [];
      if (levels.length) {
        let left = qty;
        let cost = 0;
        for (const l of levels) {
          const take = Math.min(left, l.qty);
          cost += take * l.price;
          left -= take;
          if (left <= 1e-12) break;
        }
        // beyond visible depth: price the remainder at the last level (pessimistic)
        if (left > 1e-12) cost += left * levels[levels.length - 1].price;
        const vwap = cost / qty;
        const slip = (this.cfg.slippageBps / 10_000) * vwap;
        return req.side === 'BUY' ? vwap + slip : vwap - slip;
      }
    }
    const notionalPct = req.kind === 'FUTURE' ? (qty * q.mark) / 1_000_000 : qty / 100; // crude depth proxy
    const bps = this.cfg.slippageBps + this.cfg.impactBpsPerDepthPct * notionalPct + this.rng() * this.cfg.slippageBps;
    const ref = req.kind === 'OPTION' ? Math.max(touch, q.spot * 0.0001) : touch;
    const slip = (bps / 10_000) * (req.kind === 'OPTION' ? q.mark : ref);
    return Math.max(0, req.side === 'BUY' ? touch + slip : touch - slip);
  }

  private fill(o: OrderState, qty: number, price: number, liquidity: 'MAKER' | 'TAKER', spot: number): void {
    const fee = this.fee(o.request, price, qty, spot, liquidity);
    const f: Fill = { clientOrderId: o.request.clientOrderId, ts: this.clock.now(), qty, price, fee, liquidity };
    o.fills.push(f);
    const newQty = o.filledQty + qty;
    o.avgPrice = (o.avgPrice * o.filledQty + price * qty) / newQty;
    o.filledQty = newQty;
    o.fees += fee;
    o.status = newQty + 1e-12 >= o.request.qty ? 'FILLED' : 'PARTIALLY_FILLED';
    o.updatedAt = this.clock.now();
  }

  async submit(req: OrderRequest): Promise<OrderState> {
    const o = newOrderState(req, this.clock.now());
    o.venueOrderId = `paper-${req.clientOrderId}`;
    if (this.simulateLatency) await this.clock.sleep(this.cfg.latencyMs + this.rng() * this.cfg.latencyJitterMs);
    if (this.rng() < this.cfg.rejectProbability) {
      o.status = 'REJECTED';
      o.rejectReason = 'simulated exchange reject';
      o.updatedAt = this.clock.now();
      return o;
    }
    const q = this.quote(req.instrument, req.kind);
    if (!q) {
      o.status = 'REJECTED';
      o.rejectReason = 'no quote';
      return o;
    }
    o.status = 'NEW';
    this.tryFill(o, q, true);
    return o;
  }

  private tryFill(o: OrderState, q: { bid: number; ask: number; mark: number; spot: number }, first: boolean) {
    const req = o.request;
    const remaining = req.qty - o.filledQty;
    if (remaining <= 0) return;
    const marketable =
      req.type === 'MARKET' || (req.side === 'BUY' ? q.ask <= (req.limitPrice ?? 0) : q.bid >= (req.limitPrice ?? Infinity));
    if (!marketable) return;
    let qty = remaining;
    if (first && this.rng() < this.cfg.partialFillProbability) qty = remaining * (0.3 + 0.5 * this.rng());
    let price = this.execPrice(req, q, qty);
    if (req.type === 'LIMIT') price = req.side === 'BUY' ? Math.min(price, req.limitPrice!) : Math.max(price, req.limitPrice!);
    this.fill(o, qty, price, 'TAKER', q.spot);
  }

  async refresh(o: OrderState): Promise<OrderState> {
    if (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED') {
      const q = this.quote(o.request.instrument, o.request.kind);
      if (q) this.tryFill(o, q, false);
    }
    return o;
  }

  async cancel(o: OrderState): Promise<OrderState> {
    if (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' || o.status === 'PENDING_NEW') {
      o.status = 'CANCELLED';
      o.updatedAt = this.clock.now();
    }
    return o;
  }

  /** Paper balances are owned by the portfolio service; this returns the starting point only. */
  async balances(): Promise<VenueBalances> {
    return { equity: this.cfg.startingBalance, cash: this.cfg.startingBalance, marginInUse: 0, currency: 'USDT' };
  }
  async positions(): Promise<VenuePosition[]> {
    return [];
  }
  async emergencyFlatten(): Promise<void> {
    /* positions are flattened by the position manager in paper mode */
  }
}
