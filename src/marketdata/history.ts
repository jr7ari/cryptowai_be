/**
 * Download REAL candles from the configured exchange and persist them.
 * Shared by `npm run fetch-history` and the learning engine (auto-backfill before walk-forward).
 */
import type { Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import type { FuturesExchangeClient } from '../integrations/exchange.js';
import type { Repositories } from '../persistence/ports.js';
import { closedOnly } from './view.js';

export interface FetchHistoryOpts {
  rest: Pick<FuturesExchangeClient, 'candles'>;
  repos: Pick<Repositories, 'candles'>;
  symbols: string[];
  timeframes: Timeframe[];
  fromMs: number;
  toMs: number;
  onProgress?: (msg: string) => void;
}

export async function fetchAndStoreHistory(o: FetchHistoryOpts): Promise<{ stored: number }> {
  let stored = 0;
  for (const s of o.symbols) {
    for (const tf of o.timeframes) {
      const ms = TIMEFRAME_MS[tf];
      const chunk = ms * 500;
      let tfStored = 0;
      for (let start = o.fromMs; start < o.toMs; start += chunk) {
        const got = await o.rest.candles(s, tf, start, Math.min(o.toMs, start + chunk));
        tfStored += await o.repos.candles.upsertMany(s, tf, closedOnly(got, tf, o.toMs));
      }
      o.onProgress?.(`${s} ${tf}: ${tfStored} candles stored`);
      stored += tfStored;
    }
  }
  return { stored };
}

/** Bars required for an anchored walk-forward (warmup + train + test * folds). */
export function walkForwardBarsNeeded(trainBars: number, testBars: number, folds: number, warmup = 260): number {
  return warmup + trainBars + testBars * folds;
}
