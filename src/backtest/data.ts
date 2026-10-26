/**
 * Loads REAL historical data for backtests / walk-forward from the database:
 *  - candles recorded from the CoinDCX API (npm run fetch-history, plus everything the live engine sees)
 *  - option-chain snapshots recorded live from the Deribit public API (no options history otherwise)
 */
import type { Candle, OptionChainSnapshot, Timeframe } from '../domain/types.js';
import { TIMEFRAME_MS } from '../domain/types.js';
import type { Repositories } from '../persistence/ports.js';
import { closedOnly } from '../marketdata/view.js';

export interface RealBacktestData {
  candles: Record<string, Candle[]>;
  chains: Record<string, OptionChainSnapshot[]>;
  coverage: Record<string, { candles: number; firstCandle?: number; lastCandle?: number; chainSnapshots: number; firstChain?: number; lastChain?: number }>;
}

export async function loadRealData(
  repos: Repositories,
  symbols: string[],
  underlyingMap: Record<string, string>,
  tf: Timeframe,
  from: number,
  to: number,
  minBars = 300,
): Promise<RealBacktestData> {
  const out: RealBacktestData = { candles: {}, chains: {}, coverage: {} };
  for (const s of symbols) {
    const c = await repos.candles.range(s, tf, from, to);
    const ch = await repos.chains.range(underlyingMap[s] ?? s, from, to);
    cover(out, s, c, ch, minBars);
  }
  return out;
}

/**
 * Most recent `bars` CLOSED candles per symbol, regardless of wall-clock alignment.
 * A `now - bars * tf` range drops the oldest bar while the current candle is still forming
 * (off-by-one: 11779 stored vs 11780 needed).
 */
export async function loadLatestRealData(
  repos: Repositories,
  symbols: string[],
  underlyingMap: Record<string, string>,
  tf: Timeframe,
  bars: number,
  now: number,
  minBars = 1,
): Promise<RealBacktestData> {
  const out: RealBacktestData = { candles: {}, chains: {}, coverage: {} };
  for (const s of symbols) {
    const closed = closedOnly(await repos.candles.latest(s, tf, bars + 8), tf, now).slice(-bars);
    const from = closed[0]?.t ?? now - bars * TIMEFRAME_MS[tf];
    const ch = await repos.chains.range(underlyingMap[s] ?? s, from, now);
    cover(out, s, closed, ch, minBars);
  }
  return out;
}

function cover(out: RealBacktestData, s: string, c: Candle[], ch: OptionChainSnapshot[], minBars: number) {
  out.coverage[s] = {
    candles: c.length,
    firstCandle: c[0]?.t,
    lastCandle: c[c.length - 1]?.t,
    chainSnapshots: ch.length,
    firstChain: ch[0]?.ts,
    lastChain: ch[ch.length - 1]?.ts,
  };
  if (c.length >= minBars) out.candles[s] = c;
  if (ch.length) out.chains[s] = ch;
}
