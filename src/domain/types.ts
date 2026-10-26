/** Core domain types shared by every service. */

export type Mode = 'PAPER' | 'LIVE';
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface Candle {
  /** open time, epoch ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OrderBookLevel {
  price: number;
  qty: number;
}
export interface OrderBook {
  instrument: string;
  ts: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface Ticker {
  instrument: string;
  ts: number;
  last: number;
  mark?: number;
  bid?: number;
  ask?: number;
  fundingRate?: number;
  openInterest?: number;
}

// ---------------------------------------------------------------- regimes
export const REGIMES = [
  'STRONG_UPTREND',
  'STRONG_DOWNTREND',
  'RANGING',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'BREAKOUT',
  'BREAKDOWN',
  'REVERSAL_BULLISH',
  'REVERSAL_BEARISH',
  'CHOPPY',
] as const;
export type RegimeName = (typeof REGIMES)[number];

export interface RegimeClassification {
  symbol: string;
  ts: number;
  primary: RegimeName;
  /** Calibrated confidence of the primary regime in [0,1]. */
  confidence: number;
  /** Raw (independent) evidence score per regime in [0,1]. */
  scores: Record<RegimeName, number>;
  /** Normalised probabilities (softmax over scores). */
  probabilities: Record<RegimeName, number>;
  volState: 'HIGH' | 'NORMAL' | 'LOW';
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  /** Human-readable evidence per regime. */
  evidence: Record<string, string[]>;
  modelVersion: string;
  /** True when hysteresis kept the previous regime. */
  sticky: boolean;
}

// ---------------------------------------------------------------- options
export type OptionType = 'C' | 'P';

export interface OptionContract {
  symbol: string;
  underlying: string;
  strike: number;
  expiry: number;
  type: OptionType;
  bid: number;
  ask: number;
  mark: number;
  iv: number;
  openInterest?: number;
  volume24h?: number;
  /** Contract multiplier in underlying units (1 = one coin). */
  contractSize: number;
  /** DERIBIT_REF / COINDCX = real exchange data. TEST_FIXTURE exists only inside unit tests. */
  source: 'DERIBIT_REF' | 'COINDCX' | 'TEST_FIXTURE';
}

export interface OptionChainSnapshot {
  underlying: string;
  ts: number;
  spot: number;
  /** Risk-free / funding rate used for pricing (annualised). */
  rate: number;
  contracts: OptionContract[];
  expiries: number[];
  source: OptionContract['source'];
  metrics: ChainMetrics;
}

export interface ChainMetrics {
  atmIv: number;
  /** 25-delta risk reversal: IV(25d call) - IV(25d put). */
  riskReversal25d?: number;
  /** 25-delta butterfly: avg(25d wings) - ATM. */
  butterfly25d?: number;
  /** IV term structure slope (far - near ATM IV). */
  termSlope?: number;
  pcrOpenInterest?: number;
  pcrVolume?: number;
  maxPain?: number;
  totalOpenInterest?: number;
}

// ---------------------------------------------------------------- strategies
export const STRATEGIES = [
  'LONG_CALL',
  'LONG_PUT',
  'LONG_STRADDLE',
  'LONG_STRANGLE',
  'BULL_CALL_SPREAD',
  'BEAR_PUT_SPREAD',
  'BULL_PUT_SPREAD',
  'BEAR_CALL_SPREAD',
  'IRON_CONDOR',
  'LONG_CALL_BUTTERFLY',
  'FUTURES_LONG',
  'FUTURES_SHORT',
  'FUTURES_TSMOM',
  'FUTURES_CARRY',
  'FUTURES_XSMOM',
  'FUTURES_MR',
  'FUTURES_DONCHIAN',
] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export type Side = 'BUY' | 'SELL';

export interface LegSpec {
  kind: 'OPTION' | 'FUTURE';
  instrument: string;
  side: Side;
  /** Quantity in contracts (options) or base units (futures). */
  qty: number;
  ratio: number;
  option?: { strike: number; expiry: number; type: OptionType; iv: number; contractSize: number };
  /** Price estimates at decision time. */
  bid: number;
  ask: number;
  mark: number;
}

