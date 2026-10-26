/**
 * Event-driven backtester. Runs the SAME decision pipeline, risk engine, order manager, paper fill
 * simulator and position manager as live trading, over historical candles with a simulated clock
 * and in-memory persistence. Also runs naive baseline policies for comparison.
 */
import type { Candle, StrategyName, Timeframe, RegimeClassification, RegimeName, OptionChainSnapshot } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import type { AppConfig, HardRiskLimits } from '../config/index.js';
import { hardRiskLimits } from '../config/index.js';
import { SimulatedClock } from '../lib/clock.js';
import { createMemoryRepositories } from '../persistence/memory.js';
import type { TradeRecord } from '../persistence/ports.js';
import { HistoricalMarketView } from './historical-view.js';
import { PaperVenue } from '../execution/paper.js';
import { OrderManager } from '../execution/order-manager.js';
import { MarketQuoter } from '../execution/quoter.js';
import { Account } from '../portfolio/account.js';
import { PositionManager } from '../portfolio/position-manager.js';
import { decide, costModelFromConfig } from '../engine/decision.js';
import type { ActiveModel } from '../model/registry.js';
import { tradeMetrics, curveMetrics, breakdown, type PerfMetrics, type CurveMetrics, type EquityPoint } from '../learning/metrics.js';
import { buildStrategy } from '../strategies/builders.js';
import { evaluate } from '../strategies/evaluate.js';
import { forecastVolatility } from '../strategies/selector.js';
import { alphaDrift } from '../signals/alpha.js';
import { assessEntry, buildExitPlan } from '../risk/engine.js';
import { extractFeatures } from '../regime/features.js';
import { classify } from '../regime/classifier.js';
import { STRATEGIES } from '../domain/types.js';
import { mulberry32 } from '../lib/math.js';
import { uuid } from '../lib/ids.js';
import { parseMap } from '../config/index.js';

export type Policy =
  | { kind: 'REGIME_ENGINE' }
  | { kind: 'FIXED'; strategy: StrategyName }
  | { kind: 'RANDOM'; seed: number };

export interface BacktestOptions {
  config: AppConfig;
  candles: Record<string, Candle[]>;
  baseTf: Timeframe;
  timeframes: Timeframe[];
  decisionEveryBars: number;
  warmupBars: number;
  model: ActiveModel;
  policy: Policy;
  from?: number;
  to?: number;
  startingBalance?: number;
  seed?: number;
  /** restrict tradable strategies (default: all option + futures strategies) */
  tradable?: Set<StrategyName>;
  /** REAL recorded option-chain snapshots per futures symbol (from the chain_snapshots collection). */
  chains?: Record<string, OptionChainSnapshot[]>;
  /** unit tests only */
  chainProvider?: (symbol: string, now: number, view: HistoricalMarketView) => OptionChainSnapshot | null;
  /** cost assumption: futures half-spread in bps (no historical order books exist) */
  futuresHalfSpreadBps?: number;
  /** funding rate per interval applied in paper futures (cost assumption; default 0.01%) */
  fundingRate?: number;
  label?: string;
  mcPaths?: number;
  /** suppress per-trade info logs */
  quiet?: boolean;
}

export interface RegimeLabel {
  ts: number;
  symbol: string;
  regime: RegimeName;
  confidence: number;
  price: number;
}

export interface BacktestResult {
  label: string;
  policy: Policy;
  modelVersion: string;
  trades: TradeRecord[];
  equity: EquityPoint[];
  metrics: PerfMetrics;
  curve: CurveMetrics;
  byRegime: Record<string, PerfMetrics>;
  byStrategy: Record<string, PerfMetrics>;
  decisions: number;
  blocked: number;
  regimeLabels: RegimeLabel[];
  regimeCounts: Record<string, number>;
  /** candidate rejection reasons (normalised) -> count */
  rejections: Record<string, number>;
  /** Equal-weight buy-and-hold of the underlyings over the same window (no costs, no leverage). */
  benchmark: CurveMetrics;
  from: number;
  to: number;
}

