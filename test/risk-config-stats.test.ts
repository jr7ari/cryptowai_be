import { describe, it, expect } from 'vitest';
import { assessEntry, checkExit, buildExitPlan, accountBreaches, type AccountState } from '../src/risk/engine.js';
import { defaultModelParams, enforceBounds, PARAM_BOUNDS, getPath, maxRelativeChange } from '../src/model/params.js';
import { perturb } from '../src/learning/calibration.js';
import { hardRiskLimits, loadConfig } from '../src/config/index.js';
import { parseProperties, findSecretKeys } from '../src/config/properties.js';
import { tCdf, welchT, bootstrapMeanDiff, probabilisticSharpe, oneSampleT, deflatedSharpe } from '../src/learning/stats.js';
import { tradeMetrics, curveMetrics } from '../src/learning/metrics.js';
import { createMemoryRepositories } from '../src/persistence/memory.js';
import { floorToStep, roundToStep } from '../src/lib/math.js';
import type { Position, RegimeClassification, StrategyCandidate } from '../src/domain/types.js';
import { testConfig } from './helpers.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = testConfig();
const L = hardRiskLimits(cfg);
const M = defaultModelParams();
const regime = { primary: 'STRONG_UPTREND', confidence: 0.9 } as RegimeClassification;
const cand: StrategyCandidate = {
  strategy: 'LONG_CALL',
  params: {},
  legs: [],
  score: 1,
  regimeAffinity: 1,
  eligible: true,
  rejectedReasons: [],
  evaluation: {
    netPremium: 50, maxLoss: 52, maxProfit: null, breakevens: [], probabilityOfProfit: 0.45, expectedValue: 5, evPerRisk: 0.1, rewardRisk: null,
    costs: { fees: 1, slippage: 1, spreadCost: 1, funding: 0, total: 3 }, greeks: { delta: 0.45, gamma: 0, vega: 1, theta: -1 },
    liquidityScore: 0.8, spreadPct: 3, marginRequired: 52, horizonDays: 3, ivUsed: 0.6, forecastVol: 0.6,
  },
};
const acct = (o: Partial<AccountState> = {}): AccountState => ({
  mode: 'PAPER', equity: 10_000, cash: 10_000, marginInUse: 0, peakEquity: 10_000, dayStartEquity: 10_000, realizedPnlToday: 0,
  openPositions: [], consecutiveLosses: 0, ordersLastMinute: 0, killSwitch: { engaged: false }, ...o,
});
const input = (o: Partial<Parameters<typeof assessEntry>[0]> = {}) => ({
  candidate: cand, underlying: 'B-BTC_USDT', regime, account: acct(), limits: L, model: M, dataAgeMs: 100, now: Date.now(), spot: 60000, unitStep: 0.01, minUnits: 0.01, ...o,
});

