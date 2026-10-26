import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { momentumFeatures, alphaDrift, vrpScore, writeAlphaFeatures } from '../src/signals/alpha.js';
import { defaultModelParams } from '../src/model/params.js';
import { checkExit, buildExitPlan, assessEntry } from '../src/risk/engine.js';
import { hardRiskLimits } from '../src/config/index.js';
import { startMockExchange } from './fixtures/mock-exchange.js';
import { CoinDcxRestClient } from '../src/integrations/coindcx/rest.js';
import { LiveFuturesVenue } from '../src/execution/live.js';
import { OrderManager } from '../src/execution/order-manager.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { reconcile } from '../src/engine/reconcile.js';
import { systemClock } from '../src/lib/clock.js';
import type { Position, RegimeClassification } from '../src/domain/types.js';
import { trend, testConfig } from './helpers.js';

const P = defaultModelParams();
const reg = (primary: string, confidence = 0.8) => ({ primary, confidence }) as RegimeClassification;

describe('alpha signals', () => {
  it('time-series momentum is positive in an uptrend, negative in a downtrend', () => {
    const up = momentumFeatures(trend(120, 0.01, 100, '1d', 0.01), '1d');
    const dn = momentumFeatures(trend(120, -0.01, 100, '1d', 0.01), '1d');
    expect(up.tsmom).toBeGreaterThan(0.3);
    expect(dn.tsmom).toBeLessThan(-0.3);
    expect(up.mom_t_7d).toBeGreaterThan(0);
    expect(up.tsmomAgreement).toBeCloseTo(1);
  });
  it('negative momentum is down-weighted (short side of crypto TSMOM is weak)', () => {
    const a = alphaDrift({ tsmom: 0.5, tsmomAgreement: 1, rvLong: 0.6 }, reg('RANGING'), P, 0.6);
    const b = alphaDrift({ tsmom: -0.5, tsmomAgreement: 1, rvLong: 0.6 }, reg('RANGING'), P, 0.6);
    expect(a.momentum).toBeGreaterThan(0);
    expect(Math.abs(b.momentum)).toBeCloseTo(a.momentum * P.forecast.momentumShortWeight, 8);
  });
  it('funding tilt is contrarian and bounded; VRP sign; vol-target scale never above 1', () => {
    const hot = alphaDrift({ fundingAnnual: 2 }, reg('RANGING'), P, 0.6);
    expect(hot.funding).toBeLessThan(0);
    expect(Math.abs(hot.funding)).toBeLessThanOrEqual(P.forecast.fundingTilt);
    expect(vrpScore({ ivAtm: 0.9 }, 0.6)).toBeGreaterThan(0);
    expect(vrpScore({ ivAtm: 0.4 }, 0.6)).toBeLessThan(0);
    expect(alphaDrift({}, reg('RANGING'), P, 0.1).volScale).toBe(1);
    expect(alphaDrift({}, reg('RANGING'), P, 2.8).volScale).toBeCloseTo(0.25);
  });
  it('writes drift onto features and omits VRP without IV', () => {
    const fv: Record<string, number> = { tsmom: -0.4, tsmomAgreement: 1, rvLong: 0.5, vrpScore: 0 };
    const a = alphaDrift(fv, reg('STRONG_DOWNTREND'), P, 0.4);
    writeAlphaFeatures(fv, a, 0.4);
    expect(fv.alphaDrift).toBe(a.total);
    expect(fv.volTargetScale).toBe(a.volScale);
    expect(fv.vrpScore).toBeUndefined();
    fv.ivAtm = 0.9;
    writeAlphaFeatures(fv, alphaDrift(fv, reg('STRONG_DOWNTREND'), P, 0.4), 0.4);
    expect(fv.vrpScore).toBeGreaterThan(0);
  });
  it('vol targeting reduces size when forecast vol is high (never increases it)', () => {
    const cfg = testConfig();
    const L = hardRiskLimits(cfg);
    const mk = (forecastVol: number) => ({
      strategy: 'LONG_CALL' as const, params: {}, legs: [], score: 1, regimeAffinity: 1, eligible: true, rejectedReasons: [],
      evaluation: { netPremium: 10, maxLoss: 10, maxProfit: null, breakevens: [], probabilityOfProfit: 0.5, expectedValue: 1, evPerRisk: 0.1, rewardRisk: null, costs: { fees: 0, slippage: 0, spreadCost: 0, funding: 0, total: 0 }, greeks: { delta: 0.1, gamma: 0, vega: 0, theta: 0 }, liquidityScore: 1, spreadPct: 1, marginRequired: 10, horizonDays: 3, ivUsed: 0.6, forecastVol },
    });
    const acct = { mode: 'PAPER' as const, equity: 10_000, cash: 10_000, marginInUse: 0, peakEquity: 10_000, dayStartEquity: 10_000, realizedPnlToday: 0, openPositions: [], consecutiveLosses: 0, ordersLastMinute: 0, killSwitch: { engaged: false } };
    const base = { underlying: 'X', regime: reg('STRONG_UPTREND', 1), account: acct, limits: L, model: P, dataAgeMs: 0, now: 0, spot: 100, unitStep: 0.01, minUnits: 0.01 };
    const calm = assessEntry({ ...base, candidate: mk(0.4) });
    const wild = assessEntry({ ...base, candidate: mk(2.0) });
    expect(wild.units).toBeLessThan(calm.units);
    expect(calm.units * 10).toBeLessThanOrEqual(100 + 1e-9);
  });
  it('TSMOM sleeve exits on signal-off and has no take-profit/trailing (JSON-safe sentinels)', () => {
    const L = hardRiskLimits(testConfig());
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_TSMOM');
    const round = JSON.parse(JSON.stringify(plan));
    expect(round.takeProfitPct).toBeGreaterThan(1e6);
    const p = { maxLoss: 100, peakPnl: 90, exitPlan: round, legs: [], directionBias: 'BULL' } as unknown as Position;
    expect(checkExit(p, 80, 1, null, { tsmom: 0.4 }).exit).toBe(false);
    expect(checkExit(p, 80, 1, null, { tsmom: 0.0 }).reason).toBe('SIGNAL_EXIT');
    expect(checkExit(p, -60, 1, null, { tsmom: 0.4 }).reason).toBe('STOP_LOSS');
  });
  it('TSMOM short covers when the score rises through the exit threshold', () => {
    const L = hardRiskLimits(testConfig());
    const plan = buildExitPlan(P, L, 0, null, 'FUTURES_TSMOM', 'SELL');
    const p = { maxLoss: 100, peakPnl: 10, exitPlan: plan, legs: [], directionBias: 'BEAR' } as unknown as Position;
    expect(checkExit(p, 8, 1, null, { tsmom: -0.4 }).exit).toBe(false);
    expect(checkExit(p, 8, 1, null, { tsmom: 0 }).reason).toBe('SIGNAL_EXIT');
  });
});

