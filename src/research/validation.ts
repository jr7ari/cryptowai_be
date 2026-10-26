/**
 * Overfitting diagnostics. DSR already lives in learning/stats.ts; this module adds PBO (Bailey,
 * Borwein, López de Prado, Zhu) and a fail-closed report. Missing inputs are NOT treated as a pass.
 */
import { deflatedSharpe, probabilisticSharpe } from '../learning/stats.js';
import type { WalkForwardResult } from '../learning/walkforward.js';
import type { PerfMetrics } from '../learning/metrics.js';

export interface PboResult {
  usable: boolean;
  value: number;
  combinations: number;
  reason: string;
}

/**
 * Combinatorially symmetric cross-validation PBO.
 * `perf[strategy][block]` = mean performance in that block. Needs ≥2 strategies and even S≥4 blocks.
 */
export function probabilityOfBacktestOverfitting(perf: number[][]): PboResult {
  const n = perf.length;
  const S = n ? perf[0].length : 0;
  if (n < 2) return { usable: false, value: NaN, combinations: 0, reason: 'need ≥2 strategy columns' };
  if (S < 4 || S % 2 !== 0) return { usable: false, value: NaN, combinations: 0, reason: 'need even block count ≥ 4' };
  if (perf.some((row) => row.length !== S)) return { usable: false, value: NaN, combinations: 0, reason: 'ragged performance matrix' };
  const half = S / 2;
  const combos = combinations(S, half);
  if (combos.length > 2000) return { usable: false, value: NaN, combinations: combos.length, reason: `too many CSCV splits (${combos.length})` };
  let logit = 0;
  let used = 0;
  for (const is of combos) {
    const isSet = new Set(is);
    const oos = Array.from({ length: S }, (_, i) => i).filter((i) => !isSet.has(i));
    const isScore = perf.map((row) => meanAt(row, is));
    const oosScore = perf.map((row) => meanAt(row, oos));
    let best = 0;
    for (let k = 1; k < n; k++) if (isScore[k] > isScore[best]) best = k;
    const ranked = [...oosScore].sort((a, b) => a - b);
    const pos = ranked.indexOf(oosScore[best]);
    const rel = ranked.length <= 1 ? 0.5 : pos / (ranked.length - 1);
    if (rel < 0.5) logit++;
    used++;
  }
  return { usable: true, value: used ? logit / used : NaN, combinations: used, reason: 'ok' };
}

function meanAt(row: number[], idx: number[]): number {
  return idx.reduce((a, i) => a + row[i], 0) / idx.length;
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (start: number) => {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

export interface ValidationReport {
  trials: number;
  oosTrades: number;
  dsrUsable: boolean;
  dsr: number;
  psr: number;
  pbo: PboResult;
  details: string[];
}

export function validationReport(wf: WalkForwardResult, oos: PerfMetrics, minTrials = 8): ValidationReport {
  const trials = wf.trials;
  const dsrUsable = trials >= minTrials && oos.rValues.length >= 5;
  const psr = probabilisticSharpe(oos.rValues, 0);
  const dsr = dsrUsable ? deflatedSharpe(oos.rValues, trials, wf.trialSharpeVariance) : NaN;
  const pbo: PboResult = {
    usable: false,
    value: NaN,
    combinations: 0,
    reason: 'walk-forward does not emit a CSCV strategy×block matrix; PBO not computed (not a pass)',
  };
  const details = [
    dsrUsable ? `DSR ${dsr.toFixed(3)} over ${trials} trials` : `DSR unused: trials=${trials} (min ${minTrials}), n=${oos.rValues.length}`,
    `PSR ${psr.toFixed(3)}`,
    `PBO: ${pbo.reason}`,
  ];
  return { trials, oosTrades: oos.trades, dsrUsable, dsr, psr, pbo, details };
}
