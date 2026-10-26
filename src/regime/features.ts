/**
 * Multi-timeframe feature extraction. All features at time t use only candles CLOSED at or before t
 * (the caller must drop the in-progress bar) - this is the primary leakage guard.
 */
import type { Candle, Timeframe, FeatureVector, ChainMetrics } from '../domain/types.js';
import * as I from '../indicators/core.js';
import * as V from '../indicators/volatility.js';
import { percentileRank } from '../lib/math.js';
import { momentumFeatures } from '../signals/alpha.js';
import { cusumShift } from '../signals/cusum.js';
import { donchianFeatures } from '../signals/donchian.js';

export interface FeatureInput {
  candles: Partial<Record<Timeframe, Candle[]>>;
  decisionTf: Timeframe;
  higherTfs: Timeframe[];
  fundingRate?: number;
  /** funding interval in hours (CoinDCX/most venues: 8h) */
  fundingIntervalHours?: number;
  openInterestHistory?: Array<{ ts: number; oi: number }>;
  chainMetrics?: ChainMetrics;
  ivHistory?: number[];
}

const f = (x: number, d = 0) => (Number.isFinite(x) ? x : d);

/** EMA alignment score in [-1,1]: stacked 20>50>200 with price above = +1. */
function emaAlignment(c: Candle[]): number {
  const cl = I.closes(c);
  const e20 = I.last(I.ema(cl, 20));
  const e50 = I.last(I.ema(cl, 50));
  const e200 = I.last(I.ema(cl, Math.min(200, Math.max(50, cl.length - 1))));
  const p = I.last(cl);
  if (![e20, e50, e200, p].every(Number.isFinite)) return 0;
  let s = 0;
  s += p > e20 ? 0.25 : -0.25;
  s += e20 > e50 ? 0.25 : -0.25;
  s += e50 > e200 ? 0.25 : -0.25;
  s += p > e200 ? 0.25 : -0.25;
  return s;
}

