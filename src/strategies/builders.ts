/**
 * Strategy builders: turn (strategy, chain, params) into concrete legs for ONE unit of the structure.
 * Builders never size positions; the risk engine decides the number of units.
 */
import type { LegSpec, OptionChainSnapshot, OptionContract, StrategyName, Side } from '../domain/types.js';
import type { StrategyParams } from '../model/params.js';
import { contractByDelta, contractByStrike, pickExpiry } from '../options/chain.js';

export interface BuildContext {
  chain: OptionChainSnapshot | null;
  futuresInstrument: string;
  spot: number;
  bid?: number;
  ask?: number;
  now: number;
  minDte: number;
  maxDte: number;
  atr: number;
  features?: import('../domain/types.js').FeatureVector;
}

export interface BuiltStrategy {
  strategy: StrategyName;
  legs: LegSpec[];
  params: Record<string, number | string>;
  /** futures only: stop distance in price units */
  stopDistance?: number;
}

const optLeg = (c: OptionContract, side: Side, ratio = 1): LegSpec => ({
  kind: 'OPTION',
  instrument: c.symbol,
  side,
  qty: ratio,
  ratio,
  option: { strike: c.strike, expiry: c.expiry, type: c.type, iv: c.iv, contractSize: c.contractSize },
  bid: c.bid,
  ask: c.ask,
  mark: c.mark,
});

