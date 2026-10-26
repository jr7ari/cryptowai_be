/**
 * Anchored-rolling walk-forward optimisation with strict train/test separation.
 *
 * For each fold:
 *   TRAIN  : backtest the current model -> calibrate regime drift from forward returns (train only),
 *            adjust regime x strategy affinity from train trades, then evaluate bounded random
 *            perturbations; choose the candidate with the best lower-confidence-bound expectancy.
 *   TEST   : run the chosen candidate, the current model and naive baselines on UNSEEN data.
 * The out-of-sample trades of the procedure across all folds are the evidence used for promotion.
 */
import type { Candle, StrategyName, Timeframe, OptionChainSnapshot } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import type { AppConfig } from '../config/index.js';
import type { ActiveModel } from '../model/registry.js';
import type { ModelParams } from '../model/params.js';
import { maxRelativeChange, modelHash, enforceBounds } from '../model/params.js';
import { runBacktest, BASELINE_POLICIES, type BacktestResult, type Policy, type BacktestOptions } from '../backtest/engine.js';
import { calibrateDrift, adjustAffinity, perturb } from './calibration.js';
import { tradeMetrics, type PerfMetrics } from './metrics.js';
import { mean, stdev } from '../lib/math.js';
import type { TradeRecord } from '../persistence/ports.js';

export interface WalkForwardInput {
  config: AppConfig;
  candles: Record<string, Candle[]>;
  baseTf: Timeframe;
  timeframes: Timeframe[];
  current: ActiveModel;
  trainBars: number;
  testBars: number;
  folds: number;
  decisionEveryBars: number;
  candidates: number;
  maxChangePct: number;
  seed: number;
  mcPaths?: number;
  /**
   * Drop this many bars between train end and test start so label horizons do not overlap the
   * holdout. Default 0 preserves historical walk-forward evidence. Set to the EV horizon in bars
   * when re-running research.
   */
  embargoBars?: number;
  tradable?: Set<StrategyName>;
  /** REAL recorded option-chain snapshots (options only trade where these exist) */
  chains?: Record<string, OptionChainSnapshot[]>;
  /** unit tests only */
  chainProvider?: BacktestOptions['chainProvider'];
  onProgress?: (msg: string) => void;
}

export interface FoldResult {
  fold: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  chosen: { params: ModelParams; hash: string; changes: string[]; trainScore: number; trainMetrics: PerfMetrics };
  oos: { candidate: PerfMetrics; current: PerfMetrics; baselines: Record<string, PerfMetrics> };
  driftSamples: Record<string, number>;
  trialsSharpe: number[];
}

export interface WalkForwardResult {
  folds: FoldResult[];
  finalParams: ModelParams;
  finalHash: string;
  oosCandidateTrades: TradeRecord[];
  oosCurrentTrades: TradeRecord[];
  oosBaselineTrades: Record<string, TradeRecord[]>;
  trials: number;
  trialSharpeVariance: number;
}

/** Lower confidence bound of mean R, penalising tiny samples. */
export function lcbScore(m: PerfMetrics, minTrades: number): number {
  if (m.trades < minTrades) return -Infinity;
  const sd = stdev(m.rValues);
  return m.expectancyR - (sd / Math.sqrt(m.trades)) * 1.0;
}