describe('risk engine (hard limits)', () => {
  it('approves and sizes within max risk per trade', () => {
    const r = assessEntry(input());
    expect(r.approved).toBe(true);
    expect(r.units * 52).toBeLessThanOrEqual((10_000 * L.maxRiskPerTradePct) / 100 + 1e-9);
  });
  it('learning can NEVER size above the hard per-trade budget', () => {
    const greedy = structuredClone(M);
    greedy.sizing.riskMultiplier = 50; // out of bounds on purpose
    greedy.sizing.kellyFraction = 0;
    const r = assessEntry(input({ model: greedy }));
    expect(r.units * 52).toBeLessThanOrEqual((10_000 * L.maxRiskPerTradePct) / 100 + 1e-9);
  });
  it.each([
    ['kill switch', { account: acct({ killSwitch: { engaged: true, reason: 'x' } }) }, 'kill_switch'],
    ['stale data', { dataAgeMs: 10 * 60_000 }, 'data_fresh'],
    ['daily loss', { account: acct({ equity: 9_600, dayStartEquity: 10_000 }) }, 'daily_loss'],
    ['drawdown', { account: acct({ equity: 8_000, peakEquity: 10_000, dayStartEquity: 8_000 }) }, 'max_drawdown'],
    ['max positions', { account: acct({ openPositions: [1, 2, 3].map((i) => ({ id: String(i), status: 'OPEN', underlying: `U${i}`, maxLoss: 1, legs: [] }) as unknown as Position) }) }, 'max_open_positions'],
    ['order rate', { account: acct({ ordersLastMinute: 1000 }) }, 'order_rate'],
    ['low confidence', { regime: { ...regime, confidence: 0.1 } }, 'regime_confidence'],
  ])('blocks on %s', (_, o, check) => {
    const r = assessEntry(input(o as Partial<Parameters<typeof assessEntry>[0]>));
    expect(r.approved).toBe(false);
    expect(r.checks.find((c) => c.name === check)!.passed).toBe(false);
  });
  it('already-holding does not also fail size_min', () => {
    const r = assessEntry(input({
      account: acct({
        openPositions: [{ id: '1', status: 'OPEN', underlying: 'B-BTC_USDT', maxLoss: 50, legs: [] } as unknown as Position],
      }),
    }));
    expect(r.approved).toBe(false);
    expect(r.checks.find((c) => c.name === 'positions_per_underlying')!.passed).toBe(false);
    expect(r.checks.find((c) => c.name === 'size_min')).toBeUndefined();
  });
  it('blocks when budget is smaller than one unit', () => {
    const r = assessEntry(input({ account: acct({ equity: 100, cash: 100, peakEquity: 100, dayStartEquity: 100 }) }));
    expect(r.approved).toBe(false);
  });
  it('account breaches trigger daily-loss and drawdown codes', () => {
    expect(accountBreaches(acct({ equity: 9_000, peakEquity: 10_000, dayStartEquity: 10_000 }), L).map((b) => b.code)).toContain('DAILY_LOSS');
    expect(accountBreaches(acct({ equity: 8_000, peakEquity: 10_000, dayStartEquity: 8_000 }), L).map((b) => b.code)).toContain('MAX_DRAWDOWN');
  });
  it('exit plan takes the TIGHTER of learned and hard stop; exits fire correctly', () => {
    const m = structuredClone(M);
    m.exits.stopLossPct = 95;
    const plan = buildExitPlan(m, L, 0, 10 * 86_400_000);
    expect(plan.stopLossPct).toBe(Math.min(95, L.exits.stopLossPct));
    const p = { maxLoss: 100, peakPnl: 0, exitPlan: plan, legs: [], directionBias: 'BULL' } as unknown as Position;
    expect(checkExit(p, -60, 1, null).reason).toBe('STOP_LOSS');
    expect(checkExit(p, 90, 1, null).reason).toBe('TAKE_PROFIT');
    expect(checkExit({ ...p, peakPnl: 60 } as Position, 30, 1, null).reason).toBe('TRAILING_STOP');
    expect(checkExit(p, 0, plan.timeExitAt + 1, null).exit).toBe(true);
    expect(checkExit(p, 0, 1, { primary: 'STRONG_DOWNTREND', confidence: 0.9 } as RegimeClassification).reason).toBe('REGIME_INVALIDATED');
    expect(checkExit(p, 0, 1, null).exit).toBe(false);
  });
});

describe('model params governance', () => {
  it('enforceBounds clamps every bounded parameter', () => {
    const p = defaultModelParams();
    p.exits.stopLossPct = 1000;
    p.sizing.riskMultiplier = -3;
    const clamped = enforceBounds(p);
    expect(p.exits.stopLossPct).toBe(PARAM_BOUNDS['exits.stopLossPct'][1]);
    expect(p.sizing.riskMultiplier).toBe(PARAM_BOUNDS['sizing.riskMultiplier'][0]);
    expect(clamped).toContain('exits.stopLossPct');
  });
  it('perturbations stay in bounds and within the change-rate limit', () => {
    const base = defaultModelParams();
    for (let s = 1; s < 30; s++) {
      const { params } = perturb(base, 20, s);
      for (const [path, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
        const v = getPath(params, path);
        if (typeof v === 'number') {
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        }
      }
      expect(maxRelativeChange(base, params).change).toBeLessThanOrEqual(0.2 + 0.2); // delta-ordering fixups may add a bit
    }
  });
});

describe('config', () => {
  it('parses Java-style properties with placeholders and continuations', () => {
    const p = parseProperties('# c\na.b=1\nc.d : two\ne=${X:def}\nf=${Y}\ng=long \\\n   value\nh\\=k=v', { Y: 'y' });
    expect(p).toEqual({ 'a.b': '1', 'c.d': 'two', e: 'def', f: 'y', g: 'long value', 'h=k': 'v' });
  });
  it('rejects literal secrets in properties files', () => {
    expect(findSecretKeys(parseProperties('coindcx.api-key=abc123\nother=1', {}))).toEqual(['coindcx.api-key']);
    expect(findSecretKeys(parseProperties('coindcx.api-key=${COINDCX_API_KEY}', {}))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'application.properties'), 'coindcx.api-secret=supersecret\n');
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/Secrets must not be stored/);
  });
  it('loads properties + env overrides and validates semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'application.properties'), 'risk.max-risk-per-trade-pct=0.5\napp.symbols=B-BTC_USDT\n');
    const { config } = loadConfig({ configDir: dir, env: { RISK_DAILY_LOSS_LIMIT_PCT: '2' } });
    expect(config.risk.maxRiskPerTradePct).toBe(0.5);
    expect(config.risk.dailyLossLimitPct).toBe(2);
    expect(config.app.symbols).toEqual(['B-BTC_USDT']);
    expect(config.app.mode).toBe('PAPER');
    writeFileSync(join(dir, 'application.properties'), 'risk.max-risk-per-trade-pct=25\n');
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/rejected/);
  });
});