export function extractFeatures(inp: FeatureInput): FeatureVector {
  const c = inp.candles[inp.decisionTf] ?? [];
  const out: FeatureVector = {};
  if (c.length < 60) return out;
  const tf = inp.decisionTf;
  const cl = I.closes(c);
  const price = I.last(cl);
  out.price = price;

  // ---------------- trend
  const a = I.adx(c, 14);
  out.adx = f(I.last(a.adx));
  const pdi = I.last(a.plusDI);
  const mdi = I.last(a.minusDI);
  out.diDiff = Number.isFinite(pdi) && pdi + mdi > 0 ? (pdi - mdi) / (pdi + mdi) : 0;
  out.adxSlope = f(I.last(a.adx) - a.adx[a.adx.length - 6]);
  out.emaAlign = emaAlignment(c);
  const lr = I.linregSlope(cl, 30);
  out.slope = f(I.last(lr.slope)) * 100; // % per bar
  out.r2 = f(I.last(lr.r2));
  out.er = f(I.last(I.efficiencyRatio(cl, 20)));
  out.chop = f(I.last(I.choppiness(c, 14)), 50);
  out.hurst = f(I.hurst(cl, 256), 0.5);
  out.autocorr = f(I.autocorr(cl, 100));
  out.ret20 = f(I.last(I.roc(cl, 20)));
  out.ret50 = f(I.last(I.roc(cl, 50)));
  const st = I.supertrend(c, 10, 3);
  out.supertrendDir = f(I.last(st.direction));
  let flips = 0;
  let lastFlipAgo = 999;
  for (let i = st.direction.length - 30; i < st.direction.length; i++) {
    if (i > 0 && st.direction[i] !== st.direction[i - 1] && Number.isFinite(st.direction[i - 1])) {
      flips++;
      lastFlipAgo = st.direction.length - 1 - i;
    }
  }
  out.supertrendFlips30 = flips;
  out.supertrendFlipAgo = lastFlipAgo;
  const ich = I.ichimoku(c);
  const top = I.last(ich.cloudTop);
  const bot = I.last(ich.cloudBottom);
  out.ichimoku = Number.isFinite(top) ? (price > top ? 1 : price < bot ? -1 : 0) : 0;
  const ar = I.aroon(c, 25);
  out.aroonOsc = f(I.last(ar.osc)) / 100;
  const sar = I.parabolicSar(c);
  out.psar = price > I.last(sar) ? 1 : -1;

  // ---------------- momentum
  const r = I.rsi(cl, 14);
  out.rsi = f(I.last(r), 50);
  out.rsiPrev = f(r[r.length - 4], 50);
  out.rsiMin10 = Math.min(...r.slice(-10).filter(Number.isFinite));
  out.rsiMax10 = Math.max(...r.slice(-10).filter(Number.isFinite));
  const m = I.macd(cl);
  const atr = I.atr(c, 14);
  const atrNow = I.last(atr);
  out.atrPct = atrNow / price;
  out.macdHistN = f(I.last(m.hist) / atrNow);
  out.macdCross = Math.sign(f(I.last(m.hist))) !== Math.sign(f(m.hist[m.hist.length - 3])) ? Math.sign(f(I.last(m.hist))) : 0;
  const sto = I.stochastic(c);
  out.stochK = f(I.last(sto.k), 50);
  const srsi = I.stochRsi(cl);
  out.stochRsiK = f(I.last(srsi.k), 50);
  out.cci = f(I.last(I.cci(c, 20)));
  out.willR = f(I.last(I.williamsR(c, 14)), -50);
  const div = I.rsiDivergence(c, r, 40, 3);
  out.divergence = div === 'BULLISH' ? 1 : div === 'BEARISH' ? -1 : 0;

  // ---------------- volatility
  out.rvShort = f(V.yangZhangVol(c, 20, tf));
  out.rvLong = f(V.yangZhangVol(c, 100, tf));
  out.rvParkinson = f(V.parkinsonVol(c, 20, tf));
  out.rvGK = f(V.garmanKlassVol(c, 20, tf));
  out.rvCC = f(V.closeToCloseVol(c, 20, tf));
  out.rvEwma = f(V.ewmaVol(c, tf));
  out.rvRatio = out.rvLong > 0 ? out.rvShort / out.rvLong : 1;
  const rvSeries = V.rollingVolSeries(c.slice(-400), 20, tf, 4);
  out.rvPctile = rvSeries.length > 10 ? percentileRank(rvSeries, out.rvShort) : 0.5;
  out.volOfVol = f(V.volOfVol(rvSeries.slice(-50)));
  const atrSeries = atr.slice(-300).map((x, i, arr) => x / (cl[cl.length - arr.length + i] || 1)).filter(Number.isFinite);
  out.atrPctile = percentileRank(atrSeries, out.atrPct);
  const g = V.garchForecast(c, tf, Math.round(V.barsPerYear(tf) / 365) * 7);
  out.garchVol = f(g.vol, out.rvShort);
  out.garchPersistence = f(g.persistence, 0.9);
  const bb = I.bollinger(cl, 20, 2);
  out.bbWidth = f(I.last(bb.width));
  out.bbPctB = f(I.last(bb.pctB), 0.5);
  out.bbWidthPctile = percentileRank(bb.width.slice(-300).filter(Number.isFinite), out.bbWidth);
  const sq = I.squeeze(c, 20);
  out.squeeze = f(I.last(sq));
  out.squeezeRelease = sq.slice(-6, -1).some((x) => x === 1) && I.last(sq) === 0 ? 1 : 0;

  // ---------------- structure / breakout
  const dc = I.donchian(c.slice(0, -1), 20); // channel of PRIOR bars, so a close beyond it is a true breakout
  const up = I.last(dc.upper);
  const lo = I.last(dc.lower);
  out.donchianPos = up > lo ? (price - lo) / (up - lo) : 0.5;
  out.breakoutUp = price > up ? (price - up) / atrNow : 0;
  out.breakoutDown = price < lo ? (lo - price) / atrNow : 0;
  const dc55 = I.donchian(c.slice(0, -1), 55);
  out.breakout55Up = price > I.last(dc55.upper) ? 1 : 0;
  out.breakout55Down = price < I.last(dc55.lower) ? 1 : 0;

  // ---------------- volume / flow
  const vol = I.volumes(c);
  out.volumeZ = f(I.last(I.zscore(vol, 20)));
  out.cmf = f(I.last(I.cmf(c, 20)));
  out.mfi = f(I.last(I.mfi(c, 14)), 50);
  const ob = I.obv(c);
  const obvSlope = I.linregSlope(ob.map((x) => x + 1e9), 20).slope; // shift to keep mean positive
  out.obvSlope = f(I.last(obvSlope)) * 1e4;
  const vw = I.vwapDaily(c);
  out.vwapDev = f((price - I.last(vw)) / atrNow);
  const rv = I.rollingVwap(c, 50);
  out.rvwapZ = I.last(rv.sd) > 0 ? (price - I.last(rv.vwap)) / I.last(rv.sd) : 0;

  // ---------------- time-series momentum (multi-horizon, vol-normalised)
  // TSMOM is defined on DAILY closes (as in the research); fall back to the decision TF.
  const daily = inp.candles['1d'];
  if (daily && daily.length >= 60) {
    Object.assign(out, momentumFeatures(daily, '1d'));
    const da = I.atr(daily, 14);
    out.atrPct_1d = f(I.last(da) / daily[daily.length - 1].c);
    out.rvDaily = f(V.closeToCloseVol(daily, 30, '1d'));
    Object.assign(out, donchianFeatures(daily));
  } else {
    Object.assign(out, momentumFeatures(c, tf));
  }

  // ---------------- higher timeframes
  let htfAlign = 0;
  let htfAdx = 0;
  let n = 0;
  for (const h of inp.higherTfs) {
    const hc = inp.candles[h];
    if (!hc || hc.length < 60) continue;
    const al = emaAlignment(hc);
    out[`emaAlign_${h}`] = al;
    const ha = I.adx(hc, 14);
    out[`adx_${h}`] = f(I.last(ha.adx));
    out[`diDiff_${h}`] = (() => {
      const p = I.last(ha.plusDI);
      const mm = I.last(ha.minusDI);
      return Number.isFinite(p) && p + mm > 0 ? (p - mm) / (p + mm) : 0;
    })();
    out[`rsi_${h}`] = f(I.last(I.rsi(I.closes(hc), 14)), 50);
    out[`ret20_${h}`] = f(I.last(I.roc(I.closes(hc), 20)));
    htfAlign += al;
    htfAdx += out[`adx_${h}`];
    n++;
  }
  out.htfAlign = n ? htfAlign / n : out.emaAlign;
  out.htfAdx = n ? htfAdx / n : out.adx;
  out.tfAgreement = Math.sign(out.htfAlign) === Math.sign(out.emaAlign) && out.emaAlign !== 0 ? 1 : 0;
  const trendSigns = [out.emaAlign, out.supertrendDir, out.diDiff, out.htfAlign].map(Math.sign).filter((s) => s !== 0);
  const bullishN = trendSigns.filter((s) => s > 0).length;
  out.trendSignAgreement = trendSigns.length ? Math.max(bullishN, trendSigns.length - bullishN) / trendSigns.length : 1;
  const cs = cusumShift(cl);
  out.cusumShift = cs.shift;
  out.cusumHigh = cs.sHigh;
  out.cusumLow = cs.sLow;
  out.cusumAvail = cl.length >= 30 ? 1 : 0;
  out.ofiAvail = 0;
  out.bookImbalanceAvail = 0;

  // ---------------- derivatives data
  if (inp.fundingRate !== undefined && Number.isFinite(inp.fundingRate)) {
    out.fundingRate = inp.fundingRate;
    out.fundingAnnual = inp.fundingRate * (24 / (inp.fundingIntervalHours ?? 8)) * 365;
    out.fundingAvail = 1;
  } else {
    out.fundingAvail = 0;
  }
  const oiH = inp.openInterestHistory ?? [];
  out.oiAvail = oiH.length >= 2 ? 1 : 0;
  if (oiH.length >= 2) {
    const lastOi = oiH[oiH.length - 1].oi;
    const ref = oiH.find((x) => x.ts >= oiH[oiH.length - 1].ts - 24 * 3_600_000) ?? oiH[0];
    out.oiChange24h = ref.oi > 0 ? (lastOi - ref.oi) / ref.oi : 0;
    // price up + OI up = new longs (trend fuel); price up + OI down = short covering
    out.oiPriceConfirm = Math.sign(out.oiChange24h) * Math.sign(out.ret20);
  }

  // ---------------- options data
  const cm = inp.chainMetrics;
  out.ivAvail = cm && Number.isFinite(cm.atmIv) ? 1 : 0;
  if (cm && Number.isFinite(cm.atmIv)) {
    out.ivAtm = cm.atmIv;
    out.ivRvSpread = cm.atmIv - out.rvShort;
    out.ivRvRatio = out.rvShort > 0 ? cm.atmIv / out.rvShort : 1;
    if (cm.riskReversal25d !== undefined) out.rr25 = cm.riskReversal25d;
    if (cm.butterfly25d !== undefined) out.bf25 = cm.butterfly25d;
    if (cm.termSlope !== undefined) out.termSlope = cm.termSlope;
    if (cm.pcrOpenInterest !== undefined) out.pcrOi = cm.pcrOpenInterest;
    if (cm.pcrVolume !== undefined) out.pcrVolume = cm.pcrVolume;
    if (cm.maxPain !== undefined) out.maxPainDist = (cm.maxPain - price) / price;
    const h = (inp.ivHistory ?? []).filter(Number.isFinite);
    if (h.length >= 10) {
      const lo2 = Math.min(...h);
      const hi2 = Math.max(...h);
      out.ivRank = hi2 > lo2 ? (cm.atmIv - lo2) / (hi2 - lo2) : 0.5;
      out.ivPctile = percentileRank(h, cm.atmIv);
    }
  }
  for (const k of Object.keys(out)) if (!Number.isFinite(out[k])) out[k] = 0;
  return out;
}