export function buildStrategy(name: StrategyName, sp: StrategyParams, ctx: BuildContext): BuiltStrategy | { error: string } {
  if (name === 'FUTURES_TSMOM') {
    const fv = ctx.features ?? {};
    const score = fv.tsmom;
    if (score === undefined) return { error: 'TSMOM score unavailable (needs daily candles)' };
    const longOk = score >= sp.longDelta;
    const shortOk = score <= -sp.longDelta;
    if (!longOk && !shortOk) return { error: `TSMOM ${score.toFixed(2)} inside ±${sp.longDelta} (NO_TRADE)` };
    const side: Side = longOk ? 'BUY' : 'SELL';
    // wide catastrophe stop: max(3 x daily ATR, 2.5 x daily sigma x sqrt(5d)); the hard stop-loss % then
    // exits at a fraction of this distance, and sizing uses the full distance (conservative).
    const atrD = (fv.atrPct_1d ?? fv.atrPct ?? 0.03) * ctx.spot;
    const sigD = ((fv.rvDaily ?? fv.rvLong ?? 0.6) / Math.sqrt(365)) * ctx.spot;
    const stopDistance = Math.max(3 * atrD, 2.5 * sigD * Math.sqrt(5), ctx.spot * 0.02);
    return {
      strategy: name,
      legs: [{ kind: 'FUTURE', instrument: ctx.futuresInstrument, side, qty: 1, ratio: 1, bid: ctx.bid ?? ctx.spot, ask: ctx.ask ?? ctx.spot, mark: ctx.spot }],
      params: {
        leverage: sp.leverage,
        entryThreshold: sp.longDelta,
        exitThreshold: sp.shortDelta,
        holdDays: sp.targetDte,
        tsmom: Number(score.toFixed(4)),
        side,
      },
      stopDistance,
    };
  }
  if (name === 'FUTURES_DONCHIAN') {
    const fv = ctx.features ?? {};
    if (!(fv.donchianAvail > 0)) return { error: 'Donchian ensemble unavailable (needs >= 22 closed daily candles)' };
    const lg = fv.donchianLong ?? 0;
    const sh = fv.donchianShort ?? 0;
    const longOk = lg >= sp.longDelta && lg > sh;
    const shortOk = !longOk && sh >= sp.longDelta && sh > lg;
    if (!longOk && !shortOk) return { error: `Donchian long ${(lg * 100).toFixed(0)}% / short ${(sh * 100).toFixed(0)}% of lookbacks (need >= ${(sp.longDelta * 100).toFixed(0)}%)` };
    const side: Side = longOk ? 'BUY' : 'SELL';
    // catastrophe stop: the ensemble's own trailing stop distance, floored by 2 x daily ATR and 2% of price
    const atrD = (fv.atrPct_1d ?? fv.atrPct ?? 0.03) * ctx.spot;
    const stopDistance = Math.max((fv.donchianStopDist ?? 0) * ctx.spot, 2 * atrD, ctx.spot * 0.02);
    return {
      strategy: name,
      legs: [{ kind: 'FUTURE', instrument: ctx.futuresInstrument, side, qty: 1, ratio: 1, bid: ctx.bid ?? ctx.spot, ask: ctx.ask ?? ctx.spot, mark: ctx.spot }],
      params: {
        leverage: sp.leverage,
        entryShare: sp.longDelta,
        exitShare: sp.shortDelta,
        donchianLong: Number(lg.toFixed(3)),
        donchianShort: Number(sh.toFixed(3)),
        lookbacks: fv.donchianN ?? 0,
        side,
      },
      stopDistance,
    };
  }
  if (name === 'FUTURES_CARRY') {
    const fv = ctx.features ?? {};
    if (!(fv.fundingAvail > 0) && !(fv.basisAvail > 0)) return { error: 'carry unavailable (no funding and no mark-basis)' };
    const score = fv.carryScore ?? 0;
    if (Math.abs(score) < sp.longDelta) return { error: `carryScore ${score.toFixed(2)} inside ±${sp.longDelta}` };
    const side: Side = score > 0 ? 'SELL' : 'BUY';
    const stopDistance = Math.max(ctx.atr * 2, ctx.spot * 0.004);
    return {
      strategy: name,
      legs: [{ kind: 'FUTURE', instrument: ctx.futuresInstrument, side, qty: 1, ratio: 1, bid: ctx.bid ?? ctx.spot, ask: ctx.ask ?? ctx.spot, mark: ctx.spot }],
      params: { leverage: sp.leverage, carryScore: Number(score.toFixed(4)), basisAvail: fv.basisAvail ?? 0, fundingAvail: fv.fundingAvail ?? 0, side },
      stopDistance,
    };
  }
  if (name === 'FUTURES_XSMOM') {
    const fv = ctx.features ?? {};
    if (!(fv.xsmomAvail > 0)) return { error: 'cross-sectional momentum unavailable (need ≥2 liquid peers with closed bars)' };
    const rank = fv.xsmomRank ?? 0.5;
    const tsmom = fv.tsmom ?? 0;
    const high = rank >= sp.longDelta && tsmom > 0;
    const low = rank <= sp.shortDelta && tsmom < 0;
    if (!high && !low) return { error: `XSMOM rank ${rank.toFixed(2)} / TSMOM ${tsmom.toFixed(2)} (need rank≥${sp.longDelta} with +TSMOM or rank≤${sp.shortDelta} with −TSMOM)` };
    const side: Side = high ? 'BUY' : 'SELL';
    const stopDistance = Math.max(ctx.atr * 2, ctx.spot * 0.004);
    return {
      strategy: name,
      legs: [{ kind: 'FUTURE', instrument: ctx.futuresInstrument, side, qty: 1, ratio: 1, bid: ctx.bid ?? ctx.spot, ask: ctx.ask ?? ctx.spot, mark: ctx.spot }],
      params: { leverage: sp.leverage, xsmomRank: Number(rank.toFixed(4)), tsmom: Number(tsmom.toFixed(4)), n: fv.xsmomN ?? 0, side },
      stopDistance,
    };
  }
  if (name === 'FUTURES_MR') {
    const fv = ctx.features ?? {};
    if (!(fv.mrAvail > 0)) return { error: 'mean-reversion unavailable (series not statistically mean-reverting on closed bars)' };
    if (fv.changePointActive) return { error: 'CUSUM change-point: mean-reversion suspended' };
    const z = fv.zScore ?? 0;
    if (Math.abs(z) < sp.longDelta) return { error: `|z| ${Math.abs(z).toFixed(2)} < entry ${sp.longDelta}` };
    const side: Side = z > 0 ? 'SELL' : 'BUY';
    const stopDistance = Math.max(ctx.atr * 2.5, ctx.spot * 0.006);
    return {
      strategy: name,
      legs: [{ kind: 'FUTURE', instrument: ctx.futuresInstrument, side, qty: 1, ratio: 1, bid: ctx.bid ?? ctx.spot, ask: ctx.ask ?? ctx.spot, mark: ctx.spot }],
      params: { leverage: sp.leverage, zScore: Number(z.toFixed(4)), halfLifeBars: fv.halfLifeBars ?? 0, exitZ: sp.shortDelta, side },
      stopDistance,
    };
  }
  if (name === 'FUTURES_LONG' || name === 'FUTURES_SHORT') {
    const side: Side = name === 'FUTURES_LONG' ? 'BUY' : 'SELL';
    const stopDistance = Math.max(ctx.atr * 2, ctx.spot * 0.004);
    return {
      strategy: name,
      legs: [
        {
          kind: 'FUTURE',
          instrument: ctx.futuresInstrument,
          side,
          qty: 1,
          ratio: 1,
          bid: ctx.bid ?? ctx.spot,
          ask: ctx.ask ?? ctx.spot,
          mark: ctx.spot,
        },
      ],
      params: { leverage: sp.leverage, stopAtr: 2 },
      stopDistance,
    };
  }

  const chain = ctx.chain;
  if (!chain || !chain.contracts.length) return { error: 'no option chain available' };
  const expiry = pickExpiry(chain.expiries, ctx.now, sp.targetDte, ctx.minDte, ctx.maxDte);
  if (!expiry) return { error: `no expiry within ${ctx.minDte}-${ctx.maxDte} days` };
  const d = (type: 'C' | 'P', delta: number) => contractByDelta(chain, expiry, type, delta, ctx.now);
  const params: Record<string, number | string> = { expiry, targetDte: sp.targetDte, longDelta: sp.longDelta, shortDelta: sp.shortDelta };
  const need = (...cs: Array<OptionContract | null>) => cs.every(Boolean);

  switch (name) {
    case 'LONG_CALL': {
      const c = d('C', sp.longDelta);
      return c ? { strategy: name, legs: [optLeg(c, 'BUY')], params } : { error: 'no call near target delta' };
    }
    case 'LONG_PUT': {
      const p = d('P', sp.longDelta);
      return p ? { strategy: name, legs: [optLeg(p, 'BUY')], params } : { error: 'no put near target delta' };
    }
    case 'LONG_STRADDLE': {
      const c = contractByStrike(chain, expiry, 'C', chain.spot);
      const p = c ? contractByStrike(chain, expiry, 'P', c.strike) : null;
      return c && p ? { strategy: name, legs: [optLeg(c, 'BUY'), optLeg(p, 'BUY')], params } : { error: 'no ATM pair' };
    }
    case 'LONG_STRANGLE': {
      const c = d('C', sp.longDelta);
      const p = d('P', sp.longDelta);
      if (!need(c, p) || c!.strike <= p!.strike) return { error: 'no OTM strangle strikes' };
      return { strategy: name, legs: [optLeg(c!, 'BUY'), optLeg(p!, 'BUY')], params };
    }
    case 'BULL_CALL_SPREAD': {
      const lo = d('C', sp.longDelta);
      const hi = d('C', sp.shortDelta);
      if (!need(lo, hi) || hi!.strike <= lo!.strike) return { error: 'invalid call spread strikes' };
      return { strategy: name, legs: [optLeg(lo!, 'BUY'), optLeg(hi!, 'SELL')], params };
    }
    case 'BEAR_PUT_SPREAD': {
      const hi = d('P', sp.longDelta);
      const lo = d('P', sp.shortDelta);
      if (!need(lo, hi) || lo!.strike >= hi!.strike) return { error: 'invalid put spread strikes' };
      return { strategy: name, legs: [optLeg(hi!, 'BUY'), optLeg(lo!, 'SELL')], params };
    }
    case 'BULL_PUT_SPREAD': {
      // credit: sell higher-strike put (shortDelta), buy lower-strike put (longDelta) as protection
      const short = d('P', sp.shortDelta);
      const long = d('P', sp.longDelta);
      if (!need(short, long) || long!.strike >= short!.strike) return { error: 'invalid bull put strikes' };
      return { strategy: name, legs: [optLeg(short!, 'SELL'), optLeg(long!, 'BUY')], params };
    }
    case 'BEAR_CALL_SPREAD': {
      const short = d('C', sp.shortDelta);
      const long = d('C', sp.longDelta);
      if (!need(short, long) || long!.strike <= short!.strike) return { error: 'invalid bear call strikes' };
      return { strategy: name, legs: [optLeg(short!, 'SELL'), optLeg(long!, 'BUY')], params };
    }
    case 'IRON_CONDOR': {
      const sp1 = d('P', sp.shortDelta);
      const lp = d('P', sp.longDelta);
      const sc = d('C', sp.shortDelta);
      const lc = d('C', sp.longDelta);
      if (!need(sp1, lp, sc, lc)) return { error: 'missing condor strikes' };
      if (!(lp!.strike < sp1!.strike && sp1!.strike < sc!.strike && sc!.strike < lc!.strike)) return { error: 'condor strikes not ordered' };
      return { strategy: name, legs: [optLeg(sp1!, 'SELL'), optLeg(lp!, 'BUY'), optLeg(sc!, 'SELL'), optLeg(lc!, 'BUY')], params };
    }
    case 'LONG_CALL_BUTTERFLY': {
      const body = contractByStrike(chain, expiry, 'C', chain.spot);
      const wing = d('C', sp.shortDelta);
      if (!body || !wing || wing.strike <= body.strike) return { error: 'invalid butterfly' };
      const width = wing.strike - body.strike;
      const low = contractByStrike(chain, expiry, 'C', body.strike - width);
      if (!low || Math.abs(body.strike - low.strike - width) > width * 0.25) return { error: 'asymmetric butterfly wings unavailable' };
      return { strategy: name, legs: [optLeg(low, 'BUY'), optLeg(body, 'SELL', 2), optLeg(wing, 'BUY')], params: { ...params, width } };
    }
    default:
      return { error: `unsupported strategy ${name}` };
  }
}

