import { describe, it, expect, afterEach } from 'vitest';
import { Engine, LeaseHeldError, LIVE_CONFIRM_PHRASE, LEASE_TTL_MS } from '../src/engine/engine.js';
import { ModelRegistry } from '../src/model/registry.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { PaperVenue } from '../src/execution/paper.js';
import { Alerts } from '../src/monitoring/alerts.js';
import { LearningEngine } from '../src/learning/engine.js';
import { buildServer } from '../src/api/server.js';
import { SimulatedClock } from '../src/lib/clock.js';
import { newOrderState, type ExecutionVenue } from '../src/execution/venue.js';
import { STRATEGIES, type OrderRequest, type OrderState, type Position, type RegimeClassification } from '../src/domain/types.js';
import { buildStrategy } from '../src/strategies/builders.js';
import { evaluate } from '../src/strategies/evaluate.js';
import { buildExitPlan } from '../src/risk/engine.js';
import { hardRiskLimits } from '../src/config/index.js';
import type { Secrets } from '../src/config/index.js';
import { defaultModelParams } from '../src/model/params.js';
import { FakeMarket, testConfig, trend } from './helpers.js';
import { aggregate } from '../src/marketdata/view.js';

class FakeLiveVenue implements ExecutionVenue {
  readonly name = 'fake-live';
  readonly mode = 'LIVE' as const;
  submitted: OrderRequest[] = [];
  pos = new Map<string, number>();
  constructor(private price: () => number) {}
  capabilities() {
    return { options: false, futures: true };
  }
  async validate(r: OrderRequest) {
    return r.qty > 0 ? { ok: true, qty: r.qty } : { ok: false, reason: 'qty 0 < min_quantity 0.001' };
  }
  async submit(r: OrderRequest): Promise<OrderState> {
    this.submitted.push(r);
    const o = newOrderState(r, Date.now());
    o.status = 'FILLED';
    o.filledQty = r.qty;
    o.avgPrice = this.price();
    o.venueOrderId = `v${this.submitted.length}`;
    this.pos.set(r.instrument, (this.pos.get(r.instrument) ?? 0) + (r.side === 'BUY' ? r.qty : -r.qty));
    return o;
  }
  async refresh(o: OrderState) {
    return o;
  }
  async cancel(o: OrderState) {
    return o;
  }
  async balances() {
    return { equity: 5000, cash: 5000, marginInUse: 0, currency: 'USDT' };
  }
  async positions() {
    return [...this.pos.entries()].filter(([, q]) => Math.abs(q) > 1e-12).map(([instrument, qty]) => ({ instrument, qty, avgPrice: this.price(), venuePositionId: instrument }));
  }
  async emergencyFlatten() {
    this.pos.clear();
  }
  async checkInstrument() {
    return { ok: true, detail: 'fake' };
  }
}

const SYM = 'B-BTC_USDT';
async function setup(opts: { live?: boolean; token?: string } = {}) {
  const cfg = testConfig({ app: { symbols: [SYM], timeframes: ['1h', '4h'], decisionTimeframe: '1h', underlyingMap: 'B-BTC_USDT:BTC' } });
  const clock = new SimulatedClock(Date.UTC(2025, 3, 1));
  const market = new FakeMarket(clock);
  const c = trend(600, 0.0015, 60000, '1h', 0.002).map((x, i) => ({ ...x, t: Date.UTC(2025, 3, 1) - (600 - i) * 3_600_000 }));
  market.setCandles(SYM, '1h', c);
  market.setCandles(SYM, '4h', aggregate(c, '4h'));
  const repos = createMemoryRepositories();
  const alerts = new Alerts(repos, clock);
  const registry = new ModelRegistry(repos, clock);
  const secrets: Secrets = { mongoUri: 'x', operatorToken: opts.token, coindcxApiKey: opts.live ? 'k' : undefined };
  const paperVenue = new PaperVenue({ ...cfg.paper, rejectProbability: 0, partialFillProbability: 0 }, market, clock, () => SYM, false);
  const liveVenue = opts.live ? new FakeLiveVenue(() => market.lastPrice(SYM)!.price) : undefined;
  const engine = new Engine({ config: { ...cfg, db: { ...cfg.db, driver: 'mongo' } }, secrets, repos, market, paperVenue, liveVenue, clock, alerts, registry });
  return { cfg, clock, market, repos, alerts, registry, engine, liveVenue, secrets };
}

let toStop: Engine[] = [];
afterEach(async () => {
  for (const e of toStop) await e.stop();
  toStop = [];
});

