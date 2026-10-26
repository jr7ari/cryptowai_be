/**
 * Backtest / walk-forward CLI over REAL recorded data only (CoinDCX candles fetched via the API +
 * Deribit option-chain snapshots recorded live). No synthetic or imported data.
 *   npm run backtest -- --days 90                       # regime engine vs baselines on stored candles
 *   npm run backtest -- --tf 1d --days 1500             # daily (TSMOM) on stored CoinDCX daily candles
 *   npm run backtest -- --walk-forward --days 240       # walk-forward optimisation + promotion verdict
 *   npm run backtest -- --json out.json                 # also write full results
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config/index.js';
import { createRepositories } from '../persistence/index.js';
import { runBacktest, BASELINE_POLICIES, type BacktestResult, type Policy } from './engine.js';
import { loadRealData } from './data.js';
import { parseMap } from '../config/index.js';
import { walkForward, summarizeOos } from '../learning/walkforward.js';
import { evaluatePromotion } from '../learning/promotion.js';
import { defaultModelParams, modelHash, withDefaults, type ModelParams } from '../model/params.js';
import type { Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function fmt(r: BacktestResult) {
  const m = r.metrics;
  const c = r.curve;
  return [
    r.label.padEnd(26),
    String(m.trades).padStart(6),
    (m.winRate * 100).toFixed(1).padStart(6) + '%',
    m.expectancyR.toFixed(4).padStart(9),
    (m.profitFactor === null ? 'inf' : m.profitFactor.toFixed(2)).padStart(6),
    c.totalReturnPct.toFixed(2).padStart(8) + '%',
    c.sharpe.toFixed(2).padStart(7),
    c.maxDrawdownPct.toFixed(2).padStart(7) + '%',
    m.totalFees.toFixed(2).padStart(9),
  ].join(' ');
}

async function main() {
  process.env.LOG_LEVEL ??= 'warn';
  // --tf 1d : run on a different (stored) timeframe, e.g. daily for the TSMOM sleeve
  const tfArg = arg('tf') as Timeframe | undefined;
  const { config, secrets } = loadConfig(
    tfArg ? { overrides: { app: { timeframes: [tfArg], decisionTimeframe: tfArg, historyBars: 400 } } } : {},
  );
  const tf = config.app.decisionTimeframe;
  let params: ModelParams = defaultModelParams();
  let version = 'default';
  // REAL data only: candles recorded from the CoinDCX API + option chains recorded from Deribit's API.
  const repos = await createRepositories(config, secrets);
  let real: Awaited<ReturnType<typeof loadRealData>>;
  try {
    const days = Number(arg('days') ?? 90);
    const to = Date.now();
    const from = to - days * 86_400_000 - 260 * TIMEFRAME_MS[tf];
    real = await loadRealData(repos, config.app.symbols, parseMap(config.app.underlyingMap), tf, from, to, 400);
    const active = await repos.models.activeFor('PAPER');
    if (active && !flag('default-model')) {
      params = withDefaults(active.params);
      version = active.version;
    }
  } finally {
    await repos.close();
  }
  const candles = real.candles;
  console.log('Real data coverage (CoinDCX candles / recorded Deribit option-chain snapshots):');
  for (const [s, c] of Object.entries(real.coverage)) {
    const d = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : '-');
    console.log(`  ${s.padEnd(12)} ${String(c.candles).padStart(6)} ${tf} candles ${d(c.firstCandle)} -> ${d(c.lastCandle)} | ${c.chainSnapshots} chain snapshots ${d(c.firstChain)} -> ${d(c.lastChain)}`);
  }
  if (!Object.keys(candles).length)
    throw new Error(`no stored CoinDCX candles for ${tf}: run "npm run fetch-history -w apps/backend -- --tf ${tf} --days 365" first`);
  if (!Object.keys(real.chains).length)
    console.log('  NOTE: no recorded option chains in this window -> option strategies cannot trade in this backtest (futures only).\n        Chains are recorded automatically while the engine runs (every 15 min).');
  const model = { version, params };
  const every = Number(arg('every') ?? 1);

  if (flag('walk-forward')) {
    const barsPerDay = 86_400_000 / TIMEFRAME_MS[tf];
    const wf = await walkForward({
      config,
      candles,
      chains: real.chains,
      baseTf: tf,
      timeframes: config.app.timeframes,
      current: model,
      trainBars: Math.round(Number(arg('train-days') ?? config.learning.walkForwardTrainDays) * barsPerDay),
      testBars: Math.round(Number(arg('test-days') ?? config.learning.walkForwardTestDays) * barsPerDay),
      folds: Number(arg('folds') ?? config.learning.walkForwardFolds),
      decisionEveryBars: every,
      candidates: Number(arg('candidates') ?? config.learning.candidatesPerCycle),
      maxChangePct: config.learning.maxParamChangePct,
      seed: 1,
      mcPaths: 200,
      onProgress: (m) => console.log(m),
    });
    const s = summarizeOos(wf);
    const v = evaluatePromotion(wf, { minOosTrades: config.learning.minOosTrades, alpha: config.learning.significanceAlpha, maxDrawdownMultiple: 1.25 }, modelHash(params));
    console.log('\nOUT-OF-SAMPLE (all folds)');
    console.log(`candidate : ${s.candidate.trades} trades, expectancy ${s.candidate.expectancyR.toFixed(4)} R, PF ${s.candidate.profitFactor?.toFixed(2)}, maxDD ${s.candidate.maxDrawdownPct.toFixed(2)}%`);
    console.log(`current   : ${s.current.trades} trades, expectancy ${s.current.expectancyR.toFixed(4)} R, PF ${s.current.profitFactor?.toFixed(2)}, maxDD ${s.current.maxDrawdownPct.toFixed(2)}%`);
    for (const [k, b] of Object.entries(s.baselines)) console.log(`${k.padEnd(10)}: ${b.trades} trades, expectancy ${b.expectancyR.toFixed(4)} R, maxDD ${b.maxDrawdownPct.toFixed(2)}%`);
    console.log(`\nPROMOTION (${v.version}): ${v.promote ? 'PASS' : 'FAIL'}`);
    for (const c of v.checks) console.log(`  ${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
    if (arg('json')) writeFileSync(arg('json')!, JSON.stringify({ walkForward: { ...wf, oosCandidateTrades: undefined, oosCurrentTrades: undefined, oosBaselineTrades: undefined }, summary: s, verdict: v }, null, 2));
    return;
  }

  const policies: Policy[] = [{ kind: 'REGIME_ENGINE' }, ...(flag('no-baselines') ? [] : BASELINE_POLICIES)];
  const results: BacktestResult[] = [];
  console.log(['policy'.padEnd(26), 'trades', '   win', '  exp(R)', '    PF', '  return', ' sharpe', '  maxDD', '     fees'].join(' '));
  for (const p of policies) {
    const r = await runBacktest({ config, candles, chains: real.chains, baseTf: tf, timeframes: config.app.timeframes, decisionEveryBars: every, warmupBars: 260, model, policy: p });
    results.push(r);
    console.log(fmt(r));
  }
  const rg = results[0];
  console.log('\nRegime engine by regime:');
  for (const [k, m] of Object.entries(rg.byRegime)) console.log(`  ${k.padEnd(18)} ${String(m.trades).padStart(4)} trades  exp ${m.expectancyR.toFixed(4)} R  win ${(m.winRate * 100).toFixed(0)}%`);
  console.log('Regime engine by strategy:');
  for (const [k, m] of Object.entries(rg.byStrategy)) console.log(`  ${k.padEnd(20)} ${String(m.trades).padStart(4)} trades  exp ${m.expectancyR.toFixed(4)} R  pnl ${m.totalPnl.toFixed(2)}`);
  console.log(`\nBuy & hold (equal weight, same window): return ${rg.benchmark.totalReturnPct.toFixed(2)}%  sharpe ${rg.benchmark.sharpe.toFixed(2)}  maxDD ${rg.benchmark.maxDrawdownPct.toFixed(2)}%`);
  console.log('\nNOTE: past/simulated performance does not guarantee future results. Options can lose 100% of premium.');
  if (arg('json')) writeFileSync(arg('json')!, JSON.stringify(results.map((r) => ({ ...r, regimeLabels: undefined })), null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
