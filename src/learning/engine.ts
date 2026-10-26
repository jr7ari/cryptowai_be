/**
 * Adaptive-learning orchestrator.
 *  - every cycle: performance monitor + automatic rollback for PAPER and LIVE active models
 *  - when due (or on demand): walk-forward optimisation in a worker thread -> promotion criteria ->
 *    candidate recorded (VALIDATED or REJECTED) -> optional auto-activation in PAPER only
 *  - LIVE approval is ONLY via approveLive() called by an operator, gated by paper evidence
 * The learning engine has no access to hard risk limits other than reading them.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../persistence/ports.js';
import type { ModelRegistry } from '../model/registry.js';
import type { Timeframe } from '../domain/types.js';
import { loadLatestRealData } from '../backtest/data.js';
import { parseMap } from '../config/index.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import type { FuturesExchangeClient } from '../integrations/exchange.js';
import { fetchAndStoreHistory, walkForwardBarsNeeded } from '../marketdata/history.js';
import { walkForward, type WalkForwardInput, type WalkForwardResult, summarizeOos } from './walkforward.js';
import { evaluatePromotion, evaluateLiveReadiness, type PromotionVerdict } from './promotion.js';
import { monitorAndRollback, type MonitorReport } from './monitor.js';
import { modelHash, type ModelParams } from '../model/params.js';
import { uuid } from '../lib/ids.js';
import type { Clock } from '../lib/clock.js';
import { MS } from '../lib/clock.js';
import { childLogger } from '../lib/logger.js';
import type { Alerts } from '../monitoring/alerts.js';
import { stripLedger } from '../persistence/ledger.js';

const log = childLogger('learning');

export interface LearningStatus {
  running: boolean;
  lastRunAt?: number;
  lastMonitor?: MonitorReport[];
  lastVerdict?: { promote: boolean; candidateVersion?: string; checks: PromotionVerdict['checks']; summary: unknown };
  progress: string[];
  error?: string;
}

export class LearningEngine {
  status: LearningStatus = { running: false, progress: [] };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly cfg: AppConfig,
    private readonly repos: Repositories,
    private readonly registry: ModelRegistry,
    private readonly clock: Clock,
    private readonly alerts: Alerts,
    private readonly rest?: Pick<FuturesExchangeClient, 'candles'>,
  ) {}

  start() {
    if (!this.cfg.learning.enabled) return;
    const tick = () => this.cycle().catch((e) => log.error({ err: (e as Error).message }, 'learning cycle failed'));
    void tick();
    this.timer = setInterval(tick, this.cfg.learning.evaluationIntervalMin * MS.m);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async cycle(): Promise<void> {
    const policy = { minTrades: this.cfg.learning.rollbackMinTrades, alpha: this.cfg.learning.significanceAlpha, drawdownMultiple: this.cfg.learning.rollbackDrawdownMultiple };
    const reports = [await monitorAndRollback(this.repos, this.registry, 'PAPER', policy), await monitorAndRollback(this.repos, this.registry, 'LIVE', policy)];
    this.status.lastMonitor = reports;
    for (const r of reports) {
      if (r.action === 'ROLLED_BACK') await this.alerts.raise('error', 'MODEL_ROLLBACK', `${r.mode} model ${r.modelVersion} rolled back to ${r.rolledBackTo}: ${r.reasons.join('; ')}`);
      if (r.action === 'NO_BASELINE') await this.alerts.raise('warn', 'MODEL_UNDERPERFORMING', `${r.mode} model ${r.modelVersion}: ${r.reasons.join('; ')}`);
    }
    const last = (await this.repos.state.get<number>('learning.lastWalkForwardAt')) ?? 0;
    if (this.clock.now() - last >= 24 * MS.h) {
      if (this.status.running) return;
      await this.runWalkForward('scheduled');
    }
  }

  private async loadData(tf: Timeframe, bars: number) {
    return loadLatestRealData(this.repos, this.cfg.app.symbols, parseMap(this.cfg.app.underlyingMap), tf, bars, this.clock.now());
  }

  private runInWorker(input: Omit<WalkForwardInput, 'onProgress'>): Promise<WalkForwardResult> {
    const here = fileURLToPath(import.meta.url);
    const isTs = here.endsWith('.ts');
    const workerPath = here.replace(/engine\.(ts|js)$/, `worker.${isTs ? 'ts' : 'js'}`);
    if (!existsSync(workerPath)) return walkForward({ ...input, onProgress: (m) => this.progress(m) });
    return new Promise((resolve, reject) => {
      const w = new Worker(workerPath, {
        workerData: { ...input, tradable: input.tradable ? [...input.tradable] : undefined },
        execArgv: isTs ? ['--import', 'tsx'] : [],
      });
      w.on('message', (m: { type: string; message?: string; result?: WalkForwardResult; error?: string }) => {
        if (m.type === 'progress') this.progress(m.message!);
        if (m.type === 'done') resolve(m.result!);
        if (m.type === 'error') reject(new Error(m.error));
      });
      w.on('error', reject);
      w.on('exit', (code) => code !== 0 && reject(new Error(`learning worker exited with ${code}`)));
    });
  }

  private progress(m: string) {
    this.status.progress.push(`${new Date(this.clock.now()).toISOString()} ${m}`);
    if (this.status.progress.length > 50) this.status.progress.shift();
    log.info(m);
  }

  async runWalkForward(trigger: string): Promise<LearningStatus['lastVerdict'] | null> {
    if (this.status.running) throw new Error('walk-forward already running');
    const current = await this.registry.active('PAPER');
    if (!current) throw new Error('no active PAPER model');
    this.status = { ...this.status, running: true, progress: [], error: undefined };
    const L = this.cfg.learning;
    const tf = this.cfg.app.decisionTimeframe;
    const barsPerDay = MS.d / TIMEFRAME_MS[tf];
    const trainBars = Math.round(L.walkForwardTrainDays * barsPerDay);
    const testBars = Math.round(L.walkForwardTestDays * barsPerDay);
    const needed = walkForwardBarsNeeded(trainBars, testBars, L.walkForwardFolds);
    try {
      this.progress(`walk-forward started (${trigger}) for model ${current.version}`);
      let real = await this.loadData(tf, needed);
      this.progress(`real data: ${Object.entries(real.coverage).map(([s, c]) => `${s} ${c.candles} candles, ${c.chainSnapshots} option-chain snapshots`).join('; ')}`);
      if (!hasEnough(real.candles, needed) && this.rest) {
        const days = Math.ceil((needed + 8) / barsPerDay) + 5;
        this.progress(`insufficient history: have ${barCount(real.candles)} bars of ${tf}, need ${needed}; fetching ${days}d from exchange`);
        try {
          await fetchAndStoreHistory({
            rest: this.rest,
            repos: this.repos,
            symbols: this.cfg.app.symbols,
            timeframes: this.cfg.app.timeframes,
            fromMs: this.clock.now() - days * MS.d,
            toMs: this.clock.now(),
            onProgress: (m) => this.progress(m),
          });
        } catch (e) {
          this.progress(`history fetch failed: ${(e as Error).message}`);
          return null;
        }
        real = await this.loadData(tf, needed);
        this.progress(`real data after fetch: ${Object.entries(real.coverage).map(([s, c]) => `${s} ${c.candles} candles, ${c.chainSnapshots} option-chain snapshots`).join('; ')}`);
      }
      const candles = real.candles;
      if (!hasEnough(candles, needed)) {
        this.progress(`insufficient history: have ${barCount(candles)} bars of ${tf}, need ${needed}; run "npm run fetch-history -w apps/backend -- --tf ${tf} --days ${Math.ceil(needed / barsPerDay) + 5}" first`);
        return null;
      }
      const wf = await this.runInWorker({
        config: this.cfg,
        candles,
        chains: real.chains,
        baseTf: tf,
        timeframes: this.cfg.app.timeframes,
        current,
        trainBars,
        testBars,
        folds: L.walkForwardFolds,
        decisionEveryBars: 1,
        candidates: L.candidatesPerCycle,
        maxChangePct: L.maxParamChangePct,
        seed: Math.floor(this.clock.now() / MS.d),
        mcPaths: 200,
      });
      const verdict = evaluatePromotion(wf, { minOosTrades: L.minOosTrades, alpha: L.significanceAlpha, maxDrawdownMultiple: 1.25 }, modelHash(current.params));
      const summary = summarizeOos(wf);
      const metrics = {
        trigger,
        folds: wf.folds.map((f) => ({ fold: f.fold, testFrom: f.testFrom, testTo: f.testTo, changes: f.chosen.changes, oosCandidate: strip(f.oos.candidate), oosCurrent: strip(f.oos.current) })),
        candidate: strip(verdict.candidate),
        current: strip(verdict.current),
        bestBaseline: verdict.bestBaseline ? { label: verdict.bestBaseline.label, ...strip(verdict.bestBaseline.metrics) } : null,
        stats: verdict.stats,
        checks: verdict.checks,
        criteriaVersion: verdict.version,
      };
      let candidateVersion: string | undefined;
      if (wf.finalHash !== modelHash(current.params)) {
        const cand = await this.registry.createCandidate(wf.finalParams as ModelParams, current.version, `walk-forward ${trigger}`, {
          oosExpectancyR: verdict.candidate.expectancyR,
          oosMaxDrawdownPct: verdict.candidate.maxDrawdownPct,
          oosTrades: verdict.candidate.trades,
          oosRValues: verdict.candidate.rValues,
          checks: verdict.checks,
          criteriaVersion: verdict.version,
        });
        candidateVersion = cand.version;
        if (verdict.promote) {
          await this.registry.markValidated(cand.version, metrics);
          if (L.autoPromoteToPaper) await this.registry.activatePaper(cand.version);
          await this.alerts.raise('info', 'MODEL_VALIDATED', `Model ${cand.version} passed walk-forward promotion criteria${L.autoPromoteToPaper ? ' and is now active in PAPER' : ''}. LIVE requires explicit approval.`);
        } else {
          await this.registry.reject(cand.version, 'failed promotion criteria', metrics);
        }
      }
      await this.repos.experiments.append({
        id: uuid(),
        ts: this.clock.now(),
        kind: 'WALK_FORWARD',
        modelVersion: candidateVersion ?? current.version,
        baselineVersion: current.version,
        summary: verdict.promote ? 'candidate promoted' : `not promoted: ${verdict.checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}`,
        metrics,
        decision: verdict.promote ? 'PROMOTED' : 'KEPT_CURRENT',
      });
      await this.repos.state.set('learning.lastWalkForwardAt', this.clock.now());
      this.status.lastVerdict = { promote: verdict.promote, candidateVersion, checks: verdict.checks, summary: { candidate: strip(summary.candidate), current: strip(summary.current) } };
      this.progress(`walk-forward finished: ${verdict.promote ? 'PROMOTED ' + candidateVersion : 'kept current model'}`);
      return this.status.lastVerdict;
    } catch (e) {
      this.status.error = (e as Error).message;
      log.error({ err: (e as Error).stack }, 'walk-forward failed');
      throw e;
    } finally {
      this.status.running = false;
      this.status.lastRunAt = this.clock.now();
    }
  }

  /** Operator-only. Requires paper evidence for the exact model version. */
  async approveLive(version: string, actor: string): Promise<{ approved: boolean; checks: unknown }> {
    const doc = await this.repos.models.get(version);
    if (!doc) throw new Error(`model ${version} not found`);
    const paper = (await this.repos.trades.list({ modelVersion: version, mode: 'PAPER' }, { limit: 100_000 })).map((t) => stripLedger(t));
    const r = evaluateLiveReadiness(paper, this.cfg.learning.minOosTrades, this.cfg.learning.significanceAlpha);
    if (!r.ready) {
      await this.repos.audit.append({ id: uuid(), ts: this.clock.now(), actor, action: 'MODEL_LIVE_APPROVAL_DENIED', details: { version, checks: r.checks } });
      return { approved: false, checks: r.checks };
    }
    await this.registry.approveLive(version, actor, { checks: r.checks, paperMetrics: strip(r.metrics) });
    return { approved: true, checks: r.checks };
  }
}

function strip<T extends { rValues?: number[] }>(m: T): Omit<T, 'rValues'> {
  const { rValues, ...rest } = m;
  void rValues;
  return rest;
}

function barCount(candles: Record<string, { length: number }>): number {
  const lens = Object.values(candles).map((c) => c.length);
  return lens.length ? Math.min(...lens) : 0;
}

function hasEnough(candles: Record<string, { length: number }>, needed: number): boolean {
  return Object.keys(candles).length > 0 && barCount(candles) >= needed;
}
