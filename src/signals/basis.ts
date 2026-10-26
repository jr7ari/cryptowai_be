/**
 * Perpetual basis + funding carry. CoinDCX's documented public feed gives last (`ls`) and mark (`mp`),
 * not a cash-spot index. Basis here is ln(last/mark) — a venue mark-basis, NOT ln(perp/spot).
 * When last and mark are identical (backtests that reuse close as mark) the feature is unavailable.
 *
 * Funding collected is not guaranteed P&L: adverse move + fees can dominate.
 */
import { clamp, percentileRank } from '../lib/math.js';

export interface BasisInput {
  last?: number;
  mark?: number;
  fundingRate?: number;
  fundingIntervalHours?: number;
  /** Past-only mark-basis samples (no current value if you want a strict lag; current is included for percentile rank of "now"). */
  basisHistory?: number[];
  fundingHistory?: number[];
}

export interface BasisFeatures {
  basisAvail: number;
  /** ln(last/mark). Positive = perp last rich vs mark. */
  basis: number;
  basisPctile: number;
  fundingAvail: number;
  fundingAnnual: number;
  fundingPctile: number;
  /**
   * Positive favours SHORT (collect positive funding / fade rich perp).
   * Negative favours LONG. Bounded; not a return forecast.
   */
  carryScore: number;
}

const empty: BasisFeatures = {
  basisAvail: 0,
  basis: 0,
  basisPctile: 0.5,
  fundingAvail: 0,
  fundingAnnual: 0,
  fundingPctile: 0.5,
  carryScore: 0,
};

export function basisFeatures(inp: BasisInput): BasisFeatures {
  const out = { ...empty };
  const last = inp.last;
  const mark = inp.mark;
  if (last && mark && last > 0 && mark > 0 && Math.abs(Math.log(last / mark)) > 1e-8) {
    out.basisAvail = 1;
    out.basis = Math.log(last / mark);
    const hist = (inp.basisHistory ?? []).filter(Number.isFinite);
    out.basisPctile = hist.length >= 20 ? percentileRank(hist, out.basis) : 0.5;
  }
  if (inp.fundingRate !== undefined && Number.isFinite(inp.fundingRate)) {
    out.fundingAvail = 1;
    const hours = inp.fundingIntervalHours ?? 8;
    out.fundingAnnual = inp.fundingRate * (24 / hours) * 365;
    const fh = (inp.fundingHistory ?? []).filter(Number.isFinite);
    out.fundingPctile = fh.length >= 20 ? percentileRank(fh, inp.fundingRate) : 0.5;
  }
  if (!out.basisAvail && !out.fundingAvail) return out;
  const fundPart = out.fundingAvail ? Math.tanh(out.fundingAnnual / 0.5) : 0;
  const basisPart = out.basisAvail ? Math.tanh(out.basis * 200) : 0;
  out.carryScore = clamp(0.7 * fundPart + 0.3 * basisPart, -1, 1);
  return out;
}
