/**
 * Trading engine orchestrator.
 *
 * Modes: PAPER is the default. LIVE requires (1) API credentials, (2) a model explicitly approved for
 * LIVE, (3) a clean reconciliation, (4) an operator ARM action with a typed confirmation phrase, and
 * (5) a SEPARATE confirmation of the very first live order. A restart always comes back DISARMED.
 *
 * Loops: decision (per closed bar), position monitor (exits), risk monitor (kill switch), reconciliation
 * (LIVE), equity snapshots, lease renewal (single active instance).
 */
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import type { AppConfig, Secrets, HardRiskLimits } from '../config/index.js';
import { hardRiskLimits, parseMap } from '../config/index.js';
import type { Mode, RegimeClassification, StrategyName, Position } from '../domain/types.js';
import type { Repositories, DecisionRecord } from '../persistence/ports.js';
import type { MarketView } from '../marketdata/view.js';
import type { ExecutionVenue } from '../execution/venue.js';
import { tradableStrategies } from '../execution/venue.js';
import { pausedStrategies } from '../learning/edge-monitor.js';
import { positionExchange } from '../integrations/exchange.js';
import { OrderManager } from '../execution/order-manager.js';
import { MarketQuoter } from '../execution/quoter.js';
import { Account } from '../portfolio/account.js';
import { PositionManager } from '../portfolio/position-manager.js';
import { ModelRegistry } from '../model/registry.js';
import { decide, costModelFromConfig, type DecisionOutput } from './decision.js';
import { KillSwitch } from '../risk/killswitch.js';
import { accountBreaches, drawdownPct } from '../risk/engine.js';
import { reconcile, type ReconcileReport } from './reconcile.js';
import type { Alerts } from '../monitoring/alerts.js';
import { metrics } from '../monitoring/metrics.js';
import { uuid } from '../lib/ids.js';
import type { Clock } from '../lib/clock.js';
import { MS } from '../lib/clock.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('engine');
export const LIVE_CONFIRM_PHRASE = 'ENABLE LIVE TRADING';
/** How long this instance claims exclusive trading. Renewed well inside this window. */
export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;

export class LeaseHeldError extends Error {
  constructor() {
    super('Another engine instance already holds the trading lease. Stop the other `npm run dev` / node process and retry.');
    this.name = 'LeaseHeldError';
  }
}

export interface EngineDeps {
  config: AppConfig;
  secrets: Secrets;
  repos: Repositories;
  market: MarketView & { start?: () => Promise<void>; stop?: () => void; on?: (e: 'bar', l: (x: { symbol: string }) => void) => void };
  paperVenue: ExecutionVenue;
  liveVenue?: ExecutionVenue;
  clock: Clock;
  alerts: Alerts;
  registry: ModelRegistry;
}

interface LiveState {
  armed: boolean;
  armedAt?: number;
  armedBy?: string;
  firstOrderConfirmed: boolean;
}

interface PendingLiveOrder {
  decision: DecisionRecord;
  output: DecisionOutput;
  createdAt: number;
  expiresAt: number;
}

export class Engine extends EventEmitter {
  readonly limits: HardRiskLimits;
  readonly killSwitch: KillSwitch;
  readonly instanceId = `${hostname()}-${process.pid}-${uuid().slice(0, 6)}`;
  mode: Mode = 'PAPER';
  live: LiveState = { armed: false, firstOrderConfirmed: false };
  pendingLiveOrder: PendingLiveOrder | null = null;
  paused = false;
  hasLease = false;
  lastReconcile: ReconcileReport | null = null;
  regimes = new Map<string, RegimeClassification>();
  features = new Map<string, Record<string, number>>();
  lastDecisionAt = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private deciding = new Set<string>();
  readonly accounts: Record<Mode, Account>;
  readonly orders: Record<Mode, OrderManager>;
  readonly positions: Record<Mode, PositionManager>;
  readonly underlyingMap: Record<string, string>;

