/**
 * Change-point gate. Wraps the closed-bar CUSUM detector: this is a SUSPEND / recompute hint,
 * not a directional entry. False-alarm rate on Gaussian noise is measured in tests.
 */
import { cusumShift, type CusumResult } from '../signals/cusum.js';

export interface ChangePointDecision {
  active: boolean;
  shift: number;
  recomputeRegime: boolean;
  /** Mean-reversion sleeves must not fire through a detected level shift. */
  suspendMeanReversion: boolean;
  detail: string;
}

export function changePointDecision(closes: number[]): ChangePointDecision & { raw: CusumResult } {
  const raw = cusumShift(closes);
  const active = raw.shift !== 0;
  return {
    active,
    shift: raw.shift,
    recomputeRegime: active,
    suspendMeanReversion: active,
    detail: active ? `CUSUM ${raw.shift > 0 ? 'up' : 'down'} shift (sH=${raw.sHigh.toFixed(2)}, sL=${raw.sLow.toFixed(2)})` : 'no change-point',
    raw,
  };
}
