import type {
  Candle,
  Timeframe,
  OptionChainSnapshot,
  RegimeClassification,
  OrderState,
  Fill,
  Position,
  Mode,
  StrategyName,
  RegimeName,
  FeatureVector,
  StrategyCandidate,
  RiskCheck,
  MarketSnapshot,
} from '../domain/types.js';

/**
 * Persistence ports (hexagonal architecture). Services depend ONLY on these interfaces;
 * the MongoDB adapter is used in production and an in-memory adapter in tests/dry-runs.
 *
 * Ledgers (decisions, orderEvents, fills, trades, experiments, audit) are APPEND-ONLY:
 * the port exposes no update/delete, every record is hash-chained (seq, prevHash, hash),
 * and the Mongo migration installs a role that grants only insert/find on them.
 */

export interface LedgerMeta {
  seq: number;
  prevHash: string;
  hash: string;
  recordedAt: number;
}
export type Ledgered<T> = T & { _ledger: LedgerMeta };

export interface DecisionRecord {
  id: string;
  ts: number;
  mode: Mode;
  symbol: string;
  modelVersion: string;
  snapshot: MarketSnapshot;
  regime: RegimeClassification;
  candidates: StrategyCandidate[];
  selected: StrategyName | null;
  rationale: string;
  riskChecks: RiskCheck[];
  action: 'OPEN' | 'NO_TRADE' | 'BLOCKED' | 'HOLDING';
  positionId?: string;
  orders: string[];
}

export interface DecisionOutcome {
  decisionId: string;
  positionId: string;
  ts: number;
  realizedPnl: number;
  returnOnRisk: number;
  exitReason: string;
}

export interface OrderEvent {
  clientOrderId: string;
  ts: number;
  status: OrderState['status'];
  filledQty: number;
  avgPrice: number;
  venueOrderId?: string;
  note?: string;
  mode: Mode;
}

/** Immutable record of a completed round-trip. The learning engine reads these. */
export interface TradeRecord {
  positionId: string;
  decisionId: string;
  mode: Mode;
  source: 'LIVE' | 'PAPER' | 'BACKTEST';
  underlying: string;
  strategy: StrategyName;
  params: Record<string, number | string>;
  modelVersion: string;
  regime: RegimeName;
  regimeConfidence: number;
  featuresAtEntry: FeatureVector;
  openedAt: number;
  closedAt: number;
  holdingMs: number;
  entryCost: number;
  maxLoss: number;
  realizedPnl: number;
  returnOnRisk: number;
  fees: number;
  funding: number;
  slippageCost: number;
  mae: number;
  mfe: number;
  exitReason: string;
  /** price P&L before fees and funding (net = realizedPnl) */
  grossPnl?: number;
  entryPrice?: number;
  exitPrice?: number;
  qty?: number;
  /** partial bookings and the final exit, each with qty, price, gross and fees */
  bookings?: import('../domain/types.js').ExitBooking[];
  expectedValueAtEntry: number;
  popAtEntry: number;
}

export type ModelStatus = 'CANDIDATE' | 'VALIDATED' | 'ACTIVE_PAPER' | 'APPROVED_LIVE' | 'RETIRED' | 'ROLLED_BACK' | 'REJECTED';

export interface ModelVersionDoc {
  version: string;
  parentVersion: string | null;
  createdAt: number;
  status: ModelStatus;
  params: unknown;
  /** Baseline metrics this model must beat / maintain. */
  validation?: Record<string, unknown>;
  livePerformance?: Record<string, unknown>;
  approvedBy?: string;
  approvedAt?: number;
  notes?: string;
  activeInPaper: boolean;
  activeInLive: boolean;
}

export interface ExperimentRecord {
  id: string;
  ts: number;
  kind: 'WALK_FORWARD' | 'PROMOTION' | 'ROLLBACK' | 'APPROVAL' | 'REJECTION' | 'BACKTEST' | 'BASELINE_COMPARISON';
  modelVersion: string;
  baselineVersion?: string;
  summary: string;
  metrics: Record<string, unknown>;
  decision?: string;
}