function relaxedLimits(l: HardRiskLimits): HardRiskLimits {
  return Object.freeze({ ...l, minExpectedValuePerRisk: -Infinity, minProbabilityOfProfit: 0, minConfidence: 0, minLiquidityScore: 0 }) as HardRiskLimits;
}

export async function runBacktest(o: BacktestOptions): Promise<BacktestResult> {
  const cfg = o.config;
  const symbols = Object.keys(o.candles);
  const allBase = symbols.flatMap((s) => o.candles[s]);
  if (!allBase.length) throw new Error('no candles');
  const tfMs = TIMEFRAME_MS[o.baseTf];
  const times = [...new Set(allBase.map((c) => c.t))].sort((a, b) => a - b).filter((t) => (o.from === undefined || t >= o.from) && (o.to === undefined || t <= o.to));
  if (times.length <= o.warmupBars) throw new Error(`not enough bars: ${times.length} <= warmup ${o.warmupBars}`);
  const start = times[0];
  const clock = new SimulatedClock(start);
  const repos = createMemoryRepositories();
  const underlyingMap = parseMap(cfg.app.underlyingMap);
  const reverse = Object.fromEntries(Object.entries(underlyingMap).map(([k, v]) => [v, k]));
  const underlyingOf = (inst: string) => (o.candles[inst] ? inst : reverse[inst.split('-')[0]] ?? symbols[0]);
  const view = new HistoricalMarketView(
    {
      baseTf: o.baseTf,
      timeframes: o.timeframes,
      historyBars: cfg.app.historyBars,
      underlyingMap,
      futuresHalfSpread: (o.futuresHalfSpreadBps ?? 1) / 10_000,
      fundingRate: o.fundingRate ?? 0.0001,
      chains: o.chains,
      chainProvider: o.chainProvider,
    },
    clock,
    o.candles,
  );
  const balance = o.startingBalance ?? cfg.paper.startingBalance;
  const venue = new PaperVenue({ ...cfg.paper, seed: o.seed ?? cfg.paper.seed, startingBalance: balance }, view, clock, underlyingOf, true);
  const account = new Account(repos, clock, 'PAPER', balance);
  await account.load();
  const orders = new OrderManager(repos, clock, () => venue);
  const quoter = new MarketQuoter(view, clock, underlyingOf);
  const pm = new PositionManager({
    repos,
    orders,
    quoter,
    account: () => account,
    clock,
    mode: () => 'PAPER',
    fundingRate: (u) => view.mark(u)?.fundingRate,
    fundingIntervalHours: cfg.paper.fundingIntervalHours,
    optionLimitTolerance: 0.05,
    barOf: (u) => view.lastBar(u),
    execAt: (u, px, fn) => view.withExecPrice(u, px, fn),
  });
  const limits = hardRiskLimits(cfg);
  const costs = costModelFromConfig(cfg);
  const tradable = o.tradable ?? new Set(STRATEGIES);
  const rng = mulberry32(o.policy.kind === 'RANDOM' ? o.policy.seed : 1);
  const prevRegime = new Map<string, RegimeClassification>();
  const lastRegime = new Map<string, RegimeClassification>();
  const lastFeatures = new Map<string, Record<string, number>>();
  const equity: EquityPoint[] = [];
  const labels: RegimeLabel[] = [];
  const regimeCounts: Record<string, number> = {};
  let decisions = 0;
  let blocked = 0;
  const rejections: Record<string, number> = {};

  for (let i = 0; i < times.length; i++) {
    const t = times[i] + tfMs; // bar close
    clock.set(Math.max(clock.now(), t));
    if (i < o.warmupBars) continue;

    await pm.monitor((u) => lastRegime.get(u) ?? null, (u) => lastFeatures.get(u) ?? null);
    const { equity: eq, marginInUse, open } = await pm.equity(account.book.cash);
    await account.observeEquity(eq);
    equity.push({ ts: clock.now(), equity: eq });

    if ((i - o.warmupBars) % o.decisionEveryBars !== 0) continue;
    for (const sym of symbols) {
      const snapshot = account.snapshot(eq, marginInUse, open, orders.ordersLastMinute(), { engaged: false });
      if (o.policy.kind === 'REGIME_ENGINE') {
        const out = decide({
          symbol: sym,
          underlying: sym,
          mode: 'PAPER',
          market: view,
          model: o.model,
          limits,
          account: snapshot,
          costs,
          tradable,
          timeframes: o.timeframes,
          decisionTf: o.baseTf,
          fundingIntervalHours: cfg.paper.fundingIntervalHours,
          prevRegime: prevRegime.get(sym),
          unitStep: (s) => (s.startsWith('FUTURES_') ? 0.001 : 0.01),
          minUnits: (s) => (s.startsWith('FUTURES_') ? 0.001 : 0.01),
          mcPaths: o.mcPaths,
          peerSymbols: symbols,
        });
        decisions++;
        prevRegime.set(sym, out.regime);
        lastRegime.set(sym, out.regime);
        lastFeatures.set(sym, out.record.snapshot.features);
        regimeCounts[out.regime.primary] = (regimeCounts[out.regime.primary] ?? 0) + 1;
        labels.push({ ts: clock.now(), symbol: sym, regime: out.regime.primary, confidence: out.regime.confidence, price: out.record.snapshot.spot });
        if (out.record.action === 'BLOCKED') blocked++;
        for (const c of out.record.candidates) {
          if (c.eligible) continue;
          const k = `${c.strategy}: ${(c.rejectedReasons[0] ?? '').replace(/[-\d.]+/g, '#')}`;
          rejections[k] = (rejections[k] ?? 0) + 1;
        }
        if (out.open && out.record.selected) {
          const cand = out.record.candidates.find((c) => c.strategy === out.record.selected)!;
          await pm.open({
            decisionId: out.record.id,
            candidate: cand,
            units: out.open.units,
            underlying: sym,
            regime: out.regime,
            modelVersion: o.model.version,
            exitPlan: out.open.exitPlan,
            stopDistance: out.open.stopDistance,
            leverage: out.open.leverage,
            features: out.record.snapshot.features,
          });
        }
      } else {
        // ---- naive baseline: ignore regime, trade a fixed (or random) structure whenever flat
        if (open.some((p) => p.underlying === sym)) continue;
        const choices = [...tradable];
        const strat = o.policy.kind === 'FIXED' ? o.policy.strategy : choices[Math.floor(rng() * choices.length)];
        if (!tradable.has(strat)) continue;
        const candles = Object.fromEntries(o.timeframes.map((tf) => [tf, view.closedCandles(sym, tf)]));
        const fv = extractFeatures({ candles, decisionTf: o.baseTf, higherTfs: o.timeframes.filter((x) => x !== o.baseTf), chainMetrics: view.chain(sym)?.metrics });
        if (!fv.price) continue;
        const regime = classify(sym, clock.now(), fv, o.model.params.regime, o.model.version);
        lastRegime.set(sym, regime);
        lastFeatures.set(sym, fv);
        const spot = view.lastPrice(sym)!.price;
        const tob = view.topOfBook(sym)!;
        const built = buildStrategy(strat, o.model.params.strategies[strat], {
          chain: view.chain(sym),
          futuresInstrument: sym,
          spot,
          bid: tob.bid,
          ask: tob.ask,
          now: clock.now(),
          minDte: limits.minDaysToExpiry,
          maxDte: limits.maxDaysToExpiry,
          atr: (fv.atrPct ?? 0.01) * spot,
          features: fv,
        });
        if ('error' in built) continue;
        const ev = evaluate(built.legs, {
          spot,
          now: clock.now(),
          rate: 0,
          forecastVol: forecastVolatility(fv, o.model.params),
          drift: alphaDrift(fv, regime, o.model.params, forecastVolatility(fv, o.model.params)).total,
          holdHours: Math.min(o.model.params.exits.maxHoldHours, limits.exits.maxHoldHours),
          expiryBufferHours: limits.exits.expiryBufferHours,
          takeProfitPct: o.model.params.exits.takeProfitPct,
          stopLossPct: o.model.params.exits.stopLossPct,
          costs,
          stopDistance: built.stopDistance,
          leverage: 1,
        });
        const cand = { strategy: strat, params: built.params, legs: built.legs, evaluation: ev, score: 0, regimeAffinity: 1, eligible: true, rejectedReasons: [] };
        const fakeRegime = { ...regime, confidence: 1 };
        const risk = assessEntry({
          candidate: cand,
          underlying: sym,
          regime: fakeRegime,
          account: snapshot,
          limits: relaxedLimits(limits),
          model: o.model.params,
          dataAgeMs: 0,
          now: clock.now(),
          spot,
          unitStep: strat.startsWith('FUTURES_') ? 0.001 : 0.01,
          minUnits: strat.startsWith('FUTURES_') ? 0.001 : 0.01,
        });
        decisions++;
        if (!risk.approved) {
          blocked++;
          continue;
        }
        const expiry = built.legs.find((l) => l.option)?.option?.expiry ?? null;
        await pm.open({
          decisionId: uuid(),
          candidate: cand,
          units: risk.units,
          underlying: sym,
          regime: fakeRegime,
          modelVersion: `baseline:${o.policy.kind}`,
          exitPlan: buildExitPlan(o.model.params, limits, clock.now(), expiry, strat),
          stopDistance: built.stopDistance,
          leverage: 1,
          features: fv,
        });
      }
    }
  }
  await pm.flattenAll('END_OF_BACKTEST');
  const fin = await pm.equity(account.book.cash);
  equity.push({ ts: clock.now(), equity: fin.equity });
  const trades = (await repos.trades.list({}, { limit: 1_000_000 })).map((t) => {
    const { _ledger, ...rest } = t;
    void _ledger;
    return { ...rest, source: 'BACKTEST' as const };
  });
  const label = o.label ?? (o.policy.kind === 'REGIME_ENGINE' ? `regime:${o.model.version}` : o.policy.kind === 'FIXED' ? `fixed:${o.policy.strategy}` : 'random');
  return {
    label,
    policy: o.policy,
    modelVersion: o.model.version,
    trades,
    equity,
    metrics: tradeMetrics(trades, balance),
    curve: curveMetrics(equity),
    byRegime: breakdown(trades, (t) => t.regime),
    byStrategy: breakdown(trades, (t) => t.strategy),
    decisions,
    blocked,
    regimeLabels: labels,
    regimeCounts,
    rejections,
    benchmark: buyAndHold(o.candles, start + o.warmupBars * tfMs, clock.now(), tfMs),
    from: start,
    to: clock.now(),
  };
}

export const BASELINE_POLICIES: Policy[] = [
  { kind: 'FIXED', strategy: 'LONG_STRADDLE' },
  { kind: 'FIXED', strategy: 'LONG_CALL' },
  { kind: 'FIXED', strategy: 'IRON_CONDOR' },
  { kind: 'RANDOM', seed: 11 },
];

function buyAndHold(candles: Record<string, Candle[]>, from: number, to: number, tfMs: number): CurveMetrics {
  const syms = Object.keys(candles);
  const series = syms.map((s) => candles[s].filter((c) => c.t + tfMs >= from && c.t + tfMs <= to));
  const n = Math.min(...series.map((x) => x.length));
  if (!(n > 1)) return curveMetrics([]);
  const pts: EquityPoint[] = [];
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (const x of series) e += x[i].c / x[0].c / series.length;
    pts.push({ ts: series[0][i].t + tfMs, equity: 10_000 * e });
  }
  return curveMetrics(pts);
}
