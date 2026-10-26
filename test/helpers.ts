import { loadConfig, type AppConfig } from '../src/config/index.js';
import type { Candle, OptionChainSnapshot, Timeframe } from '../src/domain/types.js';
import type { MarketView } from '../src/marketdata/view.js';
import { closedOnly } from '../src/marketdata/view.js';
import { syntheticChainFromCandles } from './fixtures/synthetic-chain.js';
import { mulberry32, gaussian } from '../src/lib/math.js';
import type { Clock } from '../src/lib/clock.js';
import { TIMEFRAME_MS } from '../src/domain/types.js';
import { bsPrice } from '../src/options/pricing.js';
import { yearsTo } from '../src/options/chain.js';

export function testConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return loadConfig({ configDir: '/nonexistent-dir', env: {}, overrides: { db: { driver: 'memory' }, ...overrides } }).config;
}

export function gbm(n: number, opts: { start?: number; tf?: Timeframe; s0?: number; mu?: number; sigma?: number; seed?: number; sub?: number } = {}): Candle[] {
  const tf = opts.tf ?? '1h';
  const ms = TIMEFRAME_MS[tf];
  const dt = ms / (365 * 86_400_000);
  const rng = mulberry32(opts.seed ?? 1);
  const mu = opts.mu ?? 0;
  const sigma = opts.sigma ?? 0.6;
  let p = opts.s0 ?? 100;
  const out: Candle[] = [];
  const start = opts.start ?? Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = p;
    let h = p;
    let l = p;
    const sub = opts.sub ?? 4;
    for (let k = 0; k < sub; k++) {
      p *= Math.exp((mu - 0.5 * sigma * sigma) * (dt / sub) + sigma * Math.sqrt(dt / sub) * gaussian(rng));
      h = Math.max(h, p);
      l = Math.min(l, p);
    }
    out.push({ t: start + i * ms, o, h, l, c: p, v: 100 + rng() * 50 });
  }
  return out;
}

/** Trending series with low noise. */
export function trend(n: number, slopePerBar: number, s0 = 100, tf: Timeframe = '1h', noise = 0.001, seed = 3): Candle[] {
  const rng = mulberry32(seed);
  const ms = TIMEFRAME_MS[tf];
  const out: Candle[] = [];
  let p = s0;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + slopePerBar + noise * gaussian(rng));
    out.push({ t: Date.UTC(2025, 0, 1) + i * ms, o, h: Math.max(o, p) * (1 + noise / 2), l: Math.min(o, p) * (1 - noise / 2), c: p, v: 100 + 20 * rng() });
  }
  return out;
}

/** Simple controllable MarketView for unit/integration tests. */
export class FakeMarket implements MarketView {
  price = new Map<string, number>();
  candles = new Map<string, Partial<Record<Timeframe, Candle[]>>>();
  chains = new Map<string, OptionChainSnapshot | null>();
  ageMs = 0;
  constructor(public clock: Clock) {}
  now() {
    return this.clock.now();
  }
  setCandles(sym: string, tf: Timeframe, c: Candle[]) {
    const m = this.candles.get(sym) ?? {};
    m[tf] = c;
    this.candles.set(sym, m);
    this.price.set(sym, c[c.length - 1].c);
  }
  closedCandles(sym: string, tf: Timeframe) {
    return closedOnly(this.candles.get(sym)?.[tf] ?? [], tf, this.clock.now());
  }
  lastPrice(sym: string) {
    const p = this.price.get(sym);
    return p ? { price: p, ts: this.clock.now() - this.ageMs } : null;
  }
  topOfBook(sym: string) {
    const p = this.price.get(sym);
    return p ? { bid: p * 0.9999, ask: p * 1.0001, ts: this.clock.now() } : null;
  }
  mark(sym: string) {
    const p = this.price.get(sym);
    return p ? { mark: p, fundingRate: 0.0001, ts: this.clock.now() } : null;
  }
  private chainCache = new Map<string, OptionChainSnapshot>();
  /** Fixture chain: fixed strike grid (like a real venue), re-priced at the current spot. */
  chain(sym: string) {
    if (this.chains.has(sym)) return this.chains.get(sym)!;
    const p = this.price.get(sym);
    const c = this.candles.get(sym)?.['1h'] ?? [];
    if (!p || c.length < 50) return null;
    let base = this.chainCache.get(sym);
    if (!base) {
      base = syntheticChainFromCandles('BTC', p, this.clock.now(), c.slice(-200), '1h', { vrp: 1.1, spreadPct: 3 })!;
      this.chainCache.set(sym, base);
    }
    const now = this.clock.now();
    const contracts = base.contracts.map((k) => {
      const mark = bsPrice({ S: p, K: k.strike, T: yearsTo(k.expiry, now), sigma: k.iv, type: k.type });
      const half = Math.max(mark * 0.015, p * 0.00005);
      return { ...k, mark, bid: Math.max(0, mark - half), ask: mark + half };
    });
    return { ...base, ts: now, spot: p, contracts };
  }
  ivHistory() {
    return [];
  }
  oiHistory() {
    return [];
  }
  dataAgeMs() {
    return this.ageMs;
  }
}
