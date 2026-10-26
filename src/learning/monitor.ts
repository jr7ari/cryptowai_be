/**
 * Live/paper performance monitor with automatic rollback. A model that underperforms its validated
 * out-of-sample baseline (significantly negative expectancy or a drawdown well beyond what was seen
 * out-of-sample) is rolled back to its parent. Hard risk limits are enforced independently by the
 * risk engine/kill switch - this monitor only governs WHICH MODEL is active.
 */
import type { Mode } from '../domain/types.js';
import type { Repositories } from '../persistence/ports.js';
import type { ModelRegistry } from '../model/registry.js';
import { tradeMetrics } from './metrics.js';
import { oneSampleT, bootstrapMeanDiff } from './stats.js';
import { stripLedger } from '../persistence/ledger.js';

export interface RollbackPolicy {
  minTrades: number;
  alpha: number;
  drawdownMultiple: number;
}

export interface MonitorReport {
  mode: Mode;
  modelVersion: string | null;
  trades: number;
  expectancyR: number;
  maxDrawdownPct: number;
  validatedExpectancyR?: number;
  validatedMaxDrawdownPct?: number;
  action: 'NONE' | 'ROLLED_BACK' | 'INSUFFICIENT_DATA' | 'NO_BASELINE';
  reasons: string[];
  rolledBackTo?: string | null;
}

export async function monitorAndRollback(repos: Repositories, registry: ModelRegistry, mode: Mode, policy: RollbackPolicy): Promise<MonitorReport> {
  const active = await repos.models.activeFor(mode);
  if (!active) return { mode, modelVersion: null, trades: 0, expectancyR: 0, maxDrawdownPct: 0, action: 'NONE', reasons: ['no active model'] };
  const since = mode === 'LIVE' ? active.approvedAt ?? active.createdAt : active.createdAt;
  const rows = (await repos.trades.list({ modelVersion: active.version, mode }, { limit: 100_000 })).map((t) => stripLedger(t)).filter((t) => t.closedAt >= since);
  const m = tradeMetrics(rows);
  const v = active.validation as { oosExpectancyR?: number; oosMaxDrawdownPct?: number; oosRValues?: number[] } | undefined;
  const rep: MonitorReport = {
    mode,
    modelVersion: active.version,
    trades: m.trades,
    expectancyR: m.expectancyR,
    maxDrawdownPct: m.maxDrawdownPct,
    validatedExpectancyR: v?.oosExpectancyR,
    validatedMaxDrawdownPct: v?.oosMaxDrawdownPct,
    action: 'NONE',
    reasons: [],
  };
  if (m.trades < policy.minTrades) {
    rep.action = 'INSUFFICIENT_DATA';
    rep.reasons.push(`${m.trades} trades < ${policy.minTrades}`);
    return rep;
  }
  const reasons: string[] = [];
  const t = oneSampleT(m.rValues, 0);
  if (m.expectancyR < 0 && t.pLess < policy.alpha) reasons.push(`expectancy ${m.expectancyR.toFixed(4)} R significantly < 0 (p=${t.pLess.toFixed(3)})`);
  if (v?.oosMaxDrawdownPct !== undefined) {
    const limit = Math.max(v.oosMaxDrawdownPct * policy.drawdownMultiple, 1);
    if (m.maxDrawdownPct > limit) reasons.push(`drawdown ${m.maxDrawdownPct.toFixed(2)}% > ${policy.drawdownMultiple}x validated ${v.oosMaxDrawdownPct.toFixed(2)}%`);
  }
  if (v?.oosRValues?.length) {
    const b = bootstrapMeanDiff(v.oosRValues, m.rValues, 3000, 31); // H1: validated > live
    if (b.p < policy.alpha) reasons.push(`live expectancy significantly below validated OOS (p=${b.p.toFixed(3)})`);
  }
  if (!active.parentVersion && !reasons.length) return rep;
  if (!reasons.length) return rep;
  if (!active.parentVersion) {
    rep.action = 'NO_BASELINE';
    rep.reasons = [...reasons, 'baseline model has no parent to roll back to - alerting operator'];
    return rep;
  }
  const to = await registry.rollback(mode, reasons.join('; '), { trades: m.trades, expectancyR: m.expectancyR, maxDrawdownPct: m.maxDrawdownPct });
  rep.action = 'ROLLED_BACK';
  rep.reasons = reasons;
  rep.rolledBackTo = to;
  return rep;
}