export interface AuditRecord {
  id: string;
  ts: number;
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

export interface EquitySnapshot {
  ts: number;
  mode: Mode;
  equity: number;
  cash: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  openPositions: number;
  drawdownPct: number;
}

export interface EngineStateDoc {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface AlertRecord {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error' | 'critical';
  code: string;
  message: string;
  details?: Record<string, unknown>;
  acknowledged: boolean;
}

export interface Page {
  limit?: number;
  before?: number;
}

export interface CandleRepo {
  upsertMany(symbol: string, tf: Timeframe, candles: Candle[]): Promise<number>;
  range(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]>;
  latest(symbol: string, tf: Timeframe, limit: number): Promise<Candle[]>;
}

export interface ChainSnapshotRepo {
  insert(s: OptionChainSnapshot): Promise<void>;
  latest(underlying: string): Promise<OptionChainSnapshot | null>;
  /** Full recorded snapshots (real quotes) in [from, to], ascending - used for backtest replay. */
  range(underlying: string, from: number, to: number): Promise<OptionChainSnapshot[]>;
  /** Metrics-only history (contracts omitted) for IV rank / percentile. */
  metricsHistory(underlying: string, from: number): Promise<Array<{ ts: number; spot: number; atmIv: number; pcrOpenInterest?: number }>>;
}

export interface RegimeRepo {
  insert(r: RegimeClassification): Promise<void>;
  history(symbol: string, page?: Page): Promise<RegimeClassification[]>;
}

export interface LedgerRepo<T> {
  append(rec: T): Promise<Ledgered<T>>;
  list(filter?: Record<string, unknown>, page?: Page): Promise<Ledgered<T>[]>;
  count(filter?: Record<string, unknown>): Promise<number>;
  /** Recompute the hash chain; returns first broken seq or null if intact. */
  verifyChain(): Promise<{ ok: boolean; brokenAt: number | null; checked: number }>;
}

export interface OrderRepo {
  /** Insert a NEW order; throws DuplicateOrderError if clientOrderId exists (idempotency). */
  create(o: OrderState, mode: Mode): Promise<void>;
  update(o: OrderState, mode: Mode): Promise<void>;
  get(clientOrderId: string): Promise<OrderState | null>;
  listOpen(mode: Mode): Promise<OrderState[]>;
  listByPosition(positionId: string): Promise<OrderState[]>;
  recent(mode: Mode | undefined, page?: Page): Promise<OrderState[]>;
}

export interface PositionRepo {
  upsert(p: Position): Promise<void>;
  get(id: string): Promise<Position | null>;
  listOpen(mode: Mode): Promise<Position[]>;
  list(mode: Mode | undefined, page?: Page): Promise<Position[]>;
}

export interface ModelRepo {
  insert(m: ModelVersionDoc): Promise<void>;
  get(version: string): Promise<ModelVersionDoc | null>;
  update(version: string, patch: Partial<ModelVersionDoc>): Promise<void>;
  list(): Promise<ModelVersionDoc[]>;
  activeFor(mode: Mode): Promise<ModelVersionDoc | null>;
}

export interface EquityRepo {
  insert(s: EquitySnapshot): Promise<void>;
  series(mode: Mode, from: number): Promise<EquitySnapshot[]>;
}

export interface StateRepo {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  /** Acquire/renew a lease lock (single active engine). Returns true if held by `owner`. */
  acquireLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  releaseLease(name: string, owner: string): Promise<void>;
}

export interface AlertRepo {
  insert(a: AlertRecord): Promise<void>;
  recent(page?: Page): Promise<AlertRecord[]>;
  acknowledge(id: string): Promise<void>;
}

export interface Repositories {
  candles: CandleRepo;
  chains: ChainSnapshotRepo;
  regimes: RegimeRepo;
  decisions: LedgerRepo<DecisionRecord>;
  outcomes: LedgerRepo<DecisionOutcome>;
  orderEvents: LedgerRepo<OrderEvent>;
  fills: LedgerRepo<Fill & { mode: Mode }>;
  trades: LedgerRepo<TradeRecord>;
  experiments: LedgerRepo<ExperimentRecord>;
  audit: LedgerRepo<AuditRecord>;
  orders: OrderRepo;
  positions: PositionRepo;
  models: ModelRepo;
  equity: EquityRepo;
  state: StateRepo;
  alerts: AlertRepo;
  ping(): Promise<boolean>;
  /** Run fn atomically when the backend supports transactions. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DuplicateOrderError extends Error {
  constructor(public readonly clientOrderId: string) {
    super(`Duplicate clientOrderId ${clientOrderId}`);
  }
}
