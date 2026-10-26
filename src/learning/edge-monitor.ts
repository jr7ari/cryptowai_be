/**
 * Strategy-level edge monitor ("pause and investigate").
 *
 * The model-level monitor (learning/monitor.ts) rolls back a whole model. This one works per
 * strategy: when the most recent closed trades of a strategy show a statistically negative
 * expectancy, new entries for that strategy are paused (existing positions keep their exits).
 *
 *   t = mean(R) / (sd(R) / sqrt(n))   over the last `window` trades (n >= minTrades)
 *   pause if mean(R) < 0 and t <= tStat, or cumulative R <= -maxCumLossR
 *
 * A pause lasts `pauseHours` after the latest trade, then the strategy is on probation: the next
 * losing trade re-evaluates the same window and re-pauses it. Nothing here can enable LIVE trading.
 */
import type { StrategyName } from '../domain/types.js';
import type { TradeRecord } from '../persistence/ports.js';

export interface EdgeMonitorOptions {
  window: number;
  minTrades: number;
  /** pause when the t-statistic of mean R is at or below this (negative) value */
  tStat: number;
  /** pause when cumulative R over the window is at or below -maxCumLossR */
  maxCumLossR: number;
  pauseHours: number;
  now: number;
}

export interface EdgeStatus {
  strategy: StrategyName;
  n: number;
  meanR: number;
  t: number;
  cumR: number;
  paused: boolean;
  reason?: string;
  until?: number;
}

export function edgeStatus(trades: Array<Pick<TradeRecord, 'strategy' | 'returnOnRisk' | 'closedAt'>>, o: EdgeMonitorOptions): EdgeStatus[] {
  const by = new Map<StrategyName, typeof trades>();
  for (const t of trades) {
    if (!Number.isFinite(t.returnOnRisk)) continue;
    const a = by.get(t.strategy) ?? [];
    a.push(t);
    by.set(t.strategy, a);
  }
  const out: EdgeStatus[] = [];
  for (const [strategy, list] of by) {
    const last = [...list].sort((a, b) => a.closedAt - b.closedAt).slice(-o.window);
    const r = last.map((t) => t.returnOnRisk);
    const n = r.length;
    const meanR = n ? r.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(r.reduce((a, b) => a + (b - meanR) ** 2, 0) / (n - 1)) : 0;
    const t = sd > 0 ? meanR / (sd / Math.sqrt(n)) : meanR < 0 ? -Infinity : 0;
    const cumR = r.reduce((a, b) => a + b, 0);
    const until = (last[n - 1]?.closedAt ?? 0) + o.pauseHours * 3_600_000;
    let reason: string | undefined;
    if (n >= o.minTrades && meanR < 0 && t <= o.tStat) reason = `last ${n} trades: mean ${meanR.toFixed(3)}R, t=${t.toFixed(2)} <= ${o.tStat}`;
    else if (n >= Math.min(o.minTrades, 5) && cumR <= -o.maxCumLossR) reason = `last ${n} trades lost ${cumR.toFixed(2)}R (limit -${o.maxCumLossR}R)`;
    const paused = !!reason && o.now < until;
    out.push({ strategy, n, meanR, t, cumR, paused, reason: paused ? reason : undefined, until: paused ? until : undefined });
  }
  return out;
}

export function pausedStrategies(trades: Parameters<typeof edgeStatus>[0], o: EdgeMonitorOptions): Map<StrategyName, string> {
  return new Map(edgeStatus(trades, o).filter((s) => s.paused).map((s) => [s.strategy, `edge monitor: ${s.reason} (paused until ${new Date(s.until!).toISOString()})`]));
}
