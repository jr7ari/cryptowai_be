import type {
  Repositories,
  LedgerRepo,
  Ledgered,
  Page,
  OrderRepo,
  PositionRepo,
  ModelRepo,
  ModelVersionDoc,
  EquitySnapshot,
  AlertRecord,
} from './ports.js';
import { DuplicateOrderError } from './ports.js';
import { GENESIS_HASH, buildMeta, KeyedMutex, verifyRecords } from './ledger.js';
import type { Candle, Timeframe, OptionChainSnapshot, RegimeClassification, OrderState, Position, Mode } from '../domain/types.js';
import { TERMINAL_ORDER_STATUSES } from '../domain/types.js';

const clone = <T>(v: T): T => structuredClone(v);

function matches(doc: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => {
    const val = k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], doc);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const op = v as Record<string, unknown>;
      if ('$gte' in op && !((val as number) >= (op.$gte as number))) return false;
      if ('$lt' in op && !((val as number) < (op.$lt as number))) return false;
      if ('$in' in op && !(op.$in as unknown[]).includes(val)) return false;
      return true;
    }
    return val === v;
  });
}

class MemoryLedger<T extends object> implements LedgerRepo<T> {
  private rows: Ledgered<T>[] = [];
  private mutex = new KeyedMutex();
  constructor(private readonly tsField: string = 'ts') {}
  append(rec: T): Promise<Ledgered<T>> {
    return this.mutex.run('l', async () => {
      const prev = this.rows.length ? this.rows[this.rows.length - 1]._ledger.hash : GENESIS_HASH;
      const payload = JSON.parse(JSON.stringify(rec)) as T;
      const meta = buildMeta(prev, this.rows.length + 1, payload, Date.now());
      const row = Object.freeze({ ...payload, _ledger: meta }) as Ledgered<T>;
      this.rows.push(row);
      return clone(row);
    });
  }
  async list(filter?: Record<string, unknown>, page?: Page): Promise<Ledgered<T>[]> {
    let r = this.rows.filter((x) => matches(x as Record<string, unknown>, filter));
    if (page?.before) r = r.filter((x) => ((x as Record<string, unknown>)[this.tsField] as number) < page.before!);
    r = [...r].reverse();
    if (page?.limit) r = r.slice(0, page.limit);
    return clone(r);
  }
  async count(filter?: Record<string, unknown>) {
    return this.rows.filter((x) => matches(x as Record<string, unknown>, filter)).length;
  }
  async verifyChain() {
    return verifyRecords<T>(this.rows);
  }
  /** test-only: simulate tampering */
  _tamper(i: number, patch: Partial<T>) {
    this.rows[i] = { ...this.rows[i], ...patch };
  }
}