describe('CoinDCX integration against the protocol simulator (signed requests end-to-end)', () => {
  let mock: Awaited<ReturnType<typeof startMockExchange>>;
  const port = 19090 + Math.floor(Math.random() * 500);
  const rest = () =>
    new CoinDcxRestClient({
      apiBaseUrl: `http://127.0.0.1:${port}`, publicBaseUrl: `http://127.0.0.1:${port}`, apiKey: 'k-123456', apiSecret: 's-abcdef',
      timeoutMs: 5000, maxRequestsPerMinute: 6000, resolutionMap: { '1h': '60', '1d': '1D' }, marginCurrency: 'USDT',
    });
  beforeAll(async () => {
    mock = await startMockExchange({ port, apiKey: 'k-123456', apiSecret: 's-abcdef', days: 10 });
  }, 60_000);
  afterAll(async () => {
    await mock.app.close();
  });
  it('public data: candles, instrument spec, order book, current prices, trades', async () => {
    const r = rest();
    const now = Date.now();
    const c = await r.candles('B-BTC_USDT', '1h', now - 24 * 3_600_000, now);
    expect(c.length).toBeGreaterThan(20);
    expect(c[1].t - c[0].t).toBe(3_600_000);
    const inst = await r.instrument('B-BTC_USDT');
    expect(inst.quantity_increment).toBe(0.001);
    const ob = await r.orderbook('B-BTC_USDT', 10);
    expect(ob.asks[0].price).toBeGreaterThan(ob.bids[0].price);
    const cp = await r.currentPrices();
    expect(cp['B-BTC_USDT'].mark).toBeGreaterThan(0);
    expect((await r.publicTrades('B-BTC_USDT')).length).toBeGreaterThan(0);
    expect(r.stats().every((s) => s.errors === 0)).toBe(true);
  });
  it('authenticated: wallet (GET with signed body), order, positions, reconciliation', async () => {
    const r = rest();
    const venue = new LiveFuturesVenue(r, { maxLeverage: 3, marginCurrency: 'USDT', sendClientOrderId: false }, systemClock);
    const bal = await venue.balances();
    expect(bal.cash).toBe(10_000);
    expect((await venue.checkInstrument('B-BTC_USDT')).ok).toBe(true);
    const repos = createMemoryRepositories();
    const om = new OrderManager(repos, systemClock, () => venue);
    const st = await om.execute({ clientOrderId: 'e2e-1', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE', side: 'BUY', qty: 0.0105, type: 'MARKET', refPrice: mock.priceAt('B-BTC_USDT'), leverage: 2 });
    expect(st.status).toBe('FILLED');
    expect(st.filledQty).toBeCloseTo(0.01, 10); // rounded DOWN to quantity_increment before sending
    const pos = await venue.positions();
    expect(pos[0]).toMatchObject({ instrument: 'B-BTC_USDT' });
    expect(pos[0].qty).toBeCloseTo(0.01, 10);
    // the engine's book knows nothing about this position -> reconciliation must flag it
    const rep = await reconcile(repos, venue, om, Date.now());
    expect(rep.ok).toBe(false);
    expect(rep.mismatches[0].instrument).toBe('B-BTC_USDT');
    await venue.emergencyFlatten('test');
    expect((await venue.positions()).length).toBe(0);
  });
  it('a wrong secret is rejected by signature verification (401, not retried)', async () => {
    const bad = new CoinDcxRestClient({ apiBaseUrl: `http://127.0.0.1:${port}`, publicBaseUrl: `http://127.0.0.1:${port}`, apiKey: 'k-123456', apiSecret: 'WRONG-secret', timeoutMs: 5000, maxRequestsPerMinute: 6000, resolutionMap: {}, marginCurrency: 'USDT' });
    await expect(bad.listPositions()).rejects.toThrow(/401/);
    expect(bad.stats()[0].errors).toBe(1);
  });
});
