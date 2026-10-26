/**
 * Exit-engine comparison on IDENTICAL data, seed, entry logic and execution assumptions.
 *
 * Variants:
 *   legacy        %-of-risk SL/TP/trailing only (Profit Guard off)          - the pre-2026-10-25 system
 *   legacy+guard  %-of-risk rules + Profit Guard                            - the 2026-10-25 system
 *   v2+guard      Exit Engine v2 (R stop, milestones, Chandelier) + guard   - new default (PAPER)
 *   v2            Exit Engine v2 without the guard
 *
 * The backtests are path-dependent: when an exit happens earlier or later, the next entry can differ
 * (one position per underlying). The report therefore also states how many entries were shared.
 *
 * Results are split chronologically: the first `isFraction` of the window is in-sample (where exit
 * parameters may have been chosen), the rest is held out. Parameters must NOT be tuned on the
 * held-out part; re-running with different parameters and then picking the best OOS number is
 * selection bias - the report prints how many variants were evaluated so that can be accounted for.
 */
import type { AppConfig } from '../config/index.js';
import type { Candle, OptionChainSnapshot, Timeframe } from '../domain/types.js';
import type { TradeRecord } from '../persistence/ports.js';
import { runBacktest, type BacktestResult } from './engine.js';
import { tradeMetrics, curveMetrics, type PerfMetrics, type CurveMetrics, type EquityPoint } from '../learning/metrics.js';
import type { ActiveModel } from '../model/registry.js';

export interface ExitVariant {
  label: string;
  exits: Partial<AppConfig['exits']>;
}

export const EXIT_VARIANTS: ExitVariant[] = [
  { label: 'legacy', exits: { engine: 'legacy', profitGuardEnabled: false } },
  { label: 'legacy+guard', exits: { engine: 'legacy', profitGuardEnabled: true } },
  { label: 'v2+guard', exits: { engine: 'v2', profitGuardEnabled: true } },
  { label: 'v2', exits: { engine: 'v2', profitGuardEnabled: false } },
];

export interface WindowStats {
  metrics: PerfMetrics;
  curve: CurveMetrics;
  /** net P&L without the 5 best trades: is the result carried by a few outliers? */
  pnlExTop5: number;
  /** average win / loss and expectancy in money, after all modelled costs (fees inside realizedPnl) */
  expectancyMoney: number;
  grossPnl: number;
  fees: number;
  funding: number;
}

export interface VariantResult {
  label: string;
  all: WindowStats;
  inSample: WindowStats;
  outOfSample: WindowStats;
  exitReasons: Record<string, number>;
  partialBookings: number;
  entries: number;
}

export interface CompareReport {
  window: { from: number; to: number; split: number };
  variants: VariantResult[];
  /** entries (decision timestamps) shared by every variant / union of entries */
  sharedEntries: number;
  unionEntries: number;
  variantsEvaluated: number;
  stress?: VariantResult[];
}

function windowStats(trades: TradeRecord[], equity: EquityPoint[], startEquity: number): WindowStats {
  const metrics = tradeMetrics(trades, startEquity);
  const pnl = trades.map((t) => t.realizedPnl).sort((a, b) => b - a);
  return {
    metrics,
    curve: curveMetrics(equity),
    pnlExTop5: pnl.slice(5).reduce((a, b) => a + b, 0),
    expectancyMoney: trades.length ? metrics.totalPnl / trades.length : 0,
    grossPnl: trades.reduce((a, t) => a + (t.grossPnl ?? t.realizedPnl + t.fees + t.funding), 0),
    fees: trades.reduce((a, t) => a + t.fees, 0),
    funding: trades.reduce((a, t) => a + t.funding, 0),
  };
}

function summarize(label: string, r: BacktestResult, split: number, startEquity: number): VariantResult {
  const isT = r.trades.filter((t) => t.openedAt < split);
  const oosT = r.trades.filter((t) => t.openedAt >= split);
  const isE = r.equity.filter((e) => e.ts < split);
  const oosE = r.equity.filter((e) => e.ts >= split);
  const exitReasons: Record<string, number> = {};
  let partials = 0;
  for (const t of r.trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
    partials += (t.bookings ?? []).filter((b) => b.kind === 'PARTIAL').length;
  }
  return {
    label,
    all: windowStats(r.trades, r.equity, startEquity),
    inSample: windowStats(isT, isE, startEquity),
    outOfSample: windowStats(oosT, oosE, oosE[0]?.equity ?? startEquity),
    exitReasons,
    partialBookings: partials,
    entries: r.trades.length,
  };
}

export interface CompareOptions {
  /** builds the config for a variant (exits overrides merged by the caller's loader) */
  configFor: (exits: Partial<AppConfig['exits']>, paper?: Partial<AppConfig['paper']>) => AppConfig;
  candles: Record<string, Candle[]>;
  chains?: Record<string, OptionChainSnapshot[]>;
  baseTf: Timeframe;
  timeframes: Timeframe[];
  model: ActiveModel;
  warmupBars: number;
  decisionEveryBars?: number;
  isFraction?: number;
  seed?: number;
  /** cost stress: multiply fees and slippage on the best two variants */
  stressCostMultiple?: number;
  variants?: ExitVariant[];
}

