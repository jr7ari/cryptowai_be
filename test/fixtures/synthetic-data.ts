/**
 * Regime-switching synthetic market generator (seeded). Used for tests, demos and sanity checks of the
 * learning loop where the ground-truth regime is known. Results on synthetic data say NOTHING about
 * real-market profitability - they only verify the machinery behaves as designed.
 */
import type { Candle, Timeframe } from '../../src/domain/types.js';
import { TIMEFRAME_MS } from '../../src/domain/types.js';
import { mulberry32, gaussian } from '../../src/lib/math.js';

export type TrueRegime = 'UP' | 'DOWN' | 'RANGE' | 'VOLATILE' | 'QUIET';

export interface SyntheticOptions {
  start: number;
  bars: number;
  tf: Timeframe;
  startPrice: number;
  seed: number;
  /** average regime length in bars */
  meanRegimeBars?: number;
}

export function generateRegimeSeries(o: SyntheticOptions): { candles: Candle[]; regimes: TrueRegime[] } {
  const rng = mulberry32(o.seed);
  const ms = TIMEFRAME_MS[o.tf];
  const barsPerYear = (365 * 86_400_000) / ms;
  const params: Record<TrueRegime, { drift: number; vol: number; meanRev: number }> = {
    UP: { drift: 3.0, vol: 0.45, meanRev: 0 },
    DOWN: { drift: -3.0, vol: 0.5, meanRev: 0 },
    RANGE: { drift: 0, vol: 0.4, meanRev: 0.08 },
    VOLATILE: { drift: 0, vol: 1.1, meanRev: 0.02 },
    QUIET: { drift: 0, vol: 0.22, meanRev: 0.04 },
  };
  const names: TrueRegime[] = ['UP', 'DOWN', 'RANGE', 'VOLATILE', 'QUIET'];
  const candles: Candle[] = [];
  const regimes: TrueRegime[] = [];
  let price = o.startPrice;
  let regime: TrueRegime = 'RANGE';
  let left = 0;
  let anchor = price;
  const meanLen = o.meanRegimeBars ?? 300;
  for (let i = 0; i < o.bars; i++) {
    if (left <= 0) {
      regime = names[Math.floor(rng() * names.length)];
      left = Math.max(50, Math.round(meanLen * (0.5 + rng())));
      anchor = price;
    }
    left--;
    const p = params[regime];
    const dt = 1 / barsPerYear;
    const mr = p.meanRev * Math.log(anchor / price);
    const sub = 4;
    const o0 = price;
    let h = price;
    let l = price;
    for (let k = 0; k < sub; k++) {
      const z = gaussian(rng);
      price = price * Math.exp((p.drift - 0.5 * p.vol * p.vol) * (dt / sub) + mr / sub + p.vol * Math.sqrt(dt / sub) * z);
      h = Math.max(h, price);
      l = Math.min(l, price);
    }
    const volume = 100 * (1 + rng()) * (regime === 'VOLATILE' ? 2.5 : regime === 'QUIET' ? 0.6 : 1);
    candles.push({ t: o.start + i * ms, o: o0, h, l, c: price, v: volume });
    regimes.push(regime);
  }
  return { candles, regimes };
}
