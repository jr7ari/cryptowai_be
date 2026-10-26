/**
 * Profit Guard: automatic, monotonic profit protection for every open position.
 *
 * Why this shape (and not "exit as soon as P&L > 0"):
 *  - Exiting at the first green tick cuts the right tail. Trend sleeves earn most of their money from a
 *    few large winners (Moskowitz-Ooi-Pedersen 2012; Zarattini-Pagani-Barbon 2025, "Catching Crypto
 *    Trends", which exits with a ratcheting Donchian midpoint stop rather than a fixed target).
 *  - Letting a large open profit round-trip into a loss is the other failure. So the guard ratchets a
 *    floor UP behind the peak and never lowers it.
 *  - Short-premium option structures are different: their upside is capped at the credit, and
 *    managing winners at ~50% of max profit raises win rate and P&L per day vs holding to expiry
 *    (tastylive "managing strangles" studies). Debit spreads with a cap are banked at ~75%.
 *
 * Units: all percentages are of the position's max loss (1R = 100%), the same unit as checkExit.
 */
import type { ExitPlan, ProfitGuardPlan } from '../domain/types.js';

export interface ProfitGuardLimits {
  profitGuardEnabled: boolean;
  breakevenAtPct: number;
  breakevenBufferPct: number;
  profitLockSteps: string;
  creditCapturePct: number;
  debitCapturePct: number;
}

/** Parse "100:0.4,200:0.55" into sorted [peakPct, lockFraction] pairs (invalid pairs dropped). */
export function parseLockSteps(s: string): Array<[number, number]> {
  return s
    .split(',')
    .map((p) => p.split(':').map((x) => Number(x.trim())) as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && b < 1)
    .sort((x, y) => x[0] - y[0]);
}

export type GuardStyle = 'DEFAULT' | 'TREND' | 'OPTION_CREDIT' | 'OPTION_DEBIT_CAPPED' | 'OPTION_DEBIT_OPEN';

/**
 * Build the guard for a position. Trend sleeves get a looser guard (later break-even, smaller lock
 * fractions) so the profit engine of trend-following - the fat right tail - is preserved.
 */
export function buildProfitGuard(l: ProfitGuardLimits, style: GuardStyle): ProfitGuardPlan | undefined {
  if (!l.profitGuardEnabled) return undefined;
  const steps = parseLockSteps(l.profitLockSteps);
  if (style === 'TREND') {
    return {
      breakevenAtPct: Math.max(l.breakevenAtPct, 100),
      breakevenBufferPct: l.breakevenBufferPct,
      lockSteps: steps.map(([a, b]) => [a * 1.5, Math.max(0.2, b - 0.15)]),
    };
  }
  if (style === 'OPTION_CREDIT') {
    return { breakevenAtPct: l.breakevenAtPct, breakevenBufferPct: l.breakevenBufferPct, lockSteps: steps, captureOfMaxProfitPct: l.creditCapturePct };
  }
  if (style === 'OPTION_DEBIT_CAPPED') {
    return { breakevenAtPct: l.breakevenAtPct, breakevenBufferPct: l.breakevenBufferPct, lockSteps: steps, captureOfMaxProfitPct: l.debitCapturePct };
  }
  // long options decay: protect a little later, then ratchet normally
  if (style === 'OPTION_DEBIT_OPEN') {
    return { breakevenAtPct: Math.max(l.breakevenAtPct, 60), breakevenBufferPct: l.breakevenBufferPct, lockSteps: steps };
  }
  return { breakevenAtPct: l.breakevenAtPct, breakevenBufferPct: l.breakevenBufferPct, lockSteps: steps };
}

/** Current protected floor in % of risk given the peak, or null while the guard is not armed. */
export function guardFloorPct(g: ProfitGuardPlan, peakPct: number): number | null {
  let floor: number | null = null;
  if (peakPct >= g.breakevenAtPct) floor = g.breakevenBufferPct;
  for (const [at, frac] of g.lockSteps) {
    if (peakPct >= at) floor = Math.max(floor ?? -Infinity, frac * peakPct);
  }
  return floor;
}

export interface GuardResult {
  exit: boolean;
  reason?: 'PROFIT_LOCK' | 'PROFIT_CAPTURE';
  detail?: string;
  /** ratcheted floor (never decreases); null = not armed yet */
  floorPct: number | null;
}

/**
 * Evaluate the guard. `prevFloorPct` is the floor stored on the position from earlier marks; the
 * returned floor is max(prev, new) so the protection only ever tightens.
 */
export function evaluateProfitGuard(
  plan: ExitPlan,
  pnlPct: number,
  peakPct: number,
  pnl: number,
  maxProfit: number | null,
  prevFloorPct?: number | null,
): GuardResult {
  const g = plan.profitGuard;
  if (!g) return { exit: false, floorPct: prevFloorPct ?? null };
  if (g.captureOfMaxProfitPct !== undefined && maxProfit !== null && maxProfit > 0) {
    const captured = (pnl / maxProfit) * 100;
    if (captured >= g.captureOfMaxProfitPct) {
      return { exit: true, reason: 'PROFIT_CAPTURE', detail: `captured ${captured.toFixed(0)}% of max profit (>= ${g.captureOfMaxProfitPct}%)`, floorPct: prevFloorPct ?? null };
    }
  }
  const fresh = guardFloorPct(g, peakPct);
  const floor = fresh === null ? prevFloorPct ?? null : Math.max(fresh, prevFloorPct ?? -Infinity);
  if (floor !== null && pnlPct <= floor) {
    return { exit: true, reason: 'PROFIT_LOCK', detail: `P&L ${pnlPct.toFixed(1)}% fell to locked floor ${floor.toFixed(1)}% (peak ${peakPct.toFixed(1)}%)`, floorPct: floor };
  }
  return { exit: false, floorPct: floor };
}
