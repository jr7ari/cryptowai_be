import { sha256, stableStringify } from '../lib/ids.js';
import type { LedgerMeta } from './ports.js';

export const GENESIS_HASH = '0'.repeat(64);

export function computeHash(prevHash: string, seq: number, payload: unknown): string {
  return sha256(`${prevHash}|${seq}|${stableStringify(payload)}`);
}

export function buildMeta(prevHash: string, seq: number, payload: unknown, now: number): LedgerMeta {
  return { seq, prevHash, hash: computeHash(prevHash, seq, payload), recordedAt: now };
}

/** Serialises async work per key (single-writer guarantee for hash chains within a process). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export function stripLedger<T>(doc: T & { _ledger?: LedgerMeta; _id?: unknown }): T {
  const { _ledger, _id, ...rest } = doc as Record<string, unknown>;
  void _ledger;
  void _id;
  return rest as T;
}

/** Verify a chain given records sorted by seq. */
export function verifyRecords<T>(records: Array<T & { _ledger: LedgerMeta }>): { ok: boolean; brokenAt: number | null; checked: number } {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const r of records) {
    const m = r._ledger;
    const payload = stripLedger(r as T & { _ledger: LedgerMeta });
    if (m.seq !== expectedSeq || m.prevHash !== prev || computeHash(prev, m.seq, payload) !== m.hash) {
      return { ok: false, brokenAt: m.seq, checked: expectedSeq - 1 };
    }
    prev = m.hash;
    expectedSeq++;
  }
  return { ok: true, brokenAt: null, checked: records.length };
}