export interface Greeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

export interface Evaluation {
  /** >0 debit paid, <0 credit received (per 1 unit of the structure, incl. contract size). */
  netPremium: number;
  maxLoss: number;
  /** null = unbounded. */
  maxProfit: number | null;
  breakevens: number[];
  probabilityOfProfit: number;
  expectedValue: number;
  /**
   * EV before taker costs (fees, slippage, half-spread). Same units as expectedValue.
   * Expected funding stays inside both net and gross (it is carry, not a commission).
   * Therefore net EV cannot exceed gross EV; a funding *credit* raises both.
   */
  grossExpectedValue?: number;
  /** EV divided by max loss. */
  evPerRisk: number;
  rewardRisk: number | null;
  costs: { fees: number; slippage: number; spreadCost: number; funding: number; total: number };
  greeks: Greeks;
  liquidityScore: number;
  spreadPct: number;
  marginRequired: number;
  /** Probability of touching the profit target before expiry (approx). */
  probTouchTarget?: number;
  /** EV at the horizon ignoring intermediate exits (closed-form quadrature). */
  terminalExpectedValue?: number;
  /** Monte-Carlo statistics under the actual exit policy (stop/target/trailing/time). */
  path?: {
    paths: number;
    stopHitPct: number;
    takeProfitPct: number;
    trailingPct: number;
    timeExitPct: number;
    p5: number;
    p95: number;
    mean?: number;
    meanStderr?: number;
    seed?: number;
  };
  horizonDays: number;
  ivUsed: number;
  forecastVol: number;
}

export interface StrategyCandidate {
  strategy: StrategyName;
  params: Record<string, number | string>;
  legs: LegSpec[];
  evaluation: Evaluation | null;
  /** Composite selection score (higher better). */
  score: number;
  regimeAffinity: number;
  eligible: boolean;
  rejectedReasons: string[];
}

// ---------------------------------------------------------------- orders/positions
export type OrderStatus =
  | 'PENDING_NEW'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];

export interface OrderRequest {
  clientOrderId: string;
  decisionId: string;
  positionId: string;
  legIndex: number;
  instrument: string;
  kind: 'OPTION' | 'FUTURE';
  side: Side;
  qty: number;
  type: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  reduceOnly?: boolean;
  leverage?: number;
  /** Reference price used for slippage measurement. */
  refPrice: number;
}

export interface Fill {
  clientOrderId: string;
  ts: number;
  qty: number;
  price: number;
  fee: number;
  liquidity: 'MAKER' | 'TAKER';
}

