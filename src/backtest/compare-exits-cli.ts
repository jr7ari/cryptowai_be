/**
 * Before/after exit comparison on REAL stored CoinDCX candles (run fetch-history first).
 *   npm run compare-exits -w apps/backend -- --tf 1h --days 180
 *   npm run compare-exits -w apps/backend -- --tf 1d --days 700 --stress 2 --json exits.json
 */
import { writeFileSync } from 'node:fs';
import { loadConfig, parseMap, type AppConfig } from '../config/index.js';
import { createRepositories } from '../persistence/index.js';
import { loadRealData } from './data.js';
import { compareExits, formatReport } from './compare-exits.js';
import { defaultModelParams, withDefaults, type ModelParams } from '../model/params.js';
import type { Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  process.env.LOG_LEVEL ??= 'warn';
  const tfArg = arg('tf') as Timeframe | undefined;
  const appOv = tfArg ? { app: { timeframes: [tfArg], decisionTimeframe: tfArg, historyBars: 400 } } : {};
  const { config, secrets } = loadConfig({ overrides: appOv });
  const tf = config.app.decisionTimeframe;
  const configFor = (exits: Partial<AppConfig['exits']>, paper?: Partial<AppConfig['paper']>) =>
    loadConfig({ overrides: { ...appOv, exits, ...(paper ? { paper } : {}) } }).config;

  const repos = await createRepositories(config, secrets);
  let params: ModelParams = defaultModelParams();
  let version = 'default';
  let real: Awaited<ReturnType<typeof loadRealData>>;
  try {
    const days = Number(arg('days') ?? 180);
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
  if (!Object.keys(real.candles).length) throw new Error(`no stored CoinDCX ${tf} candles: run "npm run fetch-history -w apps/backend -- --tf ${tf} --days 365" first`);
  for (const [s, c] of Object.entries(real.coverage)) console.log(`data ${s}: ${c.candles} ${tf} candles`);
  const rep = await compareExits({
    configFor,
    candles: real.candles,
    chains: real.chains,
    baseTf: tf,
    timeframes: config.app.timeframes,
    model: { version, params },
    warmupBars: 260,
    decisionEveryBars: Number(arg('every') ?? 1),
    isFraction: Number(arg('is') ?? 0.6),
    stressCostMultiple: arg('stress') ? Number(arg('stress')) : undefined,
  });
  console.log(formatReport(rep));
  if (arg('json')) writeFileSync(arg('json')!, JSON.stringify(rep, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