/** Static descriptions surfaced in the dashboard. */
export const STRATEGY_INFO: Record<StrategyName, { risk: 'DEFINED' | 'STOP_DEFINED'; vega: '+' | '-' | '0'; bias: string; description: string }> = {
  LONG_CALL: { risk: 'DEFINED', vega: '+', bias: 'bullish', description: 'Buy call. Max loss = premium. Unbounded upside.' },
  LONG_PUT: { risk: 'DEFINED', vega: '+', bias: 'bearish', description: 'Buy put. Max loss = premium.' },
  LONG_STRADDLE: { risk: 'DEFINED', vega: '+', bias: 'large move either way', description: 'Buy ATM call + put. Profits when realized move exceeds implied.' },
  LONG_STRANGLE: { risk: 'DEFINED', vega: '+', bias: 'large move either way', description: 'Buy OTM call + put. Cheaper than straddle, needs a bigger move.' },
  BULL_CALL_SPREAD: { risk: 'DEFINED', vega: '0', bias: 'moderately bullish', description: 'Buy lower call, sell higher call. Cheaper, capped upside.' },
  BEAR_PUT_SPREAD: { risk: 'DEFINED', vega: '0', bias: 'moderately bearish', description: 'Buy higher put, sell lower put.' },
  BULL_PUT_SPREAD: { risk: 'DEFINED', vega: '-', bias: 'neutral-bullish', description: 'Credit spread: sell put, buy lower put. Max loss = width - credit.' },
  BEAR_CALL_SPREAD: { risk: 'DEFINED', vega: '-', bias: 'neutral-bearish', description: 'Credit spread: sell call, buy higher call.' },
  IRON_CONDOR: { risk: 'DEFINED', vega: '-', bias: 'range-bound', description: 'Sell OTM put & call spreads. Profits if price stays in range.' },
  LONG_CALL_BUTTERFLY: { risk: 'DEFINED', vega: '-', bias: 'pin near ATM', description: '1-2-1 call butterfly. Cheap, max profit at body strike.' },
  FUTURES_LONG: { risk: 'STOP_DEFINED', vega: '0', bias: 'bullish', description: 'Long perpetual with mandatory ATR stop. Default PAPER-only until independently validated; LIVE requires paperOnly=false on an operator-approved model.' },
  FUTURES_SHORT: { risk: 'STOP_DEFINED', vega: '0', bias: 'bearish', description: 'Short perpetual with mandatory ATR stop. Default PAPER-only until independently validated; LIVE requires paperOnly=false on an operator-approved model.' },
  FUTURES_TSMOM: {
    risk: 'STOP_DEFINED',
    vega: '0',
    bias: 'trend-following',
    description: 'Time-series-momentum on the perpetual: BUY when score ≥ entry, SELL (PAPER-only) when score ≤ −entry, exit when the score crosses the exit threshold back toward zero; vol-targeted size, wide ATR catastrophe stop. Longs remain live-capable; shorts are rejected in LIVE.',
  },
  FUTURES_CARRY: {
    risk: 'STOP_DEFINED',
    vega: '0',
    bias: 'funding/basis carry',
    description: 'PAPER-only: short a rich perpetual (positive funding / positive mark-basis) or long a cheap one. Funding collected is not guaranteed profit after price move and fees. CoinDCX cash-spot index is not in this client; basis is ln(last/mark).',
  },
  FUTURES_XSMOM: {
    risk: 'STOP_DEFINED',
    vega: '0',
    bias: 'relative strength',
    description: 'PAPER-only cross-sectional momentum vs peer perpetuals on the same closed-bar horizon. Rank alone cannot enter: TSMOM sign must agree, and hard risk gates still apply.',
  },
  FUTURES_DONCHIAN: {
    risk: 'STOP_DEFINED',
    vega: '0',
    bias: 'breakout trend-following',
    description: 'PAPER-only Donchian-channel ensemble (lookbacks 5-360 days, Zarattini-Pagani-Barbon 2025): enter when enough lookbacks have broken to new highs, exit on the ratcheting channel-midpoint trailing stop. Long side as published; mirrored short side is research-only.',
  },
  FUTURES_MR: {
    risk: 'STOP_DEFINED',
    vega: '0',
    bias: 'mean-reverting',
    description: 'PAPER-only fade of a statistically mean-reverting z-score in range/low-vol regimes. Suspended on CUSUM change-points. Not used in trend regimes (affinity 0).',
  },
};
