/**
 * Predefined, versioned promotion criteria. A candidate model is promoted to PAPER only if its
 * out-of-sample walk-forward evidence passes EVERY check below. LIVE approval additionally needs
 * paper-trading evidence and an explicit operator action.
 */
import type { PerfMetrics } from './metrics.js';
import { tradeMetrics } from './metrics.js';
import type { WalkForwardResult } from './walkforward.js';
import { bootstrapMeanDiff, oneSampleT } from './stats.js';
import { validationReport } from '../research/validation.js';
import type { TradeRecord } from '../persistence/ports.js';

export const PROMOTION_CRITERIA_VERSION = 'pc-2026.10.25';

export interface CriteriaConfig {
  minOosTrades: number;
  alpha: number;
  maxDrawdownMultiple: number;
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PromotionVerdict {
  version: string;
  promote: boolean;
  checks: Check[];
  candidate: PerfMetrics;
  current: PerfMetrics;
  bestBaseline: { label: string; metrics: PerfMetrics } | null;
  stats: Record<string, number>;
}

export function evaluatePromotion(wf: WalkForwardResult, c: CriteriaConfig, currentHash: string): PromotionVerdict {
  const cand = tradeMetrics(wf.oosCandidateTrades);
  const cur = tradeMetrics(wf.oosCurrentTrades);
  const baselines = Object.entries(wf.oosBaselineTrades).map(([label, t]) => ({ label, metrics: tradeMetrics(t) }));
  const bestBaseline = baselines.filter((b) => b.metrics.trades >= 5).sort((a, b) => b.metrics.expectancyR - a.metrics.expectancyR)[0] ?? null;
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add('min_oos_trades', cand.trades >= c.minOosTrades, `${cand.trades} OOS trades (min ${c.minOosTrades})`);
  const t0 = oneSampleT(cand.rValues, 0);
  add('positive_expectancy', cand.expectancyR > 0 && t0.pGreater < Math.max(c.alpha * 2, 0.1), `mean R ${cand.expectancyR.toFixed(4)}, p(>0)=${t0.pGreater.toFixed(3)}`);
  add('profit_factor', (cand.profitFactor ?? Infinity) > 1.05, `PF ${cand.profitFactor === null ? 'inf' : cand.profitFactor.toFixed(2)}`);
  const vsCur = bootstrapMeanDiff(cand.rValues, cur.rValues.length ? cur.rValues : [0], 4000, 17);
  const identical = wf.finalHash === currentHash;
  add(
    'beats_current_oos',
    !identical && (cur.trades < 5 ? cand.expectancyR > 0 : vsCur.p < c.alpha),
    `${identical ? 'candidate identical to current; ' : ''}diff ${vsCur.diff.toFixed(4)} R, bootstrap p=${vsCur.p.toFixed(3)}, 95% CI [${vsCur.ci95.map((x) => x.toFixed(3)).join(', ')}]`,
  );
  const ddLimit = Math.max(cur.maxDrawdownPct * c.maxDrawdownMultiple, 2);
  add('drawdown_not_worse', cand.maxDrawdownPct <= ddLimit, `OOS max DD ${cand.maxDrawdownPct.toFixed(2)}% (limit ${ddLimit.toFixed(2)}%)`);
  if (bestBaseline) {
    const vsBase = bootstrapMeanDiff(cand.rValues, bestBaseline.metrics.rValues, 4000, 23);
    add('beats_best_baseline', vsBase.diff > 0 && vsBase.p < Math.max(c.alpha * 2, 0.1), `vs ${bestBaseline.label}: diff ${vsBase.diff.toFixed(4)} R, p=${vsBase.p.toFixed(3)}`);
  } else add('beats_best_baseline', cand.expectancyR > 0, 'no baseline with enough trades');
  const report = validationReport(wf, cand, 8);
  add(
    'deflated_sharpe',
    report.dsrUsable && report.dsr >= 0.9,
    report.dsrUsable ? `PSR ${report.psr.toFixed(3)}, DSR ${report.dsr.toFixed(3)} over ${report.trials} trials (min 0.90)` : report.details[0],
  );
  add(
    'pbo',
    report.pbo.usable && report.pbo.value < 0.5,
    report.pbo.usable ? `PBO ${report.pbo.value.toFixed(3)} over ${report.pbo.combinations} CSCV splits (max 0.50)` : report.pbo.reason,
  );
  const foldsPositive = wf.folds.filter((f) => f.oos.candidate.trades > 0 && f.oos.candidate.expectancyR > 0).length;
  add('fold_consistency', foldsPositive >= Math.ceil(wf.folds.length / 2), `${foldsPositive}/${wf.folds.length} folds with positive OOS expectancy`);

  return {
    version: PROMOTION_CRITERIA_VERSION,
    promote: checks.every((x) => x.passed),
    checks,
    candidate: cand,
    current: cur,
    bestBaseline,
    stats: { psr: report.psr, dsr: report.dsr, pbo: report.pbo.value, pVsCurrent: vsCur.p, trials: wf.trials },
  };
}

/** LIVE approval criteria: requires real PAPER evidence of the exact model version. */
export function evaluateLiveReadiness(paperTrades: TradeRecord[], minTrades: number, alpha: number): { ready: boolean; checks: Check[]; metrics: PerfMetrics } {
  const m = tradeMetrics(paperTrades);
  const t = oneSampleT(m.rValues, 0);
  const checks: Check[] = [
    { name: 'paper_trades', passed: m.trades >= minTrades, detail: `${m.trades} paper trades with this model (min ${minTrades})` },
    { name: 'paper_expectancy', passed: m.expectancyR > 0 && t.pGreater < Math.max(alpha * 2, 0.1), detail: `mean R ${m.expectancyR.toFixed(4)}, p=${t.pGreater.toFixed(3)}` },
    { name: 'paper_profit_factor', passed: (m.profitFactor ?? Infinity) > 1.1, detail: `PF ${m.profitFactor?.toFixed(2) ?? 'inf'}` },
    { name: 'ev_calibration', passed: m.evRealization === null || m.evRealization > 0.25, detail: `realised/expected ${m.evRealization?.toFixed(2) ?? 'n/a'}` },
  ];
  return { ready: checks.every((c) => c.passed), checks, metrics: m };
}