export function createMemoryRepositories(): Repositories {
  const candles = new Map<string, Map<number, Candle>>();
  const chains: OptionChainSnapshot[] = [];
  const regimes: RegimeClassification[] = [];
  const orders = new Map<string, { o: OrderState; mode: Mode }>();
  const positions = new Map<string, Position>();
  const models = new Map<string, ModelVersionDoc>();
  const equity: EquitySnapshot[] = [];
  const state = new Map<string, unknown>();
  const alerts: AlertRecord[] = [];
  const leases = new Map<string, { owner: string; until: number }>();

  const orderRepo: OrderRepo = {
    async create(o, mode) {
      if (orders.has(o.request.clientOrderId)) throw new DuplicateOrderError(o.request.clientOrderId);
      orders.set(o.request.clientOrderId, { o: clone(o), mode });
    },
    async update(o, mode) {
      orders.set(o.request.clientOrderId, { o: clone(o), mode });
    },
    async get(id) {
      const r = orders.get(id);
      return r ? clone(r.o) : null;
    },
    async listOpen(mode) {
      return [...orders.values()].filter((r) => r.mode === mode && !TERMINAL_ORDER_STATUSES.includes(r.o.status)).map((r) => clone(r.o));
    },
    async listByPosition(pid) {
      return [...orders.values()].filter((r) => r.o.request.positionId === pid).map((r) => clone(r.o));
    },
    async recent(mode, page) {
      const r = [...orders.values()]
        .filter((x) => !mode || x.mode === mode)
        .map((x) => x.o)
        .sort((a, b) => b.createdAt - a.createdAt);
      return clone(r.slice(0, page?.limit ?? 100));
    },
  };

  const positionRepo: PositionRepo = {
    async upsert(p) {
      positions.set(p.id, clone(p));
    },
    async get(id) {
      const p = positions.get(id);
      return p ? clone(p) : null;
    },
    async listOpen(mode) {
      return [...positions.values()].filter((p) => p.mode === mode && ['OPENING', 'OPEN', 'CLOSING'].includes(p.status)).map(clone);
    },
    async list(mode, page) {
      return [...positions.values()]
        .filter((p) => !mode || p.mode === mode)
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, page?.limit ?? 200)
        .map(clone);
    },
  };

  const modelRepo: ModelRepo = {
    async insert(m) {
      if (models.has(m.version)) throw new Error(`model ${m.version} exists`);
      models.set(m.version, clone(m));
    },
    async get(v) {
      const m = models.get(v);
      return m ? clone(m) : null;
    },
    async update(v, patch) {
      const m = models.get(v);
      if (!m) throw new Error(`model ${v} not found`);
      models.set(v, { ...m, ...clone(patch) });
    },
    async list() {
      return [...models.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone);
    },
    async activeFor(mode) {
      const m = [...models.values()].find((x) => (mode === 'LIVE' ? x.activeInLive : x.activeInPaper));
      return m ? clone(m) : null;
    },
  };

  return {
    candles: {
      async upsertMany(symbol: string, tf: Timeframe, cs: Candle[]) {
        const k = `${symbol}|${tf}`;
        if (!candles.has(k)) candles.set(k, new Map());
        const m = candles.get(k)!;
        for (const c of cs) m.set(c.t, { ...c });
        return cs.length;
      },
      async range(symbol, tf, from, to) {
        const m = candles.get(`${symbol}|${tf}`);
        if (!m) return [];
        return [...m.values()].filter((c) => c.t >= from && c.t <= to).sort((a, b) => a.t - b.t);
      },
      async latest(symbol, tf, limit) {
        const m = candles.get(`${symbol}|${tf}`);
        if (!m) return [];
        return [...m.values()].sort((a, b) => a.t - b.t).slice(-limit);
      },
    },
    chains: {
      async insert(s) {
        chains.push(clone(s));
        if (chains.length > 5000) chains.splice(0, chains.length - 5000);
      },
      async latest(u) {
        for (let i = chains.length - 1; i >= 0; i--) if (chains[i].underlying === u) return clone(chains[i]);
        return null;
      },
      async range(u, from, to) {
        return chains.filter((c) => c.underlying === u && c.ts >= from && c.ts <= to).sort((a, b) => a.ts - b.ts).map(clone);
      },
      async metricsHistory(u, from) {
        return chains
          .filter((c) => c.underlying === u && c.ts >= from)
          .map((c) => ({ ts: c.ts, spot: c.spot, atmIv: c.metrics.atmIv, pcrOpenInterest: c.metrics.pcrOpenInterest }));
      },
    },
    regimes: {
      async insert(r) {
        regimes.push(clone(r));
        if (regimes.length > 20000) regimes.splice(0, regimes.length - 20000);
      },
      async history(symbol, page) {
        return regimes
          .filter((r) => r.symbol === symbol && (!page?.before || r.ts < page.before))
          .reverse()
          .slice(0, page?.limit ?? 200)
          .map(clone);
      },
    },
    decisions: new MemoryLedger(),
    outcomes: new MemoryLedger(),
    orderEvents: new MemoryLedger(),
    fills: new MemoryLedger(),
    trades: new MemoryLedger('closedAt'),
    experiments: new MemoryLedger(),
    audit: new MemoryLedger(),
    orders: orderRepo,
    positions: positionRepo,
    models: modelRepo,
    equity: {
      async insert(s) {
        equity.push({ ...s });
      },
      async series(mode, from) {
        return equity.filter((e) => e.mode === mode && e.ts >= from);
      },
    },
    state: {
      async get<T>(k: string) {
        return state.has(k) ? (clone(state.get(k)) as T) : undefined;
      },
      async set<T>(k: string, v: T) {
        state.set(k, clone(v));
      },
      async acquireLease(name, owner, ttl, now) {
        const l = leases.get(name);
        if (!l || l.owner === owner || l.until < now) {
          leases.set(name, { owner, until: now + ttl });
          return true;
        }
        return false;
      },
      async releaseLease(name, owner) {
        if (leases.get(name)?.owner === owner) leases.delete(name);
      },
    },
    alerts: {
      async insert(a) {
        alerts.push({ ...a });
      },
      async recent(page) {
        return [...alerts].reverse().slice(0, page?.limit ?? 100);
      },
      async acknowledge(id) {
        const a = alerts.find((x) => x.id === id);
        if (a) a.acknowledged = true;
      },
    },
    async ping() {
      return true;
    },
    async withTransaction(fn) {
      return fn();
    },
    async close() {},
  };
}