export async function compareExits(o: CompareOptions): Promise<CompareReport> {
  const variants = o.variants ?? EXIT_VARIANTS;
  const results: Array<{ v: ExitVariant; r: BacktestResult }> = [];
  for (const v of variants) {
    const cfg = o.configFor(v.exits);
    const r = await runBacktest({
      config: cfg, candles: o.candles, chains: o.chains, baseTf: o.baseTf, timeframes: o.timeframes, decisionEveryBars: o.decisionEveryBars ?? 1,
      warmupBars: o.warmupBars, model: o.model, policy: { kind: 'REGIME_ENGINE' }, seed: o.seed ?? 1, label: v.label, quiet: true,
    });
    results.push({ v, r });
  }
  const from = Math.min(...results.map((x) => x.r.from));
  const to = Math.max(...results.map((x) => x.r.to));
  const split = from + (to - from) * (o.isFraction ?? 0.6);
  const start = o.configFor({}).paper.startingBalance;
  const report: CompareReport = {
    window: { from, to, split },
    variants: results.map(({ v, r }) => summarize(v.label, r, split, start)),
    sharedEntries: 0,
    unionEntries: 0,
    variantsEvaluated: variants.length,
  };
  const sets = results.map(({ r }) => new Set(r.trades.map((t) => `${t.underlying}@${t.openedAt}:${t.strategy}`)));
  const union = new Set(sets.flatMap((s) => [...s]));
  report.unionEntries = union.size;
  report.sharedEntries = [...union].filter((k) => sets.every((s) => s.has(k))).length;

  if (o.stressCostMultiple && o.stressCostMultiple > 1) {
    report.stress = [];
    for (const v of variants) {
      const base = o.configFor(v.exits);
      const cfg = o.configFor(v.exits, {
        takerFeeBps: base.paper.takerFeeBps * o.stressCostMultiple,
        makerFeeBps: base.paper.makerFeeBps * o.stressCostMultiple,
        slippageBps: base.paper.slippageBps * o.stressCostMultiple,
      });
      const r = await runBacktest({
        config: cfg, candles: o.candles, chains: o.chains, baseTf: o.baseTf, timeframes: o.timeframes, decisionEveryBars: o.decisionEveryBars ?? 1,
        warmupBars: o.warmupBars, model: o.model, policy: { kind: 'REGIME_ENGINE' }, seed: o.seed ?? 1, label: `${v.label} x${o.stressCostMultiple} costs`, quiet: true,
      });
      report.stress.push(summarize(`${v.label} x${o.stressCostMultiple} costs`, r, split, start));
    }
    report.variantsEvaluated += variants.length;
  }
  return report;
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');

export function formatReport(rep: CompareReport): string {
  const out: string[] = [];
  const d = (t: number) => new Date(t).toISOString().slice(0, 10);
  out.push(`Window ${d(rep.window.from)} -> ${d(rep.window.to)}; in-sample < ${d(rep.window.split)} <= held-out`);
  out.push(`Entries shared by all variants: ${rep.sharedEntries}/${rep.unionEntries} (path dependence: exit timing changes later entries)`);
  out.push(`Variants evaluated (count them as trials for selection bias): ${rep.variantsEvaluated}\n`);
  const head = ['variant'.padEnd(22), 'window', 'trades', ' win%', ' exp(R)', ' exp($)', '    PF', '  net $', ' gross $', '  fees $', ' ex-top5', ' ret%', 'sharpe', 'sortino', ' maxDD%'];
  out.push(head.join(' '));
  const rows = [...rep.variants, ...(rep.stress ?? [])];
  for (const v of rows) {
    for (const [w, s] of [['ALL', v.all], ['IS', v.inSample], ['OOS', v.outOfSample]] as const) {
      const m = s.metrics;
      out.push(
        [
          (w === 'ALL' ? v.label : '').padEnd(22), w.padEnd(6), String(m.trades).padStart(6), f(m.winRate * 100, 1).padStart(5), f(m.expectancyR, 3).padStart(7),
          f(s.expectancyMoney).padStart(7), (m.profitFactor === null ? 'inf' : f(m.profitFactor)).padStart(6), f(m.totalPnl).padStart(8), f(s.grossPnl).padStart(8),
          f(s.fees).padStart(8), f(s.pnlExTop5).padStart(8), f(s.curve.totalReturnPct).padStart(5), f(s.curve.sharpe).padStart(6), f(s.curve.sortino).padStart(7), f(s.curve.maxDrawdownPct).padStart(7),
        ].join(' '),
      );
    }
    out.push(`${''.padEnd(22)} exits: ${Object.entries(v.exitReasons).map(([k, n]) => `${k}=${n}`).join(', ') || '-'}; partial bookings ${v.partialBookings}`);
  }
  out.push('\nRead this before acting: prefer the variant with the better HELD-OUT net expectancy and drawdown, not the higher win');
  out.push('rate. Small trade counts (< ~30 per window) are noise. Simulated results do not guarantee future results.');
  return out.join('\n');
}
