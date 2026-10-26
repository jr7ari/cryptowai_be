import type { Db } from 'mongodb';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('migrations');

export const LEDGER_COLLECTIONS = ['decisions', 'outcomes', 'order_events', 'fills', 'trades', 'experiments', 'audit_log'] as const;

export interface Migration {
  version: number;
  name: string;
  up(db: Db): Promise<void>;
}

async function ensureCollection(db: Db, name: string, validator?: Record<string, unknown>) {
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection(name, validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {});
  } else if (validator) {
    await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
  }
}

const ledgerMetaSchema = {
  bsonType: 'object',
  required: ['seq', 'prevHash', 'hash', 'recordedAt'],
  properties: {
    seq: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    prevHash: { bsonType: 'string', minLength: 64, maxLength: 64 },
    hash: { bsonType: 'string', minLength: 64, maxLength: 64 },
    recordedAt: { bsonType: ['long', 'double', 'int'] },
  },
};
const ledgerValidator = (required: string[]) => ({
  $jsonSchema: { bsonType: 'object', required: ['_ledger', ...required], properties: { _ledger: ledgerMetaSchema } },
});

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core collections, validators and indexes',
    async up(db) {
      await ensureCollection(db, 'candles', {
        $jsonSchema: {
          bsonType: 'object',
          required: ['symbol', 'tf', 't', 'o', 'h', 'l', 'c', 'v'],
          properties: { t: { bsonType: ['long', 'double', 'int'] }, o: { bsonType: ['double', 'int', 'long'] } },
        },
      });
      await db.collection('candles').createIndex({ symbol: 1, tf: 1, t: 1 }, { unique: true });

      await ensureCollection(db, 'chain_snapshots');
      await db.collection('chain_snapshots').createIndex({ underlying: 1, ts: -1 });

      await ensureCollection(db, 'regime_history');
      await db.collection('regime_history').createIndex({ symbol: 1, ts: -1 });

      await ensureCollection(db, 'decisions', ledgerValidator(['id', 'ts', 'mode', 'symbol', 'regime', 'action']));
      await ensureCollection(db, 'outcomes', ledgerValidator(['decisionId', 'positionId', 'ts']));
      await ensureCollection(db, 'order_events', ledgerValidator(['clientOrderId', 'ts', 'status']));
      await ensureCollection(db, 'fills', ledgerValidator(['clientOrderId', 'ts', 'qty', 'price']));
      await ensureCollection(db, 'trades', ledgerValidator(['positionId', 'strategy', 'regime', 'realizedPnl', 'closedAt']));
      await ensureCollection(db, 'experiments', ledgerValidator(['id', 'ts', 'kind', 'modelVersion']));
      await ensureCollection(db, 'audit_log', ledgerValidator(['id', 'ts', 'actor', 'action']));
      for (const c of LEDGER_COLLECTIONS) await db.collection(c).createIndex({ '_ledger.seq': 1 }, { unique: true });
      await db.collection('decisions').createIndex({ id: 1 }, { unique: true });
      await db.collection('decisions').createIndex({ symbol: 1, ts: -1 });
      await db.collection('order_events').createIndex({ clientOrderId: 1, ts: 1 });
      await db.collection('fills').createIndex({ clientOrderId: 1 });
      await db.collection('trades').createIndex({ positionId: 1 }, { unique: true });
      await db.collection('trades').createIndex({ regime: 1, strategy: 1, closedAt: -1 });
      await db.collection('trades').createIndex({ modelVersion: 1, closedAt: -1 });

      await ensureCollection(db, 'orders', {
        $jsonSchema: { bsonType: 'object', required: ['clientOrderId', 'mode', 'status', 'request'] },
      });
      await db.collection('orders').createIndex({ clientOrderId: 1 }, { unique: true });
      await db.collection('orders').createIndex({ mode: 1, status: 1 });
      await db.collection('orders').createIndex({ 'request.positionId': 1 });

      await ensureCollection(db, 'positions', { $jsonSchema: { bsonType: 'object', required: ['id', 'mode', 'status', 'strategy'] } });
      await db.collection('positions').createIndex({ id: 1 }, { unique: true });
      await db.collection('positions').createIndex({ mode: 1, status: 1 });

      await ensureCollection(db, 'model_versions', { $jsonSchema: { bsonType: 'object', required: ['version', 'status', 'params'] } });
      await db.collection('model_versions').createIndex({ version: 1 }, { unique: true });

      await ensureCollection(db, 'equity_snapshots');
      await db.collection('equity_snapshots').createIndex({ mode: 1, ts: 1 });

      await ensureCollection(db, 'engine_state');
      await ensureCollection(db, 'leases');
      await ensureCollection(db, 'alerts');
      await db.collection('alerts').createIndex({ ts: -1 });
    },
  },
  {
    version: 2,
    name: 'append-only role for ledgers (least privilege)',
    async up(db) {
      // Requires userAdmin on the database. In managed clusters (Atlas) create the equivalent
      // custom role in the UI; failure here is logged, not fatal.
      const privileges = [
        ...LEDGER_COLLECTIONS.map((c) => ({ resource: { db: db.databaseName, collection: c }, actions: ['find', 'insert'] })),
        ...['candles', 'chain_snapshots', 'regime_history', 'orders', 'positions', 'model_versions', 'equity_snapshots', 'engine_state', 'leases', 'alerts'].map(
          (c) => ({ resource: { db: db.databaseName, collection: c }, actions: ['find', 'insert', 'update'] }),
        ),
        { resource: { db: db.databaseName, collection: 'schema_migrations' }, actions: ['find'] },
      ];
      try {
        const existing = await db.command({ rolesInfo: 'engineAppendOnly' });
        if ((existing.roles as unknown[]).length) await db.command({ updateRole: 'engineAppendOnly', privileges, roles: [] });
        else await db.command({ createRole: 'engineAppendOnly', privileges, roles: [] });
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'Could not create engineAppendOnly role (needs userAdmin). Create it manually - see docs/DEPLOYMENT.md');
      }
    },
  },
  {
    version: 3,
    name: 'retention TTL for high-volume telemetry',
    async up(db) {
      // chain snapshots with full contracts are large; keep 90 days. Ledgers are never expired.
      await db.collection('chain_snapshots').createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
      await db.collection('regime_history').createIndex({ createdAt: 1 }, { expireAfterSeconds: 365 * 86400 });
    },
  },
];

export async function runMigrations(db: Db): Promise<number[]> {
  const coll = db.collection<{ _id: number; name: string; appliedAt: Date }>('schema_migrations');
  const applied = new Set((await coll.find({}).toArray()).map((m) => m._id));
  const ran: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    log.info({ version: m.version, name: m.name }, 'applying migration');
    await m.up(db);
    await coll.insertOne({ _id: m.version, name: m.name, appliedAt: new Date() });
    ran.push(m.version);
  }
  return ran;
}
