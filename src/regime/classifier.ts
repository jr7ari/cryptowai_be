/**
 * Regime classification. Each regime receives an independent evidence score in [0,1]
 * (logistic of a weighted evidence sum), so overlapping states (e.g. uptrend + high vol) are
 * visible. The primary regime is the best-scoring one, with hysteresis to avoid flip-flopping,
 * and a calibrated confidence that also penalises ambiguity (small gap to the runner-up).
 */
import type { FeatureVector, RegimeClassification, RegimeName } from '../domain/types.js';
import { REGIMES } from '../domain/types.js';
import { sigmoid, softmax, clamp } from '../lib/math.js';
import type { RegimeParams } from '../model/params.js';

type Ev = { z: number; notes: string[] };

function ev(): Ev {
  return { z: 0, notes: [] };
}
function add(e: Ev, cond: boolean, w: number, note: string) {
  if (cond) {
    e.z += w;
    e.notes.push(`${w >= 0 ? '+' : ''}${w.toFixed(2)} ${note}`);
  }
}
function addCont(e: Ev, value: number, w: number, note: string) {
  if (!Number.isFinite(value) || value === 0) return;
  e.z += w * value;
  e.notes.push(`${(w * value).toFixed(2)} ${note}`);
}

export function scoreRegimes(fv: FeatureVector, p: RegimeParams): { scores: Record<RegimeName, number>; evidence: Record<string, string[]> } {
  const g = (k: string, d = 0) => (Number.isFinite(fv[k]) ? fv[k] : d);
  const adx = g('adx');
  const align = g('emaAlign');
  const htf = g('htfAlign', align);
  const di = g('diDiff');
  const er = g('er');
  const chop = g('chop', 50);
  const r2 = g('r2');
  const slope = g('slope');
  const rvP = g('rvPctile', 0.5);
  const rvRatio = g('rvRatio', 1);
  const atrP = g('atrPctile', 0.5);
  const volZ = g('volumeZ');
  const rsi = g('rsi', 50);
  const hurst = g('hurst', 0.5);

  const E: Record<RegimeName, Ev> = Object.fromEntries(REGIMES.map((r) => [r, ev()])) as Record<RegimeName, Ev>;

  // ---------- trends (mirror images)
  for (const [name, s] of [
    ['STRONG_UPTREND', 1],
    ['STRONG_DOWNTREND', -1],
  ] as Array<[RegimeName, number]>) {
    const e = E[name];
    e.z -= 2.2;
    addCont(e, clamp((adx - p.adxTrend) / 10, -1.5, 1.5), 1.2, `ADX ${adx.toFixed(1)} vs ${p.adxTrend}`);
    addCont(e, s * align, 1.4, 'EMA stack alignment');
    addCont(e, s * htf, 1.2, 'higher-TF alignment');
    addCont(e, s * di, 1.0, '+DI/-DI balance');
    add(e, er > p.erTrend && Math.sign(slope) === s, 0.7, `efficiency ${er.toFixed(2)}`);
    add(e, r2 > 0.6 && Math.sign(slope) === s, 0.5, `linear fit R2 ${r2.toFixed(2)}`);
    add(e, g('supertrendDir') === s, 0.4, 'supertrend agrees');
    add(e, g('ichimoku') === s, 0.3, 'price vs Ichimoku cloud');
    add(e, chop > p.chopHigh, -0.8, 'choppiness high');
    add(e, hurst > 0.55, 0.3, 'Hurst persistent');
    if (g('oiPriceConfirm') !== 0) add(e, g('oiPriceConfirm') > 0 && Math.sign(g('ret20')) === s, 0.3, 'OI confirms move');
    if (fv.rr25 !== undefined) add(e, Math.sign(g('rr25')) === s && Math.abs(g('rr25')) > 0.02, 0.2, 'skew agrees');
  }

  // ---------- ranging
  {
    const e = E.RANGING;
    e.z -= 1.5;
    addCont(e, clamp((p.adxRange + 5 - adx) / 8, -1.5, 1.5), 1.2, `ADX ${adx.toFixed(1)} low`);
    add(e, Math.abs(align) <= 0.5, 0.6, 'EMAs flat/tangled');
    add(e, chop > 50, 0.6, `choppiness ${chop.toFixed(0)}`);
    add(e, er < 0.25, 0.5, 'low efficiency');
    add(e, hurst < 0.48, 0.5, 'mean-reverting (Hurst)');
    add(e, g('autocorr') < -0.05, 0.3, 'negative autocorrelation');
    add(e, g('donchianPos') > 0.15 && g('donchianPos') < 0.85, 0.4, 'inside channel');
    add(e, rvP < 0.75, 0.3, 'vol not elevated');
    add(e, Math.abs(htf) > 0.75, -0.6, 'strong higher-TF trend');
  }

  // ---------- volatility states
  {
    const e = E.HIGH_VOLATILITY;
    e.z -= 1.8;
    addCont(e, clamp((rvP - p.rvHighPctile) * 8, -2, 2), 1.0, `RV pctile ${(rvP * 100).toFixed(0)}%`);
    addCont(e, clamp((rvRatio - 1.2) * 3, -1.5, 1.5), 0.8, `RV short/long ${rvRatio.toFixed(2)}`);
    add(e, atrP > 0.8, 0.6, 'ATR pctile high');
    add(e, g('garchVol') > g('rvLong') * 1.2, 0.4, 'GARCH forecast elevated');
    add(e, g('volOfVol') > 0.15, 0.3, 'vol-of-vol high');
    if (fv.ivRank !== undefined) add(e, g('ivRank') > 0.7, 0.5, 'IV rank high');
  }
  {
    const e = E.LOW_VOLATILITY;
    e.z -= 1.8;
    addCont(e, clamp((p.rvLowPctile - rvP) * 8, -2, 2), 1.0, `RV pctile ${(rvP * 100).toFixed(0)}%`);
    add(e, g('squeeze') === 1, 0.9, 'BB inside Keltner (squeeze)');
    add(e, g('bbWidthPctile') < 0.2, 0.6, 'BB width in bottom quintile');
    add(e, rvRatio < 0.85, 0.4, 'short RV below long RV');
    if (fv.ivRank !== undefined) add(e, g('ivRank') < 0.3, 0.5, 'IV rank low (cheap options)');
  }

  // ---------- breakout / breakdown
  for (const [name, s, key, key55] of [
    ['BREAKOUT', 1, 'breakoutUp', 'breakout55Up'],
    ['BREAKDOWN', -1, 'breakoutDown', 'breakout55Down'],
  ] as Array<[RegimeName, number, string, string]>) {
    const e = E[name];
    e.z -= 2.5;
    add(e, g(key) > 0, 1.6, `close beyond 20-bar channel (${g(key).toFixed(2)} ATR)`);
    add(e, g(key55) > 0, 0.5, '55-bar channel break');
    addCont(e, clamp((volZ - p.breakoutVolumeZ) / 1.5, -1, 1.5), 0.8, `volume z ${volZ.toFixed(2)}`);
    add(e, g('squeezeRelease') === 1, 0.7, 'squeeze released');
    add(e, rvRatio > 1.05, 0.3, 'vol expanding');
    add(e, g('adxSlope') > 0, 0.3, 'ADX rising');
    add(e, Math.sign(g('macdHistN')) === s, 0.3, 'MACD agrees');
    add(e, Math.sign(htf) === -s && Math.abs(htf) > 0.5, -0.6, 'against higher-TF trend');
  }

  // ---------- reversals
  {
    const e = E.REVERSAL_BULLISH;
    e.z -= 2.4;
    add(e, g('ret50') < 0 || htf < 0, 0.6, 'prior downtrend');
    add(e, g('divergence') === 1, 1.2, 'bullish RSI divergence');
    add(e, g('rsiMin10') < p.reversalRsiLow && rsi > g('rsiMin10') + 8, 0.9, 'RSI recovering from oversold');
    add(e, g('supertrendDir') === 1 && g('supertrendFlipAgo') <= 5, 0.7, 'supertrend flipped up');
    add(e, g('macdCross') === 1, 0.5, 'MACD bullish cross');
    add(e, g('cmf') > 0.05, 0.3, 'money flow positive');
    add(e, g('fundingAnnual') < -0.05, 0.3, 'negative funding (short crowding)');
    add(e, g('pcrOi', 1) > 1.3, 0.2, 'put-heavy positioning (contrarian)');
  }
  {
    const e = E.REVERSAL_BEARISH;
    e.z -= 2.4;
    add(e, g('ret50') > 0 || htf > 0, 0.6, 'prior uptrend');
    add(e, g('divergence') === -1, 1.2, 'bearish RSI divergence');
    add(e, g('rsiMax10') > p.reversalRsiHigh && rsi < g('rsiMax10') - 8, 0.9, 'RSI rolling over from overbought');
    add(e, g('supertrendDir') === -1 && g('supertrendFlipAgo') <= 5, 0.7, 'supertrend flipped down');
    add(e, g('macdCross') === -1, 0.5, 'MACD bearish cross');
    add(e, g('cmf') < -0.05, 0.3, 'money flow negative');
    add(e, g('fundingAnnual') > 0.4, 0.3, 'high positive funding (long crowding)');
  }

  // ---------- choppy / uncertain
  {
    const e = E.CHOPPY;
    e.z -= 2.0;
    add(e, chop > p.chopHigh, 0.9, `choppiness ${chop.toFixed(0)}`);
    add(e, g('supertrendFlips30') >= 3, 0.8, 'frequent supertrend flips (whipsaw)');
    add(e, er < 0.15, 0.6, 'very low efficiency');
    add(e, g('tfAgreement') === 0 && Math.abs(align) > 0.25 && Math.abs(htf) > 0.25, 0.6, 'timeframes disagree');
    add(e, r2 < 0.2, 0.4, 'no linear structure');
    add(e, rvP > 0.6 && adx < p.adxRange + 4, 0.5, 'volatile without direction');
  }

  const scores = Object.fromEntries(REGIMES.map((r) => [r, sigmoid(E[r].z)])) as Record<RegimeName, number>;
  const evidence = Object.fromEntries(REGIMES.map((r) => [r, E[r].notes]));
  return { scores, evidence };
}

