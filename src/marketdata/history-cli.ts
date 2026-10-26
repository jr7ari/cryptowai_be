/**
 * Historical data loader - downloads REAL candles from the configured exchange (CoinDCX or Delta).
 *   EXCHANGE=delta npm run fetch-history -- --days 365   # Delta perpetual candles
 *   npm run fetch-history -- --days 180                 # all configured symbols/timeframes from CoinDCX
 *   npm run fetch-history -- --symbol B-BTC_USDT --tf 15m --days 365
 */
import { loadConfig } from '../config/index.js';
import { createRepositories } from '../persistence/index.js';
import { createExchange } from '../integrations/factory.js';
import { systemClock } from '../lib/clock.js';
import type { Timeframe } from '../domain/types.js';
import { fetchAndStoreHistory } from './history.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { config, secrets } = loadConfig();
  const repos = await createRepositories(config, secrets);
  const symbols = arg('symbol') ? [arg('symbol')!] : config.app.symbols;
  const tfs = (arg('tf') ? [arg('tf')] : config.app.timeframes) as Timeframe[];
  try {
    const ex = createExchange(config, secrets, systemClock);
    console.log(`fetching REAL candles from ${ex.label}`);
    const days = Number(arg('days') ?? 120);
    const now = Date.now();
    await fetchAndStoreHistory({
      rest: ex.client,
      repos,
      symbols,
      timeframes: tfs,
      fromMs: now - days * 86_400_000,
      toMs: now,
      onProgress: (m) => console.log(m),
    });
  } finally {
    await repos.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