export async function walkForward(i: WalkForwardInput): Promise<WalkForwardResult> {
  const ms = TIMEFRAME_MS[i.baseTf];
  const all = [...new Set(Object.values(i.candles).flatMap((c) => c.map((x) => x.t)))].sort((a, b) => a - b);
  const warm = 250;
  const needed = warm + i.trainBars + i.testBars * i.folds;
  if (all.length < needed) throw new Error(`walk-forward needs ${needed} bars, have ${all.length}`);
  const firstTrainStart = all.length - (i.trainBars + i.testBars * i.folds);
  const folds: FoldResult[] = [];
  const oosCand: TradeRecord[] = [];
  const oosCur: TradeRecord[] = [];
  const oosBase: Record<string, TradeRecord[]> = {};
  let finalParams = i.current.params;
  let trials = 0;
  const trialSharpes: number[] = [];
  const common = {
    config: i.config,
    candles: i.candles,
    baseTf: i.baseTf,
    timeframes: i.timeframes,
    decisionEveryBars: i.decisionEveryBars,
    warmupBars: 0,
    mcPaths: i.mcPaths ?? 200,
    tradable: i.tradable,
    chains: i.chains,
    chainProvider: i.chainProvider,
  };
  const minTrainTrades = Math.max(8, Math.round(i.trainBars / i.decisionEveryBars / 40));

  for (let f = 0; f < i.folds; f++) {
    const trS = all[firstTrainStart + f * i.testBars];
    const trE = all[firstTrainStart + f * i.testBars + i.trainBars - 1] + ms;
    const embargo = Math.max(0, i.embargoBars ?? 0) * ms;
    const teS = trE + embargo;
    const teIdxEnd = Math.min(all.length - 1, firstTrainStart + f * i.testBars + i.trainBars + i.testBars - 1);
    const teE = all[teIdxEnd] + ms;
    i.onProgress?.(`fold ${f + 1}/${i.folds}: train ${new Date(trS).toISOString()} -> ${new Date(trE).toISOString()}`);

    // 1) current model on train -> regime labels + trades
    const run = (params: ModelParams, label: string, from: number, to: number, policy: Policy = { kind: 'REGIME_ENGINE' }) =>
      runBacktest({ ...common, model: { version: label, params }, policy, from, to: to - ms, label: policy.kind === 'REGIME_ENGINE' ? label : undefined, seed: i.seed + f });
    const baseTrain = await run(i.current.params, `current`, trS, trE);

    // 2) calibrate drift + affinity from TRAIN ONLY
    const calibrated = structuredClone(i.current.params);
    const horizonBars = Math.max(1, Math.round((calibrated.exits.maxHoldHours * 3_600_000) / ms));
    const { drift, samples } = calibrateDrift(baseTrain.regimeLabels, i.candles, i.baseTf, horizonBars, trE);
    const changes: string[] = [];
    for (const [r, d] of Object.entries(drift)) {
      const prev = calibrated.forecast.drift[r as keyof typeof calibrated.forecast.drift];
      calibrated.forecast.drift[r as keyof typeof calibrated.forecast.drift] = d!;
      changes.push(`forecast.drift.${r}: ${prev.toFixed(3)} -> ${d!.toFixed(3)} (n=${samples[r as keyof typeof samples]})`);
    }
    changes.push(...adjustAffinity(calibrated, baseTrain.trades));
    enforceBounds(calibrated);

    // 3) candidate search on TRAIN
    const pool: Array<{ params: ModelParams; changes: string[] }> = [{ params: calibrated, changes }];
    for (let k = 1; k < i.candidates; k++) {
      const pt = perturb(calibrated, i.maxChangePct, i.seed * 1000 + f * 100 + k);
      pool.push({ params: pt.params, changes: [...changes, ...pt.changed] });
    }
    let best: { params: ModelParams; changes: string[]; score: number; res: BacktestResult } | null = null;
    const curScore = lcbScore(baseTrain.metrics, minTrainTrades);
    for (const cand of pool) {
      // change-rate limit vs the current model
      if (maxRelativeChange(i.current.params, cand.params).change > (i.maxChangePct / 100) * 1.5 + 1e-9 && cand !== pool[0]) continue;
      const res = await run(cand.params, `cand-${modelHash(cand.params)}`, trS, trE);
      trials++;
      trialSharpes.push(res.metrics.sharpePerTrade);
      const sc = lcbScore(res.metrics, minTrainTrades);
      if (!best || sc > best.score) best = { ...cand, score: sc, res };
    }
    // keep the current model if no candidate beats it in-sample
    const chosen =
      best && best.score > curScore
        ? best
        : { params: i.current.params, changes: ['no in-sample improvement: kept current'], score: curScore, res: baseTrain };

    // 4) OUT-OF-SAMPLE evaluation on the test window
    i.onProgress?.(`fold ${f + 1}/${i.folds}: testing ${new Date(teS).toISOString()} -> ${new Date(teE).toISOString()}`);
    const candOos = await run(chosen.params, 'oos-candidate', teS, teE);
    const curOos = await run(i.current.params, 'oos-current', teS, teE);
    const baseRes: Record<string, PerfMetrics> = {};
    for (const bp of BASELINE_POLICIES) {
      const r = await run(i.current.params, 'baseline', teS, teE, bp);
      baseRes[r.label] = r.metrics;
      (oosBase[r.label] ??= []).push(...r.trades);
    }
    oosCand.push(...candOos.trades);
    oosCur.push(...curOos.trades);
    folds.push({
      fold: f + 1,
      trainFrom: trS,
      trainTo: trE,
      testFrom: teS,
      testTo: teE,
      chosen: { params: chosen.params, hash: modelHash(chosen.params), changes: chosen.changes, trainScore: chosen.score, trainMetrics: chosen.res.metrics },
      oos: { candidate: candOos.metrics, current: curOos.metrics, baselines: baseRes },
      driftSamples: samples as Record<string, number>,
      trialsSharpe: trialSharpes.slice(),
    });
    finalParams = chosen.params; // most recent fold's choice is the deployable model
  }
  const sv = trialSharpes.length > 1 ? stdev(trialSharpes) ** 2 : 0;
  return {
    folds,
    finalParams,
    finalHash: modelHash(finalParams),
    oosCandidateTrades: oosCand,
    oosCurrentTrades: oosCur,
    oosBaselineTrades: oosBase,
    trials,
    trialSharpeVariance: sv,
  };
}

export function summarizeOos(r: WalkForwardResult) {
  return {
    candidate: tradeMetrics(r.oosCandidateTrades),
    current: tradeMetrics(r.oosCurrentTrades),
    baselines: Object.fromEntries(Object.entries(r.oosBaselineTrades).map(([k, v]) => [k, tradeMetrics(v)])),
    meanFoldExpectancy: mean(r.folds.map((f) => f.oos.candidate.expectancyR)),
  };
}