  constructor(private readonly d: EngineDeps) {
    super();
    this.limits = hardRiskLimits(d.config);
    this.killSwitch = new KillSwitch(d.repos, d.clock);
    this.underlyingMap = parseMap(d.config.app.underlyingMap);
    const reverse = Object.fromEntries(Object.entries(this.underlyingMap).map(([k, v]) => [v, k]));
    const underlyingOf = (inst: string) => (d.config.app.symbols.includes(inst) ? inst : reverse[inst.split('-')[0]] ?? d.config.app.symbols[0]);
    const quoter = new MarketQuoter(d.market, d.clock, underlyingOf);
    const alert = (level: 'warn' | 'error' | 'critical', code: string, msg: string) => void d.alerts.raise(level, code, msg);
    this.accounts = {
      PAPER: new Account(d.repos, d.clock, 'PAPER', d.config.paper.startingBalance),
      LIVE: new Account(d.repos, d.clock, 'LIVE', 0),
    };
    this.orders = {
      PAPER: new OrderManager(d.repos, d.clock, () => d.paperVenue, alert),
      LIVE: new OrderManager(d.repos, d.clock, () => this.requireLiveVenue(), alert),
    };
    const pm = (m: Mode) =>
      new PositionManager({
        repos: d.repos,
        orders: this.orders[m],
        quoter,
        account: () => this.accounts[m],
        clock: d.clock,
        mode: () => m,
        fundingRate: (u) => d.market.mark(u)?.fundingRate,
        fundingIntervalHours: d.config.paper.fundingIntervalHours,
        optionLimitTolerance: 0.05,
        onAlert: alert,
        v2Live: d.config.exits.engineV2Live,
        exchange: d.config.app.exchange,
      });
    this.positions = { PAPER: pm('PAPER'), LIVE: pm('LIVE') };
    this.killSwitch.onChange((s) => {
      metrics.set('engine_kill_switch', s.engaged ? 1 : 0);
      this.emit('status');
      if (s.engaged && s.flatten) void this.emergencyFlatten(`kill switch: ${s.reason}`);
    });
  }

  private requireLiveVenue(): ExecutionVenue {
    if (!this.d.liveVenue) throw new Error('LIVE venue not configured (missing API credentials)');
    return this.d.liveVenue;
  }

  // ------------------------------------------------------------------ lifecycle
  async start(opts?: { leaseWaitMs?: number }): Promise<void> {
    const { repos, config } = this.d;
    await this.d.registry.ensureBaseline();
    await this.killSwitch.load();
    await this.accounts.PAPER.load();
    await this.accounts.LIVE.load();
    this.hasLease = await this.waitForLease(opts?.leaseWaitMs ?? 0);
    if (!this.hasLease) {
      this.paused = true;
      throw new LeaseHeldError();
    }
    // restart recovery: drive non-terminal orders, recover half-open positions
    await this.orders.PAPER.resolveOpen().catch((e) => log.warn({ err: (e as Error).message }, 'paper order recovery failed'));
    await this.recoverPositions('PAPER');
    if (this.d.liveVenue) {
      this.lastReconcile = await reconcile(repos, this.d.liveVenue, this.orders.LIVE, this.d.clock.now(), 1e-9, this.d.config.app.exchange);
      if (!this.lastReconcile.ok && (this.lastReconcile.mismatches.length || this.lastReconcile.unresolvedOrders)) {
        await this.killSwitch.engage('RECONCILIATION', `startup reconciliation mismatch: ${JSON.stringify(this.lastReconcile.mismatches)}`, 'system', false);
      }
      await this.recoverPositions('LIVE');
    }
    // never resume LIVE automatically
    const saved = await repos.state.get<LiveState>('live');
    this.live = { armed: false, firstOrderConfirmed: false };
    if (saved?.armed) await this.d.alerts.raise('warn', 'LIVE_DISARMED_ON_RESTART', 'Engine restarted: LIVE trading is DISARMED until an operator re-arms it.');
    await repos.state.set('live', this.live);
    this.mode = 'PAPER';
    if (config.app.mode === 'LIVE') log.warn('app.mode=LIVE configured: engine starts in PAPER and requires operator ARM to trade live');

    await this.ackStaleLeaseAlerts();
    await this.d.market.start?.();
    this.d.market.on?.('bar', ({ symbol }) => void this.decideSymbol(symbol));
    this.every(config.app.decisionIntervalSec * 1000, () => this.decisionSweep());
    this.every(config.app.positionMonitorIntervalSec * 1000, () => this.monitorPositions());
    this.every(10_000, () => this.riskMonitor());
    this.every(60_000, () => this.snapshotEquity());
    this.every(LEASE_RENEW_MS, () => this.renewLease());
    this.every(60_000, () => this.periodicReconcile());
    this.every(30_000, () => this.killSwitch.tick());
    log.info({ instance: this.instanceId, symbols: config.app.symbols }, 'engine started in PAPER mode');
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.d.market.stop?.();
    await this.d.repos.state.releaseLease('engine', this.instanceId).catch(() => undefined);
  }

