import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, MongoServerError, type ClientSession, type Collection, type Db, type Document } from 'mongodb';
import type {
  Repositories,
  LedgerRepo,
  Ledgered,
  Page,
  ModelVersionDoc,
  EquitySnapshot,
  AlertRecord,
} from '../ports.js';
import { DuplicateOrderError } from '../ports.js';
import { GENESIS_HASH, buildMeta, KeyedMutex, verifyRecords } from '../ledger.js';
import { runMigrations } from './migrations.js';
import type { Candle, OptionChainSnapshot, RegimeClassification, OrderState, Position, Mode } from '../../domain/types.js';
import { TERMINAL_ORDER_STATUSES } from '../../domain/types.js';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('mongo');
const als = new AsyncLocalStorage<ClientSession>();
const s = () => {
  const session = als.getStore();
  return session ? { session } : {};
};
const noId = { projection: { _id: 0 } } as const;

class MongoLedger<T extends object> implements LedgerRepo<T> {
  private mutex = new KeyedMutex();
  constructor(private readonly coll: Collection<Document>, private readonly tsField = 'ts') {}

  append(rec: T): Promise<Ledgered<T>> {
    return this.mutex.run(this.coll.collectionName, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await this.coll.find({}, { ...s(), sort: { '_ledger.seq': -1 }, limit: 1, projection: { _ledger: 1 } }).next();
        const prevHash = (last?._ledger?.hash as string) ?? GENESIS_HASH;
        const seq = ((last?._ledger?.seq as number) ?? 0) + 1;
        const payload = JSON.parse(JSON.stringify(rec)) as T; // normalise (drop undefined) so hash is reproducible
        const meta = buildMeta(prevHash, seq, payload, Date.now());
        const doc = { ...payload, _ledger: meta } as Ledgered<T>;
        try {
          await this.coll.insertOne({ ...doc } as Document, s());
          return doc;
        } catch (e) {
          // another writer took this seq: retry with the new head
          if (e instanceof MongoServerError && e.code === 11000 && String(e.message).includes('_ledger.seq')) continue;
          throw e;
        }
      }
      throw new Error(`ledger ${this.coll.collectionName}: could not append after retries`);
    });
  }

  async list(filter: Record<string, unknown> = {}, page?: Page): Promise<Ledgered<T>[]> {
    const q: Document = { ...filter };
    if (page?.before) q[this.tsField] = { $lt: page.before };
    const rows = await this.coll.find(q, { ...noId, ...s(), sort: { '_ledger.seq': -1 }, limit: page?.limit ?? 200 }).toArray();
    return rows as unknown as Ledgered<T>[];
  }

  count(filter: Record<string, unknown> = {}) {
    return this.coll.countDocuments(filter, s());
  }

  async verifyChain() {
    const rows = await this.coll.find({}, { ...noId, sort: { '_ledger.seq': 1 } }).toArray();
    return verifyRecords<T>(rows as unknown as Array<T & { _ledger: Ledgered<T>['_ledger'] }>);
  }
}

export interface MongoOptions {
  uri: string;
  dbName: string;
  maxPoolSize: number;
  transactions: boolean;
  writeConcern: string;
}

