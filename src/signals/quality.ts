/**
 * Feature availability / freshness. Missing exchange data is flagged, never invented.
 */
import type { DataQuality, FeatureVector } from '../domain/types.js';

export function assessDataQuality(fv: FeatureVector, dataAgeMs: number, staleMs: number, candleBars: number): DataQuality {
  const reasons: string[] = [];
  if (candleBars < 60) reasons.push(`only ${candleBars} closed bars (need 60)`);
  if (dataAgeMs > staleMs) reasons.push(`data age ${dataAgeMs}ms > stale ${staleMs}ms`);
  const flag = (k: string, label: string) => {
    if (!(fv[k] > 0)) reasons.push(`${label} unavailable`);
  };
  flag('fundingAvail', 'funding');
  flag('oiAvail', 'open interest');
  flag('ivAvail', 'implied vol');
  flag('cusumAvail', 'CUSUM');
  if (!(fv.bookImbalanceAvail > 0)) reasons.push('order-book imbalance unavailable (no live L2)');
  if (!(fv.ofiAvail > 0)) reasons.push('true OFI unavailable (no sequenced book tape)');
  if (!(fv.signedFlowAvail > 0)) reasons.push('signed trade flow unavailable (no live tape)');
  if (!(fv.basisAvail > 0)) reasons.push('mark-basis unavailable (last≈mark or no mark; cash-spot not in CoinDCX client)');
  if (!(fv.xsmomAvail > 0)) reasons.push('cross-sectional momentum unavailable (<2 peers)');
  if (!(fv.mrAvail > 0)) reasons.push('mean-reversion unavailable (not OU-like on closed bars)');
  const ok = candleBars >= 60 && dataAgeMs <= staleMs;
  return {
    ok,
    reasons,
    bookImbalanceAvail: fv.bookImbalanceAvail ?? 0,
    ofiAvail: fv.ofiAvail ?? 0,
    fundingAvail: fv.fundingAvail ?? 0,
    oiAvail: fv.oiAvail ?? 0,
    ivAvail: fv.ivAvail ?? 0,
    cusumAvail: fv.cusumAvail ?? 0,
    candleBars,
  };
}

export function featureDisagreements(fv: FeatureVector): string[] {
  const out: string[] = [];
  const s = (x: number | undefined) => Math.sign(x ?? 0);
  if (s(fv.emaAlign) && s(fv.supertrendDir) && s(fv.emaAlign) !== s(fv.supertrendDir)) out.push('EMA stack vs Supertrend');
  if (s(fv.emaAlign) && s(fv.htfAlign) && s(fv.emaAlign) !== s(fv.htfAlign)) out.push('decision-TF vs higher-TF alignment');
  if (s(fv.diDiff) && s(fv.emaAlign) && s(fv.diDiff) !== s(fv.emaAlign)) out.push('+DI/−DI vs EMA stack');
  if ((fv.adx ?? 0) > 25 && (fv.chop ?? 50) > 61.8) out.push('ADX trending vs high choppiness (correlated trend evidence disagrees)');
  if (s(fv.tsmom) && s(fv.emaAlign) && s(fv.tsmom) !== s(fv.emaAlign)) out.push('TSMOM vs EMA stack');
  if ((fv.trendSignAgreement ?? 1) < 0.75) out.push(`trend-sign agreement ${((fv.trendSignAgreement ?? 0) * 100).toFixed(0)}% — do not treat ADX/EMA/Supertrend as independent`);
  return out;
}