describe('engine', () => {
  it('starts in PAPER, records auditable decisions with full context', async () => {
    const s = await setup();
    await s.engine.start();
    toStop.push(s.engine);
    expect(s.engine.mode).toBe('PAPER');
    const rec = await s.engine.decideSymbol(SYM);
    expect(rec).not.toBeNull();
    expect(rec!.regime.primary).toBeDefined();
    expect(rec!.snapshot.features.adx).toBeGreaterThan(0);
    expect(Array.isArray(rec!.candidates)).toBe(true);
    expect(rec!.rationale.length).toBeGreaterThan(5);
    const stored = await s.repos.decisions.list({ id: rec!.id });
    expect(stored.length).toBe(1);
    expect((await s.repos.decisions.verifyChain()).ok).toBe(true);
  });

  it('already-open underlying is HOLDING, not BLOCKED', async () => {
    const s = await setup();
    await s.engine.start();
    toStop.push(s.engine);
    await s.repos.positions.upsert({
      id: 'open-1',
      decisionId: 'd1',
      mode: 'PAPER',
      status: 'OPEN',
      underlying: SYM,
      strategy: 'FUTURES_TSMOM',
      legs: [],
      units: 0.001,
      openedAt: s.clock.now(),
      entryCost: -100,
      maxLoss: 50,
      maxProfit: null,
      exitPlan: {
        stopLossPct: 50,
        takeProfitPct: 1e9,
        trailingActivationPct: 1e9,
        trailingDistancePct: 1e9,
        timeExitAt: s.clock.now() + 8.64e8,
        expiryBufferMs: 0,
        regimeInvalidationConfidence: 2,
      },
      peakPnl: 0,
      troughPnl: 0,
      fees: 0,
      fundingPaid: 0,
      modelVersion: 't',
      regimeAtEntry: 'STRONG_DOWNTREND',
      regimeConfidence: 0.7,
      directionBias: 'BEAR',
      params: {},
      featuresAtEntry: {},
      evAtEntry: 1,
      popAtEntry: 0.5,
      slippageCost: 0,
    } as Position);
    const rec = await s.engine.decideSymbol(SYM);
    expect(rec).not.toBeNull();
    expect(rec!.action).not.toBe('BLOCKED');
    if (rec!.selected) {
      expect(rec!.action).toBe('HOLDING');
      expect(rec!.rationale).toMatch(/already in this trade/i);
    }
  });

  it('winning the lease acknowledges leftover LEASE_HELD alerts', async () => {
    const s = await setup();
    await s.repos.alerts.insert({ id: 'old-lease', ts: 1, level: 'critical', code: 'LEASE_HELD', message: 'another instance', acknowledged: false });
    await s.engine.start();
    toStop.push(s.engine);
    const row = (await s.repos.alerts.recent()).find((a) => a.id === 'old-lease');
    expect(row?.acknowledged).toBe(true);
  });

  it('lease loser does not close positions; the owner keeps the exit loop', async () => {
    const s = await setup();
    await s.engine.start();
    toStop.push(s.engine);
    const chain = s.market.chain(SYM)!;
    const spot = s.market.lastPrice(SYM)!.price;
    const b = buildStrategy('LONG_CALL', defaultModelParams().strategies.LONG_CALL, {
      chain,
      futuresInstrument: SYM,
      spot,
      now: s.clock.now(),
      minDte: 2,
      maxDte: 45,
      atr: spot * 0.01,
    });
    if ('error' in b) throw new Error(b.error);
    const ev = evaluate(b.legs, {
      spot,
      now: s.clock.now(),
      rate: 0,
      forecastVol: 0.6,
      drift: 0,
      holdHours: 72,
      expiryBufferHours: 12,
      takeProfitPct: 80,
      stopLossPct: 50,
      costs: { optionFeePctOfUnderlying: 0.03, optionFeeCapPctOfPremium: 12.5, futuresTakerFeeBps: 5, slippageBps: 5, fundingIntervalHours: 8 },
    });
    const cand = { strategy: 'LONG_CALL' as const, params: b.params, legs: b.legs, evaluation: ev, score: 1, regimeAffinity: 1, eligible: true, rejectedReasons: [] };
    const p = await s.engine.positions.PAPER.open({
      decisionId: 'd-lease',
      candidate: cand,
      units: 0.1,
      underlying: SYM,
      regime: { primary: 'RANGING', confidence: 0.8 } as RegimeClassification,
      modelVersion: 'm1',
      exitPlan: buildExitPlan(defaultModelParams(), hardRiskLimits(s.cfg), s.clock.now(), b.legs[0].option!.expiry),
      features: {},
    });
    expect(p.status).toBe('OPEN');
    s.clock.advance(LEASE_TTL_MS + 1);
    expect(await s.repos.state.acquireLease('engine', 'thief', 60_000, s.clock.now())).toBe(true);
    await (s.engine as unknown as { renewLease: () => Promise<void> }).renewLease();
    expect(s.engine.hasLease).toBe(false);
    s.market.price.set(SYM, spot * 0.85);
    s.clock.advance(3_600_000);
    await (s.engine as unknown as { monitorPositions: () => Promise<void> }).monitorPositions();
    expect((await s.repos.positions.get(p.id))!.status).toBe('OPEN');
  });

  it('a second instance fails fast without inserting LEASE_HELD', async () => {
    const a = await setup();
    await a.engine.start();
    toStop.push(a.engine);
    const b = new Engine({
      config: { ...a.cfg, db: { ...a.cfg.db, driver: 'mongo' } },
      secrets: a.secrets,
      repos: a.repos,
      market: a.market,
      paperVenue: new PaperVenue({ ...a.cfg.paper, rejectProbability: 0, partialFillProbability: 0 }, a.market, a.clock, () => SYM, false),
      clock: a.clock,
      alerts: a.alerts,
      registry: a.registry,
    });
    await expect(b.start({ leaseWaitMs: 0 })).rejects.toBeInstanceOf(LeaseHeldError);
    expect((await a.repos.alerts.recent()).map((x) => x.code)).not.toContain('LEASE_HELD');
  });

  it('kill switch blocks new entries and stale data blocks entries', async () => {
    const s = await setup();
    await s.engine.start();
    toStop.push(s.engine);
    await s.engine.killSwitch.engage('MANUAL', 'test', 'tester', false);
    const r1 = await s.engine.decideSymbol(SYM);
    if (r1!.selected) {
      expect(r1!.action).toBe('BLOCKED');
      expect(r1!.riskChecks.find((c) => c.name === 'kill_switch')!.passed).toBe(false);
    }
    await s.engine.killSwitch.release('tester', 'ok');
    s.market.ageMs = 10 * 60_000;
    const r2 = await s.engine.decideSymbol(SYM);
    if (r2!.selected) expect(r2!.riskChecks.find((c) => c.name === 'data_fresh')!.passed).toBe(false);
  });

  it('LIVE cannot be armed without an approved model / correct phrase; arming needs reconciliation', async () => {
    const s = await setup({ live: true, token: 'tok-123456' });
    await s.engine.start();
    toStop.push(s.engine);
    const bad = await s.engine.armLive('op', 'yes please');
    expect(bad.ok).toBe(false);
    const r = await s.engine.armLive('op', LIVE_CONFIRM_PHRASE);
    expect(r.ok).toBe(false);
    const names = (r.checks as Array<{ name: string; passed: boolean }>).filter((c) => !c.passed).map((c) => c.name);
    expect(names).toContain('approved_live_model');
    expect(s.engine.mode).toBe('PAPER');
  });

  it('first LIVE order is held for separate confirmation, then executes on a fresh decision', async () => {
    const s = await setup({ live: true, token: 'tok-123456' });
    await s.engine.start();
    toStop.push(s.engine);
    // approve a futures-enabled model for LIVE (operator path, bypassing paper evidence for the test)
    const p = defaultModelParams();
    p.strategies.FUTURES_LONG.enabled = true;
    p.strategies.FUTURES_SHORT.enabled = true;
    p.strategies.FUTURES_LONG.paperOnly = false;
    p.strategies.FUTURES_SHORT.paperOnly = false;
    p.selection.minScore = 0.05;
    p.forecast.drift.STRONG_UPTREND = 0.8; // strong calibrated drift so the trend produces a positive-EV signal
    p.forecast.drift.BREAKOUT = 0.8;
    const doc = await s.registry.createCandidate(p, (await s.registry.active('PAPER'))!.version, 'live test');
    await s.registry.markValidated(doc.version, {});
    await s.registry.approveLive(doc.version, 'op', { test: true });
    const armed = await s.engine.armLive('op', LIVE_CONFIRM_PHRASE);
    expect(armed.ok).toBe(true);
    expect(s.engine.mode).toBe('LIVE');
    for (let i = 0; i < 3 && !s.engine.pendingLiveOrder; i++) await s.engine.decideSymbol(SYM);
    expect(s.engine.pendingLiveOrder).not.toBeNull();
    expect(s.liveVenue!.submitted.length).toBe(0); // HELD
    const conf = await s.engine.confirmFirstLiveOrder('op', s.engine.pendingLiveOrder!.decision.id);
    expect(conf.ok).toBe(true);
    expect(s.engine.live.firstOrderConfirmed).toBe(true);
    expect(s.liveVenue!.submitted.length).toBeGreaterThan(0); // fresh decision executed after confirmation
    expect((await s.repos.audit.list()).map((x) => x.action)).toEqual(expect.arrayContaining(['LIVE_ARMED', 'FIRST_LIVE_ORDER_CONFIRMED']));
    // a forged/old decision id cannot be confirmed
    expect((await s.engine.confirmFirstLiveOrder('op', 'nope')).ok).toBe(false);
  });

  it('restart never resumes LIVE automatically', async () => {
    const s = await setup({ live: true });
    await s.repos.state.set('live', { armed: true, firstOrderConfirmed: true });
    await s.engine.start();
    toStop.push(s.engine);
    expect(s.engine.mode).toBe('PAPER');
    expect(s.engine.live.armed).toBe(false);
    const alerts = await s.repos.alerts.recent();
    expect(alerts.map((a) => a.code)).toContain('LIVE_DISARMED_ON_RESTART');
  });

  it('reconciliation mismatch at startup engages the kill switch', async () => {
    const s = await setup({ live: true });
    s.liveVenue!.pos.set(SYM, 0.5); // exchange has a position we do not know about
    await s.engine.start();
    toStop.push(s.engine);
    expect(s.engine.killSwitch.get().engaged).toBe(true);
    expect(s.engine.killSwitch.get().kind).toBe('RECONCILIATION');
  });
});

