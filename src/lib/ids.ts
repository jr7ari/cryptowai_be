import { createHash, randomUUID } from 'node:crypto';

export const uuid = () => randomUUID();

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON stringify (sorted keys) so hashes are reproducible. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/**
 * Deterministic client order id derived from the decision + leg. Re-submitting the same
 * intent after a crash produces the same id, so the exchange/our DB rejects duplicates.
 */
export function clientOrderId(decisionId: string, legIndex: number, purpose: 'open' | 'close' | 'adjust', attempt = 0): string {
  return `ch-${sha256(`${decisionId}:${legIndex}:${purpose}:${attempt}`).slice(0, 28)}`;
}
