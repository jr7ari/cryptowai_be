/**
 * Donchian-channel trend ensemble (Zarattini, Pagani & Barbon, "Catching Crypto Trends: A Tactical
 * Approach for Bitcoin and Altcoins", 2025). Rules as published (daily closes, long side):
 *   - lookbacks L in {5,10,20,30,60,90,150,250,360} days;
 *   - ENTER when close > max(close over the previous L days);
 *   - trailing stop = max(previous stop, midpoint of max/min close over L); EXIT when close < stop;
 *   - the portfolio is the equal-weighted ensemble of all lookbacks (exposure = share in position),
 *     sized to a volatility target (here: the risk engine's targetVol scaling).
 * The authors report a net-of-fees Sharpe above 1.5 since 2015 on a liquid crypto universe. That is
 * an out-of-sample prior, not a guarantee; walk-forward on CoinDCX data must confirm it.
 *
 * A mirrored short ensemble (close < min, stop = min(prev, midpoint)) is computed for PAPER research
 * only - the paper tests the long side.
 *
 * Only CLOSED bars are passed in; no look-ahead.
 */
import type { Candle, FeatureVector } from '../domain/types.js';

export const DONCHIAN_LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360] as const;

interface LegState {
  inPos: boolean;
  stop: number;
}

/** Replays one lookback's state machine over the closes. Returns final state. */
function replay(closes: number[], L: number, dir: 1 | -1): LegState {
  const st: LegState = { inPos: false, stop: NaN };
  for (let i = L; i < closes.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - L; j < i; j++) {
      if (closes[j] > hi) hi = closes[j];
      if (closes[j] < lo) lo = closes[j];
    }
    const mid = (hi + lo) / 2;
    const c = closes[i];
    if (st.inPos) {
      // ratchet stop first using the channel known before today's close, then test today's close
      st.stop = dir === 1 ? Math.max(st.stop, mid) : Math.min(st.stop, mid);
      if ((dir === 1 && c < st.stop) || (dir === -1 && c > st.stop)) st.inPos = false;
    } else if ((dir === 1 && c > hi) || (dir === -1 && c < lo)) {
      st.inPos = true;
      st.stop = mid;
    }
  }
  return st;
}

/**
 * donchianLong / donchianShort in [0,1] = share of available lookbacks currently in position.
 * donchianStopDist = average distance (fraction of price) from close to the active long stops.
 */
export function donchianFeatures(daily: Candle[]): FeatureVector {
  const closes = daily.map((c) => c.c);
  const usable = DONCHIAN_LOOKBACKS.filter((L) => closes.length > L + 1);
  if (usable.length < 3) return { donchianAvail: 0 };
  const last = closes[closes.length - 1];
  let longN = 0;
  let shortN = 0;
  let stopDist = 0;
  let stopN = 0;
  for (const L of usable) {
    const lg = replay(closes, L, 1);
    if (lg.inPos) {
      longN++;
      stopDist += Math.max(0, (last - lg.stop) / last);
      stopN++;
    }
    const sh = replay(closes, L, -1);
    if (sh.inPos) shortN++;
  }
  return {
    donchianAvail: 1,
    donchianN: usable.length,
    donchianLong: longN / usable.length,
    donchianShort: shortN / usable.length,
    donchianStopDist: stopN ? stopDist / stopN : 0,
  };
}