/** Human-readable indicator panel for the dashboard (subset with interpretation). */
export type IndicatorUnit = 'pct' | 'num' | 'ratio' | 'score';
/** How each interpreted row should be displayed (pct values are fractions, e.g. 0.47 = 47%). */
const UNITS: Record<string, IndicatorUnit> = {
  'Realized vol (YZ)': 'pct',
  'GARCH 7d vol': 'pct',
  'Funding (annual)': 'pct',
  'OI change 24h': 'pct',
  'ATM IV': 'pct',
  '25d risk reversal': 'pct',
  'IV / forecast RV': 'ratio',
  'Put/Call OI': 'ratio',
  'EMA alignment': 'score',
  'HTF alignment': 'score',
  'TSMOM score': 'score',
  'Alpha drift (annual)': 'pct',
  'VRP score': 'score',
  'Vol-target size scale': 'ratio',
  'Efficiency ratio': 'ratio',
  Hurst: 'ratio',
  'MACD hist / ATR': 'ratio',
  'VWAP deviation (ATR)': 'ratio',
  'Volume z': 'ratio',
  CMF: 'ratio',
};
export function interpretFeatures(fv: FeatureVector): Array<{ name: string; value: number; unit: IndicatorUnit; signal: 'BULL' | 'BEAR' | 'NEUTRAL' | 'HIGH' | 'LOW'; note: string }> {
  const rows: Array<{ name: string; value: number; unit: IndicatorUnit; signal: 'BULL' | 'BEAR' | 'NEUTRAL' | 'HIGH' | 'LOW'; note: string }> = [];
  const add = (name: string, value: number | undefined, signal: 'BULL' | 'BEAR' | 'NEUTRAL' | 'HIGH' | 'LOW', note: string) => {
    if (value !== undefined && Number.isFinite(value)) rows.push({ name, value, unit: UNITS[name] ?? 'num', signal, note });
  };
  add('ADX', fv.adx, fv.adx > 25 ? (fv.diDiff > 0 ? 'BULL' : 'BEAR') : 'NEUTRAL', fv.adx > 25 ? 'trending' : fv.adx < 18 ? 'no trend' : 'weak trend');
  add('EMA alignment', fv.emaAlign, fv.emaAlign > 0.4 ? 'BULL' : fv.emaAlign < -0.4 ? 'BEAR' : 'NEUTRAL', '20/50/200 stack');
  add('HTF alignment', fv.htfAlign, fv.htfAlign > 0.4 ? 'BULL' : fv.htfAlign < -0.4 ? 'BEAR' : 'NEUTRAL', 'higher timeframes');
  add('RSI(14)', fv.rsi, fv.rsi > 70 ? 'HIGH' : fv.rsi < 30 ? 'LOW' : fv.rsi > 50 ? 'BULL' : 'BEAR', fv.rsi > 70 ? 'overbought' : fv.rsi < 30 ? 'oversold' : '');
  add('MACD hist / ATR', fv.macdHistN, fv.macdHistN > 0 ? 'BULL' : 'BEAR', fv.macdCross ? 'fresh cross' : '');
  add('Supertrend', fv.supertrendDir, fv.supertrendDir > 0 ? 'BULL' : 'BEAR', `${fv.supertrendFlips30} flips/30 bars`);
  add('Choppiness', fv.chop, fv.chop > 61.8 ? 'NEUTRAL' : fv.chop < 38.2 ? 'HIGH' : 'NEUTRAL', fv.chop > 61.8 ? 'choppy' : fv.chop < 38.2 ? 'strong trend' : '');
  add('Efficiency ratio', fv.er, fv.er > 0.4 ? 'HIGH' : 'LOW', 'directional efficiency');
  add('Hurst', fv.hurst, fv.hurst > 0.55 ? 'HIGH' : fv.hurst < 0.45 ? 'LOW' : 'NEUTRAL', fv.hurst > 0.55 ? 'persistent' : fv.hurst < 0.45 ? 'mean-reverting' : 'random walk');
  add('Realized vol (YZ)', fv.rvShort, fv.rvPctile > 0.8 ? 'HIGH' : fv.rvPctile < 0.2 ? 'LOW' : 'NEUTRAL', `pctile ${(fv.rvPctile * 100).toFixed(0)}%`);
  add('GARCH 7d vol', fv.garchVol, fv.garchVol > fv.rvShort ? 'HIGH' : 'LOW', 'forecast');
  add('BB squeeze', fv.squeeze, fv.squeeze ? 'LOW' : 'NEUTRAL', fv.squeezeRelease ? 'squeeze released' : fv.squeeze ? 'compressing (1 = on)' : 'off (0)');
  add('Volume z', fv.volumeZ, fv.volumeZ > 1.5 ? 'HIGH' : 'NEUTRAL', 'vs 20-bar');
  add('CMF', fv.cmf, fv.cmf > 0.05 ? 'BULL' : fv.cmf < -0.05 ? 'BEAR' : 'NEUTRAL', 'money flow');
  add('VWAP deviation (ATR)', fv.vwapDev, fv.vwapDev > 0 ? 'BULL' : 'BEAR', 'daily VWAP');
  add('Funding (annual)', fv.fundingAnnual, fv.fundingAnnual > 0.3 ? 'HIGH' : fv.fundingAnnual < -0.1 ? 'LOW' : 'NEUTRAL', 'crowding');
  add('OI change 24h', fv.oiChange24h, fv.oiChange24h > 0 ? 'HIGH' : 'LOW', fv.oiPriceConfirm > 0 ? 'confirms price' : 'diverges');
  add('ATM IV', fv.ivAtm, (fv.ivRank ?? 0.5) > 0.7 ? 'HIGH' : (fv.ivRank ?? 0.5) < 0.3 ? 'LOW' : 'NEUTRAL', `IV-RV ${(((fv.ivRvSpread ?? 0) * 100)).toFixed(1)} pts`);
  add('25d risk reversal', fv.rr25, (fv.rr25 ?? 0) > 0 ? 'BULL' : 'BEAR', 'skew');
  add('Put/Call OI', fv.pcrOi, (fv.pcrOi ?? 1) > 1.2 ? 'BEAR' : (fv.pcrOi ?? 1) < 0.7 ? 'BULL' : 'NEUTRAL', 'positioning');
  if (fv.donchianAvail) add('Donchian trend share', fv.donchianLong, (fv.donchianLong ?? 0) >= 0.5 ? 'BULL' : (fv.donchianShort ?? 0) >= 0.5 ? 'BEAR' : 'NEUTRAL', `${Math.round((fv.donchianLong ?? 0) * (fv.donchianN ?? 0))}/${fv.donchianN} lookbacks long, ${Math.round((fv.donchianShort ?? 0) * (fv.donchianN ?? 0))} short`);
  add('TSMOM score', fv.tsmom, (fv.tsmom ?? 0) > 0.15 ? 'BULL' : (fv.tsmom ?? 0) < -0.15 ? 'BEAR' : 'NEUTRAL', `horizon agreement ${((fv.tsmomAgreement ?? 0) * 100).toFixed(0)}%`);
  add('IV / forecast RV', fv.ivRvRatio, (fv.ivRvRatio ?? 1) > 1.15 ? 'HIGH' : (fv.ivRvRatio ?? 1) < 0.9 ? 'LOW' : 'NEUTRAL', (fv.ivRvRatio ?? 1) > 1.15 ? 'options rich: favour selling premium' : (fv.ivRvRatio ?? 1) < 0.9 ? 'options cheap: favour buying' : 'fair');
  add('RSI divergence', fv.divergence, fv.divergence > 0 ? 'BULL' : fv.divergence < 0 ? 'BEAR' : 'NEUTRAL', fv.divergence > 0 ? 'bullish (+1)' : fv.divergence < 0 ? 'bearish (-1)' : 'none (0)');
  add('Alpha drift (annual)', fv.alphaDrift, (fv.alphaDrift ?? 0) > 0.05 ? 'BULL' : (fv.alphaDrift ?? 0) < -0.05 ? 'BEAR' : 'NEUTRAL', `regime ${((fv.alphaRegime ?? 0) * 100).toFixed(0)}% + momentum ${((fv.alphaMomentum ?? 0) * 100).toFixed(0)}% + funding ${((fv.alphaFunding ?? 0) * 100).toFixed(0)}%`);
  add('VRP score', fv.vrpScore, (fv.vrpScore ?? 0) > 0.1 ? 'HIGH' : (fv.vrpScore ?? 0) < -0.1 ? 'LOW' : 'NEUTRAL', (fv.vrpScore ?? 0) > 0.1 ? 'implied > forecast: sell premium' : (fv.vrpScore ?? 0) < -0.1 ? 'implied < forecast: buy options' : 'neutral');
  add('Vol-target size scale', fv.volTargetScale, (fv.volTargetScale ?? 1) < 0.6 ? 'LOW' : 'NEUTRAL', 'position size multiplier (<= 1)');
  add('CUSUM shift', fv.cusumShift, fv.cusumShift > 0 ? 'BULL' : fv.cusumShift < 0 ? 'BEAR' : 'NEUTRAL', fv.cusumAvail ? 'closed-bar detector only' : 'unavailable');
  add('Book imbalance', fv.bookImbalance, (fv.bookImbalance ?? 0) > 0.2 ? 'BULL' : (fv.bookImbalance ?? 0) < -0.2 ? 'BEAR' : 'NEUTRAL', fv.bookImbalanceAvail ? 'live top-of-book' : 'no L2 (historical OFI unavailable)');
  add('Trend-sign agreement', fv.trendSignAgreement, (fv.trendSignAgreement ?? 1) < 0.75 ? 'LOW' : 'NEUTRAL', 'EMA/DI/supertrend/HTF; correlated trend features are not independent evidence');
  add('Mark-basis', fv.basis, (fv.basis ?? 0) > 0 ? 'HIGH' : (fv.basis ?? 0) < 0 ? 'LOW' : 'NEUTRAL', fv.basisAvail ? `ln(last/mark) pctile ${((fv.basisPctile ?? 0.5) * 100).toFixed(0)}%` : 'unavailable');
  add('Carry score', fv.carryScore, (fv.carryScore ?? 0) > 0.3 ? 'BEAR' : (fv.carryScore ?? 0) < -0.3 ? 'BULL' : 'NEUTRAL', '+ = fade rich perp / collect +funding (not guaranteed P&L)');
  add('Signed flow', fv.signedFlow, (fv.signedFlow ?? 0) > 0.2 ? 'BULL' : (fv.signedFlow ?? 0) < -0.2 ? 'BEAR' : 'NEUTRAL', fv.signedFlowAvail ? 'Lee-Ready or explicit aggressor' : 'no trade tape');
  add('XSMOM rank', fv.xsmomRank, (fv.xsmomRank ?? 0.5) > 0.7 ? 'BULL' : (fv.xsmomRank ?? 0.5) < 0.3 ? 'BEAR' : 'NEUTRAL', fv.xsmomAvail ? `${fv.xsmomN} peers` : 'unavailable');
  add('MR z-score', fv.zScore, Math.abs(fv.zScore ?? 0) > 1.5 ? 'HIGH' : 'NEUTRAL', fv.mrAvail ? `half-life ${fmtN(fv.halfLifeBars)} bars` : 'not mean-reverting');
  add('Change-point', fv.changePointShift, fv.changePointActive ? (fv.changePointShift > 0 ? 'BULL' : 'BEAR') : 'NEUTRAL', fv.changePointActive ? 'CUSUM suspends mean-reversion' : 'none');
  return rows;
}

function fmtN(x: number | undefined): string {
  return Number.isFinite(x) ? String(Math.round(x!)) : '—';
}
