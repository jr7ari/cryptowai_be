/** Worker-thread entry for backtests requested from the API (keeps the trading loop responsive). */
import { parentPort, workerData } from 'node:worker_threads';
import { runBacktest, type BacktestOptions } from './engine.js';

async function main() {
  const jobs = workerData as Array<Omit<BacktestOptions, 'tradable'> & { tradable?: string[] }>;
  const results = [];
  for (const j of jobs) {
    const r = await runBacktest({ ...j, tradable: j.tradable ? (new Set(j.tradable) as BacktestOptions['tradable']) : undefined });
    results.push(r);
    parentPort?.postMessage({ type: 'progress', message: `${r.label}: ${r.metrics.trades} trades` });
  }
  parentPort?.postMessage({ type: 'done', results });
}
main().catch((e) => parentPort?.postMessage({ type: 'error', error: (e as Error).stack ?? String(e) }));
