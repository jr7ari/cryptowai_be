import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DeribitReference } from '../src/integrations/deribit/reference.js';
import { MarketQuoter } from '../src/execution/quoter.js';
import { PaperVenue } from '../src/execution/paper.js';
import { SimulatedClock } from '../src/lib/clock.js';
import type { MarketView } from '../src/marketdata/view.js';
import { testConfig } from './helpers.js';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('application runtime uses REAL data only', () => {
  const files = walk(join(__dirname, '../src')).filter((f) => f.endsWith('.ts'));
  it('no runtime file imports test fixtures or synthetic generators', () => {
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/from ['"][^'"]*(\/test\/|fixtures)/);
      expect(s, f).not.toMatch(/buildSyntheticChain|syntheticChainFromCandles|generateRegimeSeries|startMockExchange/);
      expect(s, f).not.toMatch(/source: 'TEST_FIXTURE'/);
    }
  });

  it('Deribit chain keeps only contracts with a real two-sided market (no invented bid/ask)', async () => {
    const now = Date.UTC(2026, 9, 25);
    const body = {
      result: [
        { instrument_name: 'BTC-27NOV26-70000-C', bid_price: 0.05, ask_price: 0.052, mark_price: 0.051, mark_iv: 50, underlying_price: 70000, open_interest: 10, volume: 1, creation_timestamp: now },
        { instrument_name: 'BTC-27NOV26-90000-C', bid_price: null, ask_price: 0.002, mark_price: 0.001, mark_iv: 60, underlying_price: 70000, open_interest: 5, volume: 0, creation_timestamp: now },
        { instrument_name: 'BTC-27NOV26-60000-P', bid_price: 0.01, ask_price: 0.011, mark_price: 0.0105, mark_iv: 52, underlying_price: 70000, open_interest: 7, volume: 2, creation_timestamp: now },
      ],
    };
    const f = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const chain = await new DeribitReference('https://x', f).chain('BTC', now);
    expect(chain.contracts.map((c) => c.symbol)).toEqual(['BTC-27NOV26-70000-C', 'BTC-27NOV26-60000-P']);
    expect(chain.contracts[0].bid).toBeCloseTo(0.05 * 70000);
    expect(chain.source).toBe('DERIBIT_REF');
  });

  it('quoter never invents a price: no real book / contract => null', () => {
    const clock = new SimulatedClock(1_000_000);
    const empty: MarketView = {
      now: () => clock.now(), closedCandles: () => [], lastPrice: () => ({ price: 100, ts: clock.now() }), topOfBook: () => null, mark: () => null,
      chain: () => null, ivHistory: () => [], oiHistory: () => [], dataAgeMs: () => 0,
    };
    const q = new MarketQuoter(empty, clock, () => 'B-BTC_USDT');
    expect(q.quote('B-BTC_USDT', 'FUTURE')).toBeNull();
    expect(q.quote('BTC-27NOV26-70000-C', 'OPTION')).toBeNull();
  });

  it('paper futures fills walk the real order-book levels (VWAP)', async () => {
    const clock = new SimulatedClock(1_000_000);
    const book = { instrument: 'B-BTC_USDT', ts: clock.now(), bids: [{ price: 99, qty: 1 }], asks: [{ price: 101, qty: 1 }, { price: 102, qty: 1 }] };
    const m: MarketView = {
      now: () => clock.now(), closedCandles: () => [], lastPrice: () => ({ price: 100, ts: clock.now() }), topOfBook: () => ({ bid: 99, ask: 101, ts: clock.now() }),
      mark: () => null, chain: () => null, ivHistory: () => [], oiHistory: () => [], dataAgeMs: () => 0, orderBook: () => book,
    };
    const cfg = testConfig();
    const v = new PaperVenue({ ...cfg.paper, slippageBps: 0 }, m, clock, () => 'B-BTC_USDT', false);
    const o = await v.submit({ clientOrderId: 'a', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'B-BTC_USDT', kind: 'FUTURE', side: 'BUY', qty: 1.5, type: 'MARKET', refPrice: 101 });
    expect(o.status).toBe('FILLED');
    expect(o.avgPrice).toBeCloseTo((101 * 1 + 102 * 0.5) / 1.5, 8);
  });
});
