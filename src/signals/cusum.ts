/**
 * Two-sided CUSUM change-point detector on CLOSED log returns only (no incomplete bar).
 * Thresholds use a trailing (past-only) sigma estimate. This is a detector, not a directional alpha.
 */
export interface CusumResult {
  /** +1 upward shift, -1 downward, 0 none */
  shift: number;
  sHigh: number;
  sLow: number;
}

export function cusumShift(closes: number[], lookback = 200, kMult = 0.5, hMult = 4): CusumResult {
  const n = closes.length;
  if (n < 30) return { shift: 0, sHigh: 0, sLow: 0 };
  const start = Math.max(1, n - lookback);
  const rets: number[] = [];
  for (let i = start; i < n; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return { shift: 0, sHigh: 0, sLow: 0 };
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length - 1);
  const sigma = Math.sqrt(Math.max(v, 1e-16));
  const k = kMult * sigma;
  const h = hMult * sigma;
  let sH = 0;
  let sL = 0;
  let shift = 0;
  for (const r of rets) {
    sH = Math.max(0, sH + r - m - k);
    sL = Math.max(0, sL - (r - m) - k);
    if (sH > h) shift = 1;
    if (sL > h) shift = -1;
  }
  return { shift, sHigh: sH / sigma, sLow: sL / sigma };
}
