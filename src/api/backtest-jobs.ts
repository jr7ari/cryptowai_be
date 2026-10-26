import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../persistence/ports.js';
import type { ModelRegistry } from '../model/registry.js';
import type { StrategyName } from '../domain/types.js';
import { loadRealData } from '../backtest/data.js';
import { parseMap } from '../config/index.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import { BASELINE_POLICIES, runBacktest, type BacktestOptions, type BacktestResult, type Policy } from '../backtest/engine.js';
import type { ModelParams } from '../model/params.js';
import { uuid } from '../lib/ids.js';

export interface BacktestJob {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  createdAt: number;
  finishedAt?: number;
  request: Record<string, unknown>;
  progress: string[];
  error?: string;
  results?: Array<Omit<BacktestResult, 'trades' | 'regimeLabels'> & { trades: BacktestResult['trades'] }>;
}

export class BacktestJobs {
  private jobs = new Map<string, BacktestJob>();
  constructor(private readonly cfg: AppConfig, private readonly repos: Repositories, private readonly registry: ModelRegistry) {}

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => ({ ...j, results: j.results?.map((r) => ({ ...r, trades: undefined, equity: undefined })) }));
  }
  get(id: string) {
    return this.jobs.get(id) ?? null;
  }

  async start(body: { from?: number; to?: number; symbols?: string[]; policy?: string; strategy?: StrategyName; modelVersion?: string; decisionEveryBars?: number; compareBaselines?: boolean }) {
    const tf = this.cfg.app.decisionTimeframe;
    const to = body.to ?? Date.now();
    const from = body.from ?? to - 60 * 86_400_000;
    const warm = 260 * TIMEFRAME_MS[tf];
    const symbols = (body.symbols?.length ? body.symbols : this.cfg.app.symbols).filter((s) => this.cfg.app.symbols.includes(s));
    const real = await loadRealData(this.repos, symbols, parseMap(this.cfg.app.underlyingMap), tf, from - warm, to, 300);
    const candles = real.candles;
    if (!Object.keys(candles).length)
      throw Object.assign(new Error('not enough REAL candles stored for this range: run "npm run fetch-history -w apps/backend -- --days 180" first'), { statusCode: 400 });
    const mv = body.modelVersion ? await this.repos.models.get(body.modelVersion) : null;
    const active = await this.registry.active('PAPER');
    const model = mv ? { version: mv.version, params: mv.params as ModelParams } : active!;
    const main: Policy = body.policy === 'FIXED' && body.strategy ? { kind: 'FIXED', strategy: body.strategy } : body.policy === 'RANDOM' ? { kind: 'RANDOM', seed: 11 } : { kind: 'REGIME_ENGINE' };
    const base = {
      config: this.cfg,
      candles,
      baseTf: tf,
      timeframes: this.cfg.app.timeframes,
      decisionEveryBars: Math.max(1, body.decisionEveryBars ?? 1),
      warmupBars: 0,
      model,
      from,
      to,
      chains: real.chains,
    };
    const runs: Array<Omit<BacktestOptions, 'tradable'>> = [{ ...base, policy: main }];
    if (body.compareBaselines !== false) for (const p of BASELINE_POLICIES) runs.push({ ...base, policy: p });
    const job: BacktestJob = { id: uuid(), status: 'RUNNING', createdAt: Date.now(), request: { ...body, from, to, symbols: Object.keys(candles), modelVersion: model.version, dataCoverage: real.coverage }, progress: [] };
    this.jobs.set(job.id, job);
    this.run(job, runs).catch(() => undefined);
    return { id: job.id, status: job.status };
  }

  private async run(job: BacktestJob, runs: Array<Omit<BacktestOptions, 'tradable'>>) {
    try {
      const here = fileURLToPath(import.meta.url);
      const isTs = here.endsWith('.ts');
      const wp = here.replace(/api[\\/]backtest-jobs\.(ts|js)$/, `backtest/worker.${isTs ? 'ts' : 'js'}`);
      let results: BacktestResult[];
      if (existsSync(wp)) {
        results = await new Promise((resolve, reject) => {
          const w = new Worker(wp, { workerData: runs, execArgv: isTs ? ['--import', 'tsx'] : [] });
          w.on('message', (m: { type: string; message?: string; results?: BacktestResult[]; error?: string }) => {
            if (m.type === 'progress') job.progress.push(m.message!);
            if (m.type === 'done') resolve(m.results!);
            if (m.type === 'error') reject(new Error(m.error));
          });
          w.on('error', reject);
        });
      } else {
        results = [];
        for (const r of runs) results.push(await runBacktest(r));
      }
      job.results = results.map((r) => ({ ...r, regimeLabels: undefined as never, equity: thin(r.equity, 600) }));
      job.status = 'DONE';
      for (const r of results) {
        await this.repos.experiments.append({
          id: uuid(),
          ts: Date.now(),
          kind: 'BACKTEST',
          modelVersion: r.modelVersion,
          summary: `${r.label}: ${r.metrics.trades} trades, expectancy ${r.metrics.expectancyR.toFixed(4)} R, return ${r.curve.totalReturnPct.toFixed(2)}%`,
          metrics: { job: job.id, label: r.label, ...r.curve, trades: r.metrics.trades, expectancyR: r.metrics.expectancyR, profitFactor: r.metrics.profitFactor, maxDrawdownPct: r.metrics.maxDrawdownPct },
        });
      }
    } catch (e) {
      job.status = 'FAILED';
      job.error = (e as Error).message;
    } finally {
      job.finishedAt = Date.now();
    }
  }
}

function thin<T>(a: T[], n: number): T[] {
  if (a.length <= n) return a;
  const step = a.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(a[Math.floor(i * step)]);
  out.push(a[a.length - 1]);
  return out;
}
