/**
 * Performance analytics over completed trades and equity curves.
 */
import type { TradeRecord } from '../persistence/ports.js';
import { mean, stdev, quantile } from '../lib/math.js';

export interface PerfMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  /** mean of per-trade return on risk (P&L / max loss) */
  expectancyR: number;
  profitFactor: number | null;
  payoffRatio: number | null;
  sharpePerTrade: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  totalFees: number;
  avgHoldHours: number;
  avgSlippage: number;
  /** realised / expected value at entry: execution & model calibration */
  evRealization: number | null;
  /** sorted per-trade R values (for statistics) */
  rValues: number[];
}

export function tradeMetrics(trades: Array<Pick<TradeRecord, 'realizedPnl' | 'returnOnRisk' | 'fees' | 'holdingMs' | 'slippageCost' | 'expectedValueAtEntry' | 'closedAt'>>, startEquity = 10_000): PerfMetrics {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const pnl = sorted.map((t) => t.realizedPnl);
  const r = sorted.map((t) => t.returnOnRisk).filter(Number.isFinite);
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  let eq = startEquity;
  let peak = startEquity;
  let mdd = 0;
  let mddPct = 0;
  for (const x of pnl) {
    eq += x;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, peak - eq);
    mddPct = Math.max(mddPct, peak > 0 ? (peak - eq) / peak : 0);
  }
  const evSum = sorted.reduce((a, t) => a + (t.expectedValueAtEntry ?? 0), 0);
  const sdR = stdev(r);
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRate: sorted.length ? wins.length / sorted.length : 0,
    totalPnl: pnl.reduce((a, b) => a + b, 0),
    avgPnl: mean(pnl),
    avgWin: mean(wins),
    avgLoss: losses.length ? -mean(losses) : 0,
    expectancyR: mean(r),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    payoffRatio: losses.length && wins.length ? mean(wins) / -mean(losses) : null,
    sharpePerTrade: sdR > 0 ? mean(r) / sdR : 0,
    maxDrawdown: mdd,
    maxDrawdownPct: mddPct * 100,
    totalFees: sorted.reduce((a, t) => a + (t.fees ?? 0), 0),
    avgHoldHours: mean(sorted.map((t) => t.holdingMs / 3_600_000)),
    avgSlippage: mean(sorted.map((t) => t.slippageCost ?? 0)),
    evRealization: Math.abs(evSum) > 1e-9 ? pnl.reduce((a, b) => a + b, 0) / evSum : null,
    rValues: r,
  };
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface CurveMetrics {
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdownPct: number;
  volatilityPct: number;
  var95Pct: number;
  cvar95Pct: number;
  days: number;
}

/** Daily-resampled equity curve metrics (annualised with 365 days - crypto trades every day). */
export function curveMetrics(points: EquityPoint[]): CurveMetrics {
  const empty: CurveMetrics = { totalReturnPct: 0, cagrPct: 0, sharpe: 0, sortino: 0, calmar: 0, maxDrawdownPct: 0, volatilityPct: 0, var95Pct: 0, cvar95Pct: 0, days: 0 };
  if (points.length < 2) return empty;
  const daily = new Map<number, number>();
  for (const p of points) daily.set(Math.floor(p.ts / 86_400_000), p.equity);
  const eq = [...daily.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const first = points[0].equity;
  const last = points[points.length - 1].equity;
  const days = Math.max(1, (points[points.length - 1].ts - points[0].ts) / 86_400_000);
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) if (eq[i - 1] > 0) rets.push(eq[i] / eq[i - 1] - 1);
  let peak = points[0].equity;
  let mdd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    mdd = Math.max(mdd, peak > 0 ? (peak - p.equity) / peak : 0);
  }
  const m = mean(rets);
  const sd = stdev(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const cagr = first > 0 && last > 0 ? (last / first) ** (365 / days) - 1 : -1;
  const q5 = rets.length ? quantile(rets, 0.05) : 0;
  const tail = rets.filter((r) => r <= q5);
  return {
    totalReturnPct: first > 0 ? (last / first - 1) * 100 : 0,
    cagrPct: cagr * 100,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(365) : 0,
    sortino: downside > 0 ? (m / downside) * Math.sqrt(365) : 0,
    calmar: mdd > 0 ? cagr / mdd : 0,
    maxDrawdownPct: mdd * 100,
    volatilityPct: sd * Math.sqrt(365) * 100,
    var95Pct: -q5 * 100,
    cvar95Pct: tail.length ? -mean(tail) * 100 : 0,
    days,
  };
}

/** Group trades by a key and compute metrics per group (e.g. by regime, by strategy, by regime x strategy). */
export function breakdown<T extends TradeRecord>(trades: T[], key: (t: T) => string): Record<string, PerfMetrics> {
  const g = new Map<string, T[]>();
  for (const t of trades) {
    const k = key(t);
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(t);
  }
  return Object.fromEntries([...g.entries()].map(([k, v]) => [k, tradeMetrics(v)]));
}

/** Rolling window metrics (last N trades) for drift detection. */
export function rolling(trades: TradeRecord[], window: number): PerfMetrics {
  const s = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  return tradeMetrics(s.slice(-window));
}