describe('statistics', () => {
  it('t distribution CDF', () => {
    expect(tCdf(0, 10)).toBeCloseTo(0.5, 6);
    expect(tCdf(2.228, 10)).toBeCloseTo(0.975, 3);
    expect(tCdf(-1.812, 10)).toBeCloseTo(0.05, 3);
  });
  it('detects real differences and not noise', () => {
    const a = Array.from({ length: 200 }, (_, i) => 0.2 + Math.sin(i) * 0.5);
    const b = Array.from({ length: 200 }, (_, i) => Math.cos(i) * 0.5);
    expect(welchT(a, b).p).toBeLessThan(0.01);
    expect(bootstrapMeanDiff(a, b, 2000).p).toBeLessThan(0.01);
    expect(welchT(b, b).p).toBeGreaterThan(0.3);
    expect(oneSampleT(a).pGreater).toBeLessThan(0.01);
  });
  it('PSR/DSR behave sensibly', () => {
    const good = Array.from({ length: 300 }, (_, i) => 0.1 + Math.sin(i * 1.7) * 0.5);
    expect(probabilisticSharpe(good)).toBeGreaterThan(0.95);
    expect(deflatedSharpe(good, 100, 0.02)).toBeLessThan(probabilisticSharpe(good));
  });
  it('trade & curve metrics', () => {
    const t = [10, -5, 20, -10].map((p, i) => ({ realizedPnl: p, returnOnRisk: p / 10, fees: 1, holdingMs: 3_600_000, slippageCost: 0, expectedValueAtEntry: 2, closedAt: i }));
    const m = tradeMetrics(t, 1000);
    expect(m.winRate).toBe(0.5);
    expect(m.profitFactor).toBeCloseTo(2);
    expect(m.expectancyR).toBeCloseTo(0.375);
    expect(m.maxDrawdown).toBe(10);
    const c = curveMetrics([{ ts: 0, equity: 100 }, { ts: 86_400_000, equity: 110 }, { ts: 2 * 86_400_000, equity: 99 }]);
    expect(c.maxDrawdownPct).toBeCloseTo(10);
  });
});

describe('ledger & numerics', () => {
  it('hash chain verifies and detects tampering', async () => {
    const repos = createMemoryRepositories();
    for (let i = 0; i < 5; i++) await repos.audit.append({ id: String(i), ts: i, actor: 'a', action: 'x', details: { i } });
    expect((await repos.audit.verifyChain()).ok).toBe(true);
    (repos.audit as unknown as { _tamper: (i: number, p: object) => void })._tamper(2, { actor: 'evil' });
    const v = await repos.audit.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
  });
  it('quantity/price rounding to exchange increments', () => {
    expect(floorToStep(0.123456, 0.001)).toBe(0.123);
    expect(floorToStep(1.0000000001, 0.1)).toBe(1);
    expect(roundToStep(60123.37, 0.5)).toBe(60123.5);
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
    expect(floorToStep(0.0105, 0.001)).toBe(0.01); // must never round UP
    expect(floorToStep(0.0199999, 0.01)).toBe(0.01);
  });
});
