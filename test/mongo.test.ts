/**
 * MongoDB adapter integration tests. Run against a real replica set:
 *   MONGODB_URI_TEST="mongodb://localhost:27017/?replicaSet=rs0" npm test
 * Skipped automatically when MONGODB_URI_TEST is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMongoRepositories } from '../src/persistence/mongo/index.js';
import { DuplicateOrderError, type Repositories } from '../src/persistence/ports.js';
import { newOrderState } from '../src/execution/venue.js';

const uri = process.env.MONGODB_URI_TEST;
const d = uri ? describe : describe.skip;

d('MongoDB repositories', () => {
  let repos: Repositories & { db: import('mongodb').Db; client: import('mongodb').MongoClient };
  const dbName = `crypto_hacks_test_${Date.now()}`;
  beforeAll(async () => {
    repos = await createMongoRepositories({ uri: uri!, dbName, maxPoolSize: 5, transactions: true, writeConcern: 'majority' });
  });
  afterAll(async () => {
    await repos.db.dropDatabase();
    await repos.close();
  });

  it('applies migrations idempotently', async () => {
    const m = await repos.db.collection('schema_migrations').countDocuments();
    expect(m).toBeGreaterThanOrEqual(3);
  });
  it('append-only ledger with verifiable hash chain', async () => {
    for (let i = 0; i < 10; i++) await repos.audit.append({ id: `a${i}`, ts: i, actor: 't', action: 'x', details: { i } });
    expect((await repos.audit.verifyChain()).ok).toBe(true);
    await repos.db.collection('audit_log').updateOne({ id: 'a4' }, { $set: { actor: 'evil' } });
    const v = await repos.audit.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(5);
  });
  it('concurrent ledger appends keep a gap-free sequence', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => repos.experiments.append({ id: `e${i}`, ts: i, kind: 'BACKTEST', modelVersion: 'm', summary: '', metrics: {} })));
    expect((await repos.experiments.verifyChain()).ok).toBe(true);
    expect(await repos.experiments.count()).toBe(20);
  });
  it('unique clientOrderId prevents duplicate orders', async () => {
    const o = newOrderState({ clientOrderId: 'c-1', decisionId: 'd', positionId: 'p', legIndex: 0, instrument: 'X', kind: 'FUTURE', side: 'BUY', qty: 1, type: 'MARKET', refPrice: 1 }, 1);
    await repos.orders.create(o, 'PAPER');
    await expect(repos.orders.create(o, 'PAPER')).rejects.toBeInstanceOf(DuplicateOrderError);
  });
  it('lease allows a single active engine', async () => {
    expect(await repos.state.acquireLease('engine', 'A', 10_000, 1000)).toBe(true);
    expect(await repos.state.acquireLease('engine', 'B', 10_000, 2000)).toBe(false);
    expect(await repos.state.acquireLease('engine', 'B', 10_000, 20_000)).toBe(true);
  });
  it('candles upsert and range queries', async () => {
    await repos.candles.upsertMany('S', '1h', [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }, { t: 2, o: 1, h: 2, l: 0.5, c: 1.6, v: 3 }]);
    await repos.candles.upsertMany('S', '1h', [{ t: 2, o: 1, h: 2, l: 0.5, c: 1.7, v: 3 }]);
    const r = await repos.candles.range('S', '1h', 0, 10);
    expect(r.map((x) => x.c)).toEqual([1.5, 1.7]);
  });
});
