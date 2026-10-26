import { describe, it, expect } from 'vitest';
import * as I from '../src/indicators/core.js';
import * as V from '../src/indicators/volatility.js';
import { gbm, trend } from './helpers.js';

describe('moving averages & momentum', () => {
  it('sma/ema basic values', () => {
    const x = [1, 2, 3, 4, 5, 6];
    expect(I.sma(x, 3).slice(2)).toEqual([2, 3, 4, 5]);
    const e = I.ema(x, 3);
    expect(e[2]).toBeCloseTo(2);
    expect(e[3]).toBeCloseTo(3); // 4*0.5 + 2*0.5
    expect(Number.isNaN(e[0])).toBe(true);
  });

  it('rsi is 100 for monotonic rise and ~50 for alternating', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(I.last(I.rsi(up, 14))).toBe(100);
    const alt = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
    expect(I.last(I.rsi(alt, 14))).toBeGreaterThan(40);
    expect(I.last(I.rsi(alt, 14))).toBeLessThan(60);
  });

  it('macd histogram positive in an uptrend', () => {
    const c = trend(200, 0.003);
    expect(I.last(I.macd(I.closes(c)).hist)).toBeGreaterThan(0);
  });

  it('ADX high and +DI > -DI in a clean uptrend', () => {
    const c = trend(300, 0.004, 100, '1h', 0.0005);
    const a = I.adx(c, 14);
    expect(I.last(a.adx)).toBeGreaterThan(30);
    expect(I.last(a.plusDI)).toBeGreaterThan(I.last(a.minusDI));
  });

  it('efficiency ratio ~1 for straight line, low for noise', () => {
    const line = Array.from({ length: 50 }, (_, i) => 100 + i);
    expect(I.last(I.efficiencyRatio(line, 20))).toBeCloseTo(1);
    const noise = I.closes(gbm(300, { sigma: 0.8, seed: 9 }));
    expect(I.last(I.efficiencyRatio(noise, 20))).toBeLessThan(0.6);
  });

  it('choppiness lower for trend than for random walk', () => {
    const t = I.last(I.choppiness(trend(200, 0.004, 100, '1h', 0.0005), 14));
    const r = I.last(I.choppiness(gbm(200, { seed: 4 }), 14));
    expect(t).toBeLessThan(r);
  });

  it('indicators have NO look-ahead: values at i unchanged when future bars are appended', () => {
    const c = gbm(400, { seed: 5 });
    const head = c.slice(0, 300);
    const fns: Array<(x: typeof c) => number[]> = [
      (x) => I.ema(I.closes(x), 20),
      (x) => I.rsi(I.closes(x), 14),
      (x) => I.atr(x, 14),
      (x) => I.adx(x, 14).adx,
      (x) => I.bollinger(I.closes(x), 20).width,
      (x) => I.supertrend(x).direction,
      (x) => I.vwapDaily(x),
      (x) => I.ichimoku(x).cloudTop,
      (x) => I.choppiness(x, 14),
      (x) => I.mfi(x, 14),
    ];
    for (const fn of fns) {
      const a = fn(head);
      const b = fn(c).slice(0, 300);
      for (let i = 0; i < 300; i++) {
        if (Number.isNaN(a[i])) expect(Number.isNaN(b[i])).toBe(true);
        else expect(b[i]).toBeCloseTo(a[i], 9);
      }
    }
  });

  it('hurst > 0.5 for trending, swings & pivots work', () => {
    expect(I.hurst(I.closes(trend(600, 0.002, 100, '1h', 0.002)), 512)).toBeGreaterThan(0.55);
    const p = I.floorPivots(110, 90, 100);
    expect(p.p).toBeCloseTo(100);
    expect(p.r1).toBeCloseTo(110);
  });
});

describe('volatility estimators', () => {
  const sigma = 0.6;
  const c = gbm(3000, { sigma, seed: 11, tf: '1h', sub: 60 });
  it.each([
    ['close-to-close', V.closeToCloseVol],
    ['parkinson', V.parkinsonVol],
    ['garman-klass', V.garmanKlassVol],
    ['rogers-satchell', V.rogersSatchellVol],
    ['yang-zhang', V.yangZhangVol],
  ])('%s recovers true vol within 25%%', (_, fn) => {
    const v = (fn as typeof V.yangZhangVol)(c, 2000, '1h');
    // range estimators are slightly biased low with discretely sampled highs/lows
    expect(v).toBeGreaterThan(sigma * 0.8);
    expect(v).toBeLessThan(sigma * 1.2);
  });
  it('GARCH forecast is finite and persistence < 1', () => {
    const g = V.garchForecast(c, '1h', 24);
    expect(g.vol).toBeGreaterThan(0.2);
    expect(g.persistence).toBeLessThan(1);
  });
});
