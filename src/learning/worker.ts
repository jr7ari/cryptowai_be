/**
 * Worker-thread entry for walk-forward optimisation so heavy backtests never block the trading loop.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { walkForward, type WalkForwardInput } from './walkforward.js';

type Msg = Omit<WalkForwardInput, 'onProgress' | 'tradable'> & { tradable?: string[] };

async function main() {
  const input = workerData as Msg;
  const res = await walkForward({
    ...input,
    tradable: input.tradable ? new Set(input.tradable as WalkForwardInput extends { tradable?: Set<infer T> } ? T[] : never) : undefined,
    onProgress: (m) => parentPort?.postMessage({ type: 'progress', message: m }),
  });
  parentPort?.postMessage({ type: 'done', result: res });
}

main().catch((e) => parentPort?.postMessage({ type: 'error', error: (e as Error).stack ?? String(e) }));