describe('HTTP API', () => {
  async function api(token?: string) {
    const s = await setup({ token });
    await s.engine.start();
    toStop.push(s.engine);
    const learning = new LearningEngine(s.cfg, s.repos, s.registry, s.clock, s.alerts);
    const app = await buildServer({ config: s.cfg, secrets: s.secrets, repos: s.repos, engine: s.engine, learning, registry: s.registry, alerts: s.alerts, market: s.market });
    return { app, s };
  }
  it('health, status, indicators, strategies, models, audit verification', async () => {
    const { app } = await api('tok-123456');
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    const st = (await app.inject({ url: '/api/status' })).json();
    expect(st.mode).toBe('PAPER');
    const ind = (await app.inject({ url: `/api/indicators/${SYM}` })).json();
    expect(ind.interpreted.length).toBeGreaterThan(5);
    expect(Number.isFinite(ind.features.alphaDrift)).toBe(true);
    expect(Number.isFinite(ind.features.volTargetScale)).toBe(true);
    expect((await app.inject({ url: '/api/strategies' })).json().strategies.length).toBe(STRATEGIES.length);
    expect((await app.inject({ url: '/api/models' })).json().length).toBe(1);
    const v = (await app.inject({ url: '/api/audit/verify' })).json();
    expect(Object.values(v).every((x) => (x as { ok: boolean }).ok)).toBe(true);
    expect((await app.inject({ url: '/metrics' })).body).toContain('engine_kill_switch');
    await app.close();
  });
  it('PAPER dashboard mutations work without a token; LIVE still requires one', async () => {
    const { app, s } = await api('tok-123456');
    expect((await app.inject({ method: 'POST', url: '/api/live/arm', payload: { confirmPhrase: LIVE_CONFIRM_PHRASE } })).statusCode).toBe(401);
    const ks = await app.inject({ method: 'POST', url: '/api/kill-switch', payload: { action: 'engage', reason: 'test' } });
    expect(ks.json().killSwitch.engaged).toBe(true);
    const rel = await app.inject({ method: 'POST', url: '/api/kill-switch', payload: { action: 'release' } });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().killSwitch.engaged).toBe(false);
    const reset = await app.inject({ method: 'POST', url: '/api/paper/reset', payload: { balance: 5000 } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().balance).toBe(5000);
    s.engine.mode = 'LIVE';
    await app.inject({ method: 'POST', url: '/api/kill-switch', payload: { action: 'engage', reason: 'live' } });
    expect((await app.inject({ method: 'POST', url: '/api/kill-switch', payload: { action: 'release' } })).statusCode).toBe(401);
    const liveRel = await app.inject({ method: 'POST', url: '/api/kill-switch', headers: { 'x-operator-token': 'tok-123456' }, payload: { action: 'release' } });
    expect(liveRel.statusCode).toBe(200);
    await app.close();
  });
  it('LIVE actions are disabled entirely when no OPERATOR_TOKEN is configured', async () => {
    const { app } = await api(undefined);
    const r = await app.inject({ method: 'POST', url: '/api/live/arm', payload: { confirmPhrase: LIVE_CONFIRM_PHRASE } });
    expect(r.statusCode).toBe(403);
    await app.close();
  });
});