export interface OrderState {
  request: OrderRequest;
  venueOrderId?: string;
  status: OrderStatus;
  filledQty: number;
  avgPrice: number;
  fees: number;
  fills: Fill[];
  rejectReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PositionLeg extends LegSpec {
  entryPrice: number;
  filledQty: number;
  exitPrice?: number;
  exitQty?: number;
}

export interface ExitPlan {
  stopLossPct: number;
  takeProfitPct: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  timeExitAt: number;
  /** Close options this many ms before expiry to avoid settlement/pin risk. */
  expiryBufferMs: number;
  /** Exit when regime flips against the position with this confidence. */
  regimeInvalidationConfidence: number;
  /** Signal-based exit (e.g. TSMOM): long exits below, short exits above. */
  signalExit?: { feature: string; below?: number; above?: number };
  /** Automatic profit protection (risk/profit-guard.ts). Absent = disabled. */
  profitGuard?: ProfitGuardPlan;
  /** Exit Engine v2 (risk/exit-engine.ts): R-based stop, milestones, trailing. Futures only. */
  v2?: ExitV2Plan;
}

export interface ExitV2Plan {
  milestones: Array<{ r: number; fraction: number; lockR: number }>;
  /** Chandelier multiple of ATR (0 = off) */
  chandelierAtrMult: number;
  /** ATR source feature: atrPct (decision TF) or atrPct_1d (trend sleeves) */
  atrFeature: string;
  /** trailing starts once the best excursion reaches this many R (after costs) */
  trailActivateR: number;
  /** optional feature holding a channel-stop distance as a fraction of price (Donchian) */
  channelFeature?: string;
  /** close everything at +N R (0 = no final target: runner trails) */
  finalTargetR: number;
  /** hard stop-loss % of max loss / 100 (<= 1): the initial stop honours config exits.stop-loss-pct */
  riskFraction: number;
}

export type StopKind = 'INITIAL' | 'BREAKEVEN' | 'PROFIT_LOCK' | 'TRAIL';

export interface ExitBooking {
  ts: number;
  kind: 'PARTIAL' | 'CLOSE';
  reason: string;
  qty: number;
  price: number;
  grossPnl: number;
  fees: number;
  detail?: string;
}

export interface ProfitGuardPlan {
  /** peak P&L (% of risk) at which the stop moves to break-even + buffer */
  breakevenAtPct: number;
  breakevenBufferPct: number;
  /** [peakPct, lockFraction]: once peak >= peakPct keep at least lockFraction * peak */
  lockSteps: Array<[number, number]>;
  /** structures with a capped max profit: bank it at this % of max profit */
  captureOfMaxProfitPct?: number;
}

export type PositionStatus = 'OPENING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface Position {
  id: string;
  decisionId: string;
  mode: Mode;
  /** exchange the position lives on (absent = coindcx, positions created before multi-exchange support) */
  exchange?: 'coindcx' | 'delta';
  underlying: string;
  strategy: StrategyName;
  legs: PositionLeg[];
  units: number;
  openedAt: number;
  closedAt?: number;
  status: PositionStatus;
  entryCost: number;
  maxLoss: number;
  maxProfit: number | null;
  exitPlan: ExitPlan;
  peakPnl: number;
  troughPnl: number;
  realizedPnl?: number;
  fees: number;
  fundingPaid: number;
  exitReason?: string;
  modelVersion: string;
  regimeAtEntry: RegimeName;
  regimeConfidence: number;
  directionBias: 'BULL' | 'BEAR' | 'NEUTRAL';
  params: Record<string, number | string>;
  featuresAtEntry: FeatureVector;
  evAtEntry: number;
  popAtEntry: number;
  /** execution shortfall vs decision-time reference prices (positive = cost) */
  slippageCost: number;
  /** futures only: protective stop distance in price units */
  stopDistance?: number;
  leverage?: number;
  lastMarkPnl?: number;
  lastMarkAt?: number;
  /** Profit Guard ratcheted floor (% of risk); null/undefined until armed. Never decreases. */
  profitFloorPct?: number | null;
  /** Exit Engine v2 state: protective stop price (only moves to reduce risk) */
  stopPrice?: number;
  stopKind?: StopKind;
  highWater?: number;
  lowWater?: number;
  milestonesHit?: number[];
  /** fees paid on entry fills (used to estimate exit fees symmetrically) */
  entryFees?: number;
  /** every partial booking / final exit with gross, fees and price */
  bookings?: ExitBooking[];
  lastFundingAt?: number;
  /** monotonically increasing close attempt counter (makes close clientOrderIds unique) */
  closeAttempts?: number;
}

// ---------------------------------------------------------------- risk
export interface RiskCheck {
  name: string;
  passed: boolean;
  value?: number | string;
  limit?: number | string;
  message: string;
}

export interface RiskDecision {
  approved: boolean;
  units: number;
  checks: RiskCheck[];
  riskBudget: number;
}

// ---------------------------------------------------------------- features
export type FeatureVector = Record<string, number>;

export interface DataQuality {
  ok: boolean;
  reasons: string[];
  bookImbalanceAvail: number;
  ofiAvail: number;
  fundingAvail: number;
  oiAvail: number;
  ivAvail: number;
  cusumAvail: number;
  candleBars: number;
}

export interface MarketSnapshot {
  symbol: string;
  ts: number;
  spot: number;
  mark?: number;
  fundingRate?: number;
  openInterest?: number;
  bid?: number;
  ask?: number;
  features: FeatureVector;
  chainMetrics?: ChainMetrics;
  dataAgeMs: number;
  dataQuality?: DataQuality;
}
