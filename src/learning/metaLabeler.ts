/**
 * Triple-barrier labels + optional logistic filter. The filter may SKIP a candidate; it cannot
 * loosen hard risk, size up, or enable LIVE. Labels use only prices AFTER the decision index.
 * Unfitted model → score is undefined (selector does not filter).
 */
import { clamp, sigmoid } from '../lib/math.js';

export type BarrierReason = 'TP' | 'SL' | 'TIME' | 'INCOMPLETE';

export function tripleBarrierAt(
  closes: number[],
  i: number,
  side: 1 | -1,
  tpPct: number,
  slPct: number,
  horizon: number,
): { label: 0 | 1 | null; reason: BarrierReason } {
  if (i < 0 || i >= closes.length) return { label: null, reason: 'INCOMPLETE' };
  const entry = closes[i];
  if (!(entry > 0)) return { label: null, reason: 'INCOMPLETE' };
  const last = Math.min(closes.length - 1, i + horizon);
  if (last <= i) return { label: null, reason: 'INCOMPLETE' };
  for (let j = i + 1; j <= last; j++) {
    const r = side * (closes[j] / entry - 1) * 100;
    if (r >= tpPct) return { label: 1, reason: 'TP' };
    if (r <= -slPct) return { label: 0, reason: 'SL' };
  }
  if (last < i + horizon) return { label: null, reason: 'INCOMPLETE' };
  const terminal = side * (closes[last] / entry - 1) * 100;
  return { label: terminal > 0 ? 1 : 0, reason: 'TIME' };
}

export interface MetaModel {
  /** Length includes intercept at index 0. */
  weights: number[];
  fittedAt: number;
  nTrain: number;
  hitRate: number;
}

export function scoreMeta(model: MetaModel | null | undefined, x: number[]): number | undefined {
  if (!model || model.nTrain < 30 || model.weights.length !== x.length + 1) return undefined;
  let z = model.weights[0];
  for (let i = 0; i < x.length; i++) z += model.weights[i + 1] * (Number.isFinite(x[i]) ? x[i] : 0);
  return clamp(sigmoid(z), 1e-6, 1 - 1e-6);
}

/** Chronological fit: first `trainFrac` of labelled rows only. */
export function fitLogit(rows: Array<{ x: number[]; y: 0 | 1 }>, trainFrac = 0.7, steps = 400, lr = 0.08): MetaModel | null {
  if (rows.length < 40) return null;
  const cut = Math.max(30, Math.floor(rows.length * trainFrac));
  const train = rows.slice(0, cut);
  const dim = train[0].x.length;
  const w = new Array(dim + 1).fill(0);
  for (let s = 0; s < steps; s++) {
    const g = new Array(dim + 1).fill(0);
    for (const r of train) {
      let z = w[0];
      for (let i = 0; i < dim; i++) z += w[i + 1] * r.x[i];
      const p = sigmoid(z);
      const e = p - r.y;
      g[0] += e;
      for (let i = 0; i < dim; i++) g[i + 1] += e * r.x[i];
    }
    const n = train.length;
    for (let i = 0; i < w.length; i++) w[i] -= (lr * g[i]) / n;
  }
  let hits = 0;
  for (const r of train) {
    let z = w[0];
    for (let i = 0; i < dim; i++) z += w[i + 1] * r.x[i];
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === r.y) hits++;
  }
  return { weights: w, fittedAt: cut, nTrain: train.length, hitRate: hits / train.length };
}

/** Feature vector used by the selector filter. Keep this list stable (versioned). */
export function metaFeatures(fv: Record<string, number>): number[] {
  return [
    fv.regimeConf ?? 0,
    fv.tsmom ?? 0,
    fv.tsmomAgreement ?? 0,
    fv.carryScore ?? 0,
    fv.signedFlow ?? 0,
    fv.xsmomRank ?? 0.5,
    fv.zScore ?? 0,
    fv.spreadPct ?? 0,
    fv.forecastVol ?? 0,
    fv.changePointShift ?? fv.cusumShift ?? 0,
  ];
}