export interface ClassifierState {
  prev?: RegimeClassification;
}

export function classify(
  symbol: string,
  ts: number,
  fv: FeatureVector,
  p: RegimeParams,
  modelVersion: string,
  state: ClassifierState = {},
): RegimeClassification {
  const { scores, evidence } = scoreRegimes(fv, p);
  // Volatility states are "overlay" regimes; directional/structural regimes take priority when strong.
  const ranked = [...REGIMES].sort((a, b) => scores[b] - scores[a]);
  let primary = ranked[0];
  const structural = ranked.find((r) => r !== 'HIGH_VOLATILITY' && r !== 'LOW_VOLATILITY')!;
  if ((primary === 'HIGH_VOLATILITY' || primary === 'LOW_VOLATILITY') && scores[structural] >= p.minScore && scores[structural] >= scores[primary] - 0.1) {
    primary = structural;
  }

  let sticky = false;
  const prev = state.prev;
  if (prev && prev.primary !== primary && prev.primary !== 'CHOPPY') {
    if (scores[prev.primary] >= p.minScore && scores[primary] - scores[prev.primary] < p.hysteresis) {
      primary = prev.primary;
      sticky = true;
    }
  }

  const top = scores[primary];
  const runnerUp = Math.max(...REGIMES.filter((r) => r !== primary).map((r) => scores[r]));
  const separation = clamp((top - runnerUp) / Math.max(top, 1e-9), 0, 1);
  let confidence = clamp(0.7 * top + 0.3 * separation * top, 0, 1);
  if (top < p.minScore) {
    primary = 'CHOPPY';
    confidence = clamp(Math.max(scores.CHOPPY, 1 - top), 0, 1);
  }

  const probsArr = softmax(REGIMES.map((r) => scores[r]), p.temperature);
  const probabilities = Object.fromEntries(REGIMES.map((r, i) => [r, probsArr[i]])) as Record<RegimeName, number>;

  const rvP = fv.rvPctile ?? 0.5;
  const volState = rvP >= p.rvHighPctile ? 'HIGH' : rvP <= p.rvLowPctile ? 'LOW' : 'NORMAL';
  const dirScore = (fv.emaAlign ?? 0) * 0.4 + (fv.htfAlign ?? 0) * 0.4 + (fv.diDiff ?? 0) * 0.2;
  const direction = dirScore > 0.2 ? 'BULL' : dirScore < -0.2 ? 'BEAR' : 'NEUTRAL';

  return { symbol, ts, primary, confidence, scores, probabilities, volState, direction, evidence, modelVersion, sticky };
}

/** Bias of each regime for exit-on-invalidation logic. */
export function regimeBias(r: RegimeName): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (['STRONG_UPTREND', 'BREAKOUT', 'REVERSAL_BULLISH'].includes(r)) return 'BULL';
  if (['STRONG_DOWNTREND', 'BREAKDOWN', 'REVERSAL_BEARISH'].includes(r)) return 'BEAR';
  return 'NEUTRAL';
}