export async function createMongoRepositories(o: MongoOptions): Promise<Repositories & { db: Db; client: MongoClient }> {
  const client = new MongoClient(o.uri, {
    maxPoolSize: o.maxPoolSize,
    retryWrites: true,
    writeConcern: { w: o.writeConcern === 'majority' ? 'majority' : Number(o.writeConcern) || 1, journal: true },
    readConcern: { level: 'majority' },
    serverSelectionTimeoutMS: 10_000,
    appName: 'crypto-hacks-engine',
  });
  await client.connect();
  const db = client.db(o.dbName);
  const ran = await runMigrations(db);
  if (ran.length) log.info({ ran }, 'migrations applied');

  let txSupported = o.transactions;
  if (txSupported) {
    try {
      const hello = await db.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid') {
        log.warn('MongoDB is not a replica set: multi-document transactions disabled. Use a replica set in production.');
        txSupported = false;
      }
    } catch {
      txSupported = false;
    }
  }

  const c = (n: string) => db.collection(n);

  const repos: Repositories & { db: Db; client: MongoClient } = {
    db,
    client,
    candles: {
      async upsertMany(symbol, tf, candles: Candle[]) {
        if (!candles.length) return 0;
        const ops = candles.map((k) => ({
          updateOne: { filter: { symbol, tf, t: k.t }, update: { $set: { symbol, tf, ...k } }, upsert: true },
        }));
        const r = await c('candles').bulkWrite(ops, { ordered: false, ...s() });
        return r.upsertedCount + r.modifiedCount;
      },
      async range(symbol, tf, from, to) {
        return (await c('candles')
          .find({ symbol, tf, t: { $gte: from, $lte: to } }, { projection: { _id: 0, symbol: 0, tf: 0 }, sort: { t: 1 } })
          .toArray()) as unknown as Candle[];
      },
      async latest(symbol, tf, limit) {
        const rows = (await c('candles')
          .find({ symbol, tf }, { projection: { _id: 0, symbol: 0, tf: 0 }, sort: { t: -1 }, limit })
          .toArray()) as unknown as Candle[];
        return rows.reverse();
      },
    },
    chains: {
      async insert(snap: OptionChainSnapshot) {
        await c('chain_snapshots').insertOne({ ...snap, createdAt: new Date(snap.ts) }, s());
      },
      async latest(underlying) {
        return (await c('chain_snapshots').findOne({ underlying }, { projection: { _id: 0, createdAt: 0 }, sort: { ts: -1 } })) as unknown as OptionChainSnapshot | null;
      },
      async range(underlying, from, to) {
        return (await c('chain_snapshots')
          .find({ underlying, ts: { $gte: from, $lte: to } }, { projection: { _id: 0, createdAt: 0 }, sort: { ts: 1 } })
          .toArray()) as unknown as OptionChainSnapshot[];
      },
      async metricsHistory(underlying, from) {
        const rows = await c('chain_snapshots')
          .find({ underlying, ts: { $gte: from } }, { projection: { _id: 0, ts: 1, spot: 1, 'metrics.atmIv': 1, 'metrics.pcrOpenInterest': 1 }, sort: { ts: 1 } })
          .toArray();
        return rows.map((r) => ({ ts: r.ts, spot: r.spot, atmIv: r.metrics?.atmIv, pcrOpenInterest: r.metrics?.pcrOpenInterest }));
      },
    },
    regimes: {
      async insert(r: RegimeClassification) {
        await c('regime_history').insertOne({ ...r, createdAt: new Date(r.ts) }, s());
      },
      async history(symbol, page) {
        const q: Document = { symbol };
        if (page?.before) q.ts = { $lt: page.before };
        return (await c('regime_history')
          .find(q, { projection: { _id: 0, createdAt: 0 }, sort: { ts: -1 }, limit: page?.limit ?? 200 })
          .toArray()) as unknown as RegimeClassification[];
      },
    },
    decisions: new MongoLedger(c('decisions')),
    outcomes: new MongoLedger(c('outcomes')),
    orderEvents: new MongoLedger(c('order_events')),
    fills: new MongoLedger(c('fills')),
    trades: new MongoLedger(c('trades'), 'closedAt'),
    experiments: new MongoLedger(c('experiments')),
    audit: new MongoLedger(c('audit_log')),
    orders: {
      async create(o: OrderState, mode: Mode) {
        try {
          await c('orders').insertOne({ ...o, clientOrderId: o.request.clientOrderId, mode }, s());
        } catch (e) {
          if (e instanceof MongoServerError && e.code === 11000) throw new DuplicateOrderError(o.request.clientOrderId);
          throw e;
        }
      },
      async update(o: OrderState, mode: Mode) {
        await c('orders').updateOne(
          { clientOrderId: o.request.clientOrderId },
          { $set: { ...o, mode, status: o.status, clientOrderId: o.request.clientOrderId } },
          { upsert: true, ...s() },
        );
      },
      async get(id) {
        return (await c('orders').findOne({ clientOrderId: id }, { projection: { _id: 0, clientOrderId: 0, mode: 0 } })) as unknown as OrderState | null;
      },
      async listOpen(mode) {
        return (await c('orders')
          .find({ mode, status: { $nin: TERMINAL_ORDER_STATUSES } }, { projection: { _id: 0, clientOrderId: 0, mode: 0 } })
          .toArray()) as unknown as OrderState[];
      },
      async listByPosition(positionId) {
        return (await c('orders')
          .find({ 'request.positionId': positionId }, { projection: { _id: 0, clientOrderId: 0, mode: 0 }, sort: { createdAt: 1 } })
          .toArray()) as unknown as OrderState[];
      },
      async recent(mode, page) {
        return (await c('orders')
          .find(mode ? { mode } : {}, { projection: { _id: 0, clientOrderId: 0, mode: 0 }, sort: { createdAt: -1 }, limit: page?.limit ?? 100 })
          .toArray()) as unknown as OrderState[];
      },
    },
    positions: {
      async upsert(p: Position) {
        await c('positions').replaceOne({ id: p.id }, { ...p }, { upsert: true, ...s() });
      },
      async get(id) {
        return (await c('positions').findOne({ id }, noId)) as unknown as Position | null;
      },
      async listOpen(mode) {
        return (await c('positions').find({ mode, status: { $in: ['OPENING', 'OPEN', 'CLOSING'] } }, noId).toArray()) as unknown as Position[];
      },
      async list(mode, page) {
        return (await c('positions')
          .find(mode ? { mode } : {}, { ...noId, sort: { openedAt: -1 }, limit: page?.limit ?? 200 })
          .toArray()) as unknown as Position[];
      },
    },
    models: {
      async insert(m: ModelVersionDoc) {
        await c('model_versions').insertOne({ ...m }, s());
      },
      async get(version) {
        return (await c('model_versions').findOne({ version }, noId)) as unknown as ModelVersionDoc | null;
      },
      async update(version, patch) {
        const r = await c('model_versions').updateOne({ version }, { $set: patch }, s());
        if (!r.matchedCount) throw new Error(`model ${version} not found`);
      },
      async list() {
        return (await c('model_versions').find({}, { ...noId, sort: { createdAt: -1 } }).toArray()) as unknown as ModelVersionDoc[];
      },
      async activeFor(mode) {
        return (await c('model_versions').findOne(mode === 'LIVE' ? { activeInLive: true } : { activeInPaper: true }, noId)) as unknown as ModelVersionDoc | null;
      },
    },
    equity: {
      async insert(e: EquitySnapshot) {
        await c('equity_snapshots').insertOne({ ...e }, s());
      },
      async series(mode, from) {
        return (await c('equity_snapshots').find({ mode, ts: { $gte: from } }, { ...noId, sort: { ts: 1 } }).toArray()) as unknown as EquitySnapshot[];
      },
    },
    state: {
      async get<T>(key: string) {
        const d = await c('engine_state').findOne({ _id: key as unknown as Document['_id'] });
        return d?.value as T | undefined;
      },
      async set<T>(key: string, value: T) {
        await c('engine_state').updateOne({ _id: key as unknown as Document['_id'] }, { $set: { value, updatedAt: Date.now() } }, { upsert: true, ...s() });
      },
      async acquireLease(name, owner, ttlMs, now) {
        try {
          const r = await c('leases').findOneAndUpdate(
            { _id: name as unknown as Document['_id'], $or: [{ owner }, { until: { $lt: now } }] },
            { $set: { owner, until: now + ttlMs } },
            { upsert: true, returnDocument: 'after' },
          );
          return r?.owner === owner;
        } catch (e) {
          if (e instanceof MongoServerError && e.code === 11000) return false; // held by another live owner
          throw e;
        }
      },
      async releaseLease(name, owner) {
        await c('leases').deleteOne({ _id: name as unknown as Document['_id'], owner });
      },
    },
    alerts: {
      async insert(a: AlertRecord) {
        await c('alerts').insertOne({ ...a });
      },
      async recent(page) {
        return (await c('alerts').find({}, { ...noId, sort: { ts: -1 }, limit: page?.limit ?? 100 }).toArray()) as unknown as AlertRecord[];
      },
      async acknowledge(id) {
        await c('alerts').updateOne({ id }, { $set: { acknowledged: true } });
      },
    },
    async ping() {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      if (!txSupported || als.getStore()) return fn();
      const session = client.startSession();
      try {
        let result!: T;
        await session.withTransaction(async () => {
          result = await als.run(session, fn);
        });
        return result;
      } finally {
        await session.endSession();
      }
    },
    async close() {
      await client.close();
    },
  };
  return repos;
}