  private every(ms: number, fn: () => Promise<void>) {
    let busy = false;
    this.timers.push(
      setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await fn();
        } catch (e) {
          log.error({ err: (e as Error).stack }, 'engine loop error');
          await this.d.alerts.raise('error', 'LOOP_ERROR', (e as Error).message);
        } finally {
          busy = false;
        }
      }, ms),
    );
  }

  private async waitForLease(waitMs: number): Promise<boolean> {
    const deadline = this.d.clock.now() + Math.max(0, waitMs);
    for (;;) {
      const ok = await this.d.repos.state.acquireLease('engine', this.instanceId, LEASE_TTL_MS, this.d.clock.now());
      if (ok) return true;
      if (this.d.clock.now() >= deadline) return false;
      log.warn({ waitMs, instance: this.instanceId }, 'trading lease busy (stale process from tsx watch?); retrying');
      await this.d.clock.sleep(500);
    }
  }

  private async renewLease() {
    const ok = await this.d.repos.state.acquireLease('engine', this.instanceId, LEASE_TTL_MS, this.d.clock.now());
    if (ok) {
      if (!this.hasLease || this.paused) log.info({ instance: this.instanceId }, 'trading lease held; PAPER engine running');
      this.hasLease = true;
      this.paused = false;
      return;
    }
    if (this.hasLease) {
      await this.d.alerts.raise('critical', 'LEASE_LOST', 'Trading lease lost to another instance: trading paused');
    }
    this.hasLease = false;
    this.paused = true;
  }

  /** Historical LEASE_HELD rows are from a previous duplicate-process era; this owner no longer raises them. */
  private async ackStaleLeaseAlerts() {
    try {
      const recent = await this.d.repos.alerts.recent({ limit: 100 });
      for (const a of recent) {
        if (a.code === 'LEASE_HELD' && !a.acknowledged) await this.d.repos.alerts.acknowledge(a.id);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'could not acknowledge stale LEASE_HELD alerts');
    }
  }

  private async recoverPositions(mode: Mode) {
    for (const p of await this.positions[mode].listOpen()) {
      if (p.status === 'OPENING') {
        await this.d.alerts.raise('error', 'RECOVER_OPENING', `Position ${p.id} was OPENING at shutdown: unwinding filled legs`);
        await this.positions[mode].close(p, 'RECONCILIATION', 'recovered OPENING position at startup');
      } else if (p.status === 'CLOSING') {
        await this.positions[mode].close(p, p.exitReason ?? 'RECONCILIATION', 'resume close after restart');
      }
    }
  }

  // ------------------------------------------------------------------ decisions
  private async decisionSweep() {
    if (this.paused || !this.hasLease) return;
    const intervalMs = Math.max(1, this.d.config.app.decisionIntervalSec) * 1000;
    for (const s of this.d.config.app.symbols) {
      const last = this.lastDecisionAt.get(s) ?? 0;
      if (this.d.clock.now() - last >= intervalMs) await this.decideSymbol(s);
    }
  }

  private pausedCache: Partial<Record<Mode, { at: number; v: Map<StrategyName, string> }>> = {};
  /** Per-strategy edge monitor, refreshed at most every 5 minutes. Fails open to "nothing paused". */
  async pausedFor(mode: Mode): Promise<Map<StrategyName, string>> {
    const r = this.d.config.risk;
    if (!r.edgeMonitorEnabled) return new Map();
    const c = this.pausedCache[mode];
    const now = this.d.clock.now();
    if (c && now - c.at < 5 * MS.m) return c.v;
    let v = new Map<StrategyName, string>();
    try {
      const trades = await this.d.repos.trades.list({ mode }, { limit: 1000 });
      v = pausedStrategies(trades, { window: r.edgeMonitorWindow, minTrades: r.edgeMonitorMinTrades, tStat: r.edgeMonitorTStat, maxCumLossR: r.edgeMonitorMaxCumLossR, pauseHours: r.edgeMonitorPauseHours, now });
      for (const [s, why] of v) if (!c?.v.has(s)) await this.d.alerts.raise('warn', 'STRATEGY_PAUSED', `${mode} ${s}: ${why}`);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'edge monitor unavailable');
    }
    this.pausedCache[mode] = { at: now, v };
    return v;
  }

  async equityFor(mode: Mode) {
    const acct = this.accounts[mode];
    return this.positions[mode].equity(acct.book.cash);
  }

  async decideSymbol(symbol: string): Promise<DecisionRecord | null> {
    if (this.paused || !this.hasLease) return null;
    if (this.deciding.has(symbol)) return null;
    this.deciding.add(symbol);
    try {
      const mode = this.mode;
      const model = await this.d.registry.active(mode);
      if (!model) {
        if (mode === 'LIVE') await this.d.alerts.raise('error', 'NO_LIVE_MODEL', 'No model approved for LIVE: no live decisions');
        return null;
      }
      const venue = mode === 'LIVE' ? this.d.liveVenue : this.d.paperVenue;
      if (!venue) return null;
      const { equity, marginInUse, open } = await this.equityFor(mode);
      const ks = this.killSwitch.get();
      const out = decide({
        symbol,
        underlying: symbol,
        mode,
        market: this.d.market,
        model,
        limits: this.limits,
        account: this.accounts[mode].snapshot(equity, marginInUse, open, this.orders[mode].ordersLastMinute(), { engaged: ks.engaged || this.paused, reason: ks.engaged ? ks.reason : 'engine paused' }),
        costs: costModelFromConfig(this.d.config),
        tradable: tradableStrategies(venue),
        paused: await this.pausedFor(mode),
        timeframes: this.d.config.app.timeframes,
        decisionTf: this.d.config.app.decisionTimeframe,
        fundingIntervalHours: this.d.config.paper.fundingIntervalHours,
        prevRegime: this.regimes.get(symbol),
        unitStep: (s: StrategyName) => (s.startsWith('FUTURES_') ? 0.001 : 0.01),
        minUnits: (s: StrategyName) => (s.startsWith('FUTURES_') ? 0.001 : 0.01),
        peerSymbols: this.d.config.app.symbols,
      });
      this.lastDecisionAt.set(symbol, this.d.clock.now());
      this.regimes.set(symbol, out.regime);
      this.features.set(symbol, out.record.snapshot.features);
      metrics.set('engine_regime_confidence', out.regime.confidence, { symbol, regime: out.regime.primary });
      metrics.set('engine_data_age_ms', out.record.snapshot.dataAgeMs, { symbol });
      metrics.inc('engine_decisions_total', { action: out.record.action, mode });
      await this.d.repos.regimes.insert(out.regime);

      if (out.open && mode === 'LIVE' && !this.live.firstOrderConfirmed) {
        out.record.action = 'BLOCKED';
        out.record.rationale += ' | HELD: awaiting operator confirmation of the FIRST live order';
        this.pendingLiveOrder = { decision: out.record, output: out, createdAt: this.d.clock.now(), expiresAt: this.d.clock.now() + 2 * MS.m };
        await this.d.alerts.raise('warn', 'FIRST_LIVE_ORDER_PENDING', `First LIVE order (${out.record.selected} on ${symbol}) awaits confirmation (decision ${out.record.id}, expires in 2 min)`);
      }
      await this.d.repos.decisions.append(out.record);
      this.emit('decision', out.record);
      if (out.open && out.record.action === 'OPEN') await this.execute(out, mode);
      return out.record;
    } finally {
      this.deciding.delete(symbol);
    }
  }

  private async execute(out: DecisionOutput, mode: Mode): Promise<Position | null> {
    if (!this.hasLease || this.paused) return null;
    if (mode === 'LIVE' && (!this.live.armed || !this.live.firstOrderConfirmed)) return null;
    const cand = out.record.candidates.find((c) => c.strategy === out.record.selected);
    if (!cand || !out.open) return null;
    const p = await this.positions[mode].open({
      decisionId: out.record.id,
      candidate: cand,
      units: out.open.units,
      underlying: out.record.symbol,
      regime: out.regime,
      modelVersion: out.record.modelVersion,
      exitPlan: out.open.exitPlan,
      stopDistance: out.open.stopDistance,
      leverage: out.open.leverage,
      features: out.record.snapshot.features,
    });
    this.emit('position', p);
    return p;
  }

  // ------------------------------------------------------------------ monitors
  private async monitorPositions() {
    if (!this.hasLease) return;
    const regimeOf = (u: string) => this.regimes.get(u) ?? null;
    const featuresOf = (u: string) => this.features.get(u) ?? null;
    await this.positions.PAPER.monitor(regimeOf, featuresOf);
    if (this.d.liveVenue) await this.positions.LIVE.monitor(regimeOf, featuresOf);
    if (this.pendingLiveOrder && this.d.clock.now() > this.pendingLiveOrder.expiresAt) {
      log.warn({ decision: this.pendingLiveOrder.decision.id }, 'pending first live order expired');
      this.pendingLiveOrder = null;
    }
  }

  private async riskMonitor() {
    for (const mode of ['PAPER', 'LIVE'] as Mode[]) {
      if (mode === 'LIVE' && !this.d.liveVenue) continue;
      const { equity, marginInUse, open } = await this.equityFor(mode);
      const acct = this.accounts[mode];
      if (mode === 'LIVE' && acct.book.peakEquity === 0) continue;
      await acct.observeEquity(equity);
      const snap = acct.snapshot(equity, marginInUse, open, 0, this.killSwitch.get());
      metrics.set('engine_equity', equity, { mode });
      metrics.set('engine_drawdown_pct', drawdownPct(snap), { mode });
      metrics.set('engine_open_positions', open.length, { mode });
      if (!this.hasLease || mode !== this.mode) continue; // only the lease owner engages the kill switch
      for (const b of accountBreaches(snap, this.limits)) {
        await this.killSwitch.engage(b.code, b.message, 'risk-engine', b.code === 'MAX_DRAWDOWN');
        await this.d.alerts.raise('critical', b.code, b.message);
      }
    }
    if (this.mode === 'LIVE') {
      for (const s of this.d.config.app.symbols) {
        const age = this.d.market.dataAgeMs(s);
        if (age > this.limits.staleDataMs * 3) await this.d.alerts.raise('error', 'STALE_DATA', `${s} market data stale for ${Math.round(age / 1000)}s: entries blocked`);
      }
    }
  }

  private async snapshotEquity() {
    for (const mode of ['PAPER', 'LIVE'] as Mode[]) {
      if (mode === 'LIVE' && !this.d.liveVenue) continue;
      const { equity, unrealized, open } = await this.equityFor(mode);
      const acct = this.accounts[mode];
      await this.d.repos.equity.insert({
        ts: this.d.clock.now(),
        mode,
        equity,
        cash: acct.book.cash,
        unrealizedPnl: unrealized,
        realizedPnlToday: acct.book.realizedPnlToday,
        openPositions: open.length,
        drawdownPct: acct.book.peakEquity > 0 ? Math.max(0, ((acct.book.peakEquity - equity) / acct.book.peakEquity) * 100) : 0,
      });
    }
  }

  private async periodicReconcile() {
    if (!this.d.liveVenue || this.mode !== 'LIVE') return;
    this.lastReconcile = await reconcile(this.d.repos, this.d.liveVenue, this.orders.LIVE, this.d.clock.now(), 1e-9, this.d.config.app.exchange);
    if (this.lastReconcile.balance) await this.accounts.LIVE.syncCash(this.lastReconcile.balance.cash);
    if (!this.lastReconcile.ok) {
      const why = this.lastReconcile.error ?? JSON.stringify(this.lastReconcile.mismatches);
      if (this.lastReconcile.error) await this.d.alerts.raise('error', 'RECONCILE_ERROR', `reconciliation failed: ${why}`);
      else await this.killSwitch.engage('RECONCILIATION', `position mismatch: ${why}`, 'reconciler', false);
    }
  }

  async emergencyFlatten(reason: string): Promise<void> {
    if (!this.hasLease) {
      log.warn({ reason }, 'emergency flatten skipped: this instance does not hold the trading lease');
      return;
    }
    log.error({ reason }, 'EMERGENCY FLATTEN');
    await this.positions.PAPER.flattenAll('KILL_SWITCH');
    if (this.d.liveVenue) {
      await this.positions.LIVE.flattenAll('KILL_SWITCH');
      await this.d.liveVenue.emergencyFlatten(reason).catch((e) => this.d.alerts.raise('critical', 'FLATTEN_FAILED', (e as Error).message));
    }
  }

  // ------------------------------------------------------------------ operator actions
  async liveReadiness(): Promise<{ ready: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }> {
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    const v = this.d.liveVenue;
    checks.push({
      name: 'credentials',
      passed: !!v && v.capabilities().futures,
      detail: !v
        ? `${this.d.config.app.exchange === 'delta' ? 'DELTA_API_KEY/DELTA_API_SECRET' : 'COINDCX_API_KEY/SECRET'} not set`
        : v.capabilities().futures
          ? `API key configured: LIVE futures enabled on ${this.d.config.app.exchange} (options: PAPER only)`
          : v.capabilities().reason ?? 'futures not available',
    });
    checks.push({ name: 'operator_token', passed: !!this.d.secrets.operatorToken, detail: this.d.secrets.operatorToken ? 'set' : 'OPERATOR_TOKEN not set' });
    checks.push({ name: 'durable_storage', passed: this.d.config.db.driver === 'mongo', detail: `db.driver=${this.d.config.db.driver}` });
    checks.push({ name: 'lease', passed: this.hasLease, detail: this.hasLease ? 'single active instance' : 'another instance holds the lease' });
    const ks = this.killSwitch.get();
    checks.push({ name: 'kill_switch_off', passed: !ks.engaged, detail: ks.engaged ? `${ks.kind}: ${ks.reason}` : 'off' });
    const model = await this.d.repos.models.activeFor('LIVE');
    checks.push({ name: 'approved_live_model', passed: !!model, detail: model ? model.version : 'no model approved for LIVE (approve via /api/models/:version/approve-live)' });
    if (v) {
      try {
        const bal = await v.balances();
        checks.push({
          name: 'exchange_auth',
          passed: true,
          detail: `${bal.currency} wallet ${bal.cash.toFixed(2)} (margin in use ${bal.marginInUse.toFixed(2)})`,
        });
      } catch (e) {
        checks.push({ name: 'exchange_auth', passed: false, detail: (e as Error).message });
      }
      const rec = await reconcile(this.d.repos, v, this.orders.LIVE, this.d.clock.now(), 1e-9, this.d.config.app.exchange);
      this.lastReconcile = rec;
      checks.push({ name: 'reconciliation', passed: rec.ok, detail: rec.error ?? (rec.ok ? 'local book matches exchange' : JSON.stringify(rec.mismatches)) });
      if (rec.balance) {
        checks.push({ name: 'balance', passed: rec.balance.cash > 0, detail: `${rec.balance.cash.toFixed(2)} ${this.d.config.app.exchange === 'delta' ? this.d.config.delta.marginCurrency : this.d.config.coindcx.marginCurrency}` });
      }
      for (const s of this.d.config.app.symbols) {
        const r = v.checkInstrument ? await v.checkInstrument(s) : { ok: false, detail: 'venue cannot verify instrument specs' };
        checks.push({ name: `instrument_${s}`, passed: r.ok, detail: r.detail });
      }
    }
    for (const s of this.d.config.app.symbols) {
      const age = this.d.market.dataAgeMs(s);
      checks.push({ name: `fresh_data_${s}`, passed: age <= this.limits.staleDataMs, detail: `${Math.round(age)}ms` });
    }
    return { ready: checks.every((c) => c.passed), checks };
  }

  async armLive(actor: string, phrase: string): Promise<{ ok: boolean; checks: unknown; message: string }> {
    if (phrase !== LIVE_CONFIRM_PHRASE) return { ok: false, checks: [], message: `confirmation phrase must be exactly "${LIVE_CONFIRM_PHRASE}"` };
    const r = await this.liveReadiness();
    await this.d.repos.audit.append({ id: uuid(), ts: this.d.clock.now(), actor, action: r.ready ? 'LIVE_ARMED' : 'LIVE_ARM_DENIED', details: { checks: r.checks } });
    if (!r.ready) return { ok: false, checks: r.checks, message: 'LIVE readiness checks failed' };
    const book = await this.d.liveVenue!.balances();
    await this.accounts.LIVE.syncCash(book.cash);
    if (this.accounts.LIVE.book.peakEquity === 0) {
      this.accounts.LIVE.book.peakEquity = book.equity;
      this.accounts.LIVE.book.dayStartEquity = book.equity;
      await this.accounts.LIVE.save();
    }
    this.live = { armed: true, armedAt: this.d.clock.now(), armedBy: actor, firstOrderConfirmed: false };
    this.mode = 'LIVE';
    await this.d.repos.state.set('live', this.live);
    await this.d.alerts.raise('warn', 'LIVE_ARMED', `LIVE trading ARMED by ${actor}. The first live order will require separate confirmation.`);
    this.emit('status');
    return { ok: true, checks: r.checks, message: 'LIVE armed; first order requires confirmation' };
  }

  async disarmLive(actor: string, reason: string): Promise<void> {
    this.live = { armed: false, firstOrderConfirmed: false };
    this.mode = 'PAPER';
    this.pendingLiveOrder = null;
    await this.d.repos.state.set('live', this.live);
    await this.d.repos.audit.append({ id: uuid(), ts: this.d.clock.now(), actor, action: 'LIVE_DISARMED', details: { reason } });
    await this.d.alerts.raise('warn', 'LIVE_DISARMED', `LIVE disarmed by ${actor}: ${reason}. Open live positions remain monitored for exits.`);
    this.emit('status');
  }

  async confirmFirstLiveOrder(actor: string, decisionId: string): Promise<{ ok: boolean; message: string; position?: Position | null }> {
    const p = this.pendingLiveOrder;
    if (!this.live.armed || this.mode !== 'LIVE') return { ok: false, message: 'LIVE is not armed' };
    if (!p || p.decision.id !== decisionId) return { ok: false, message: 'no pending first order with that decision id' };
    if (this.d.clock.now() > p.expiresAt) {
      this.pendingLiveOrder = null;
      return { ok: false, message: 'pending order expired (market moved on); wait for the next signal' };
    }
    this.live.firstOrderConfirmed = true;
    await this.d.repos.state.set('live', this.live);
    await this.d.repos.audit.append({ id: uuid(), ts: this.d.clock.now(), actor, action: 'FIRST_LIVE_ORDER_CONFIRMED', details: { decisionId, strategy: p.decision.selected } });
    this.pendingLiveOrder = null;
    // re-run the full decision (fresh data + fresh risk checks) rather than executing a stale order
    const rec = await this.decideSymbol(p.decision.symbol);
    return { ok: true, message: rec?.action === 'OPEN' ? 'confirmed; fresh decision executed' : `confirmed; fresh decision was ${rec?.action ?? 'skipped'} (${rec?.rationale ?? ''})` };
  }

  async closePositionManually(id: string, actor: string): Promise<Position | null> {
    const p = await this.d.repos.positions.get(id);
    if (!p) return null;
    if (positionExchange(p) !== this.d.config.app.exchange) {
      throw new Error(`position ${id} lives on ${positionExchange(p)}; restart connected to that exchange to close it`);
    }
    await this.d.repos.audit.append({ id: uuid(), ts: this.d.clock.now(), actor, action: 'MANUAL_CLOSE', details: { positionId: id } });
    return this.positions[p.mode].close(p, 'MANUAL', `closed by ${actor}`);
  }

  async status() {
    const out: Record<string, unknown> = {
      instance: this.instanceId,
      exchange: this.d.config.app.exchange,
      mode: this.mode,
      live: this.live,
      pendingLiveOrder: this.pendingLiveOrder
        ? { decisionId: this.pendingLiveOrder.decision.id, symbol: this.pendingLiveOrder.decision.symbol, strategy: this.pendingLiveOrder.decision.selected, expiresAt: this.pendingLiveOrder.expiresAt, rationale: this.pendingLiveOrder.decision.rationale }
        : null,
      paused: this.paused,
      hasLease: this.hasLease,
      killSwitch: this.killSwitch.get(),
      symbols: this.d.config.app.symbols,
      timeframes: this.d.config.app.timeframes,
      decisionTimeframe: this.d.config.app.decisionTimeframe,
      capabilities: {
        paper: this.d.paperVenue.capabilities(),
        live: this.d.liveVenue?.capabilities() ?? { options: false, futures: false, reason: 'no API credentials configured' },
      },
      lastReconcile: this.lastReconcile,
      dataAgeMs: Object.fromEntries(this.d.config.app.symbols.map((s) => [s, this.d.market.dataAgeMs(s)])),
      models: { paper: (await this.d.registry.active('PAPER'))?.version ?? null, live: (await this.d.registry.active('LIVE'))?.version ?? null },
      accounts: {} as Record<string, unknown>,
    };
    for (const m of ['PAPER', 'LIVE'] as Mode[]) {
      const e = await this.equityFor(m);
      const b = this.accounts[m].book;
      (out.accounts as Record<string, unknown>)[m] = {
        equity: e.equity,
        cash: b.cash,
        unrealizedPnl: e.unrealized,
        marginInUse: e.marginInUse,
        openPositions: e.open.length,
        realizedPnlToday: b.realizedPnlToday,
        peakEquity: b.peakEquity,
        dayStartEquity: b.dayStartEquity,
        drawdownPct: b.peakEquity > 0 ? Math.max(0, ((b.peakEquity - e.equity) / b.peakEquity) * 100) : 0,
        dailyLossPct: b.dayStartEquity > 0 ? Math.max(0, ((b.dayStartEquity - e.equity) / b.dayStartEquity) * 100) : 0,
        consecutiveLosses: b.consecutiveLosses,
        totalFees: b.totalFees,
      };
    }
    return out;
  }
}
