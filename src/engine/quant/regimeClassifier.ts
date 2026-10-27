import { Decimal } from 'decimal.js';
import type { Candle } from '../../types';
import type { VwapResult } from './vwap';
import type { VolumeProfileResult } from './volumeProfile';

export type MarketRegime =
  | 'RANGING_MEAN_REVERSION'
  | 'TREND_EXPANSION_BULLISH'
  | 'TREND_EXPANSION_BEARISH'
  | 'VOLATILE_CHOP';

export interface MarketRegimeResult {
  readonly regime: MarketRegime;
  readonly bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  readonly confidence: Decimal;
  readonly keyLevel: Decimal;
  readonly isValid: boolean;
  readonly reason?: string;
}

const invalid = (reason: string): MarketRegimeResult => ({
  regime: 'VOLATILE_CHOP', bias: 'NEUTRAL', confidence: new Decimal(0),
  keyLevel: new Decimal(0), isValid: false, reason,
});

export function classifyMarketRegime(
  candles: readonly Candle[],
  vwap: VwapResult,
  profile: VolumeProfileResult,
  atr: Decimal,
): MarketRegimeResult {
  if (!candles.length) return invalid('empty candle input');
  if (!vwap.isValid) return invalid(vwap.reason ?? 'invalid VWAP input');
  if (!profile.isValid) return invalid(profile.reason ?? 'invalid volume profile input');
  if (!atr.isFinite() || atr.lte(0)) return invalid('ATR must be positive and finite');

  let close: Decimal;
  let volumeAverage: Decimal;
  let recentAverage: Decimal;
  try {
    close = new Decimal(candles[candles.length - 1].close);
    volumeAverage = candles.reduce((sum, candle) => sum.plus(new Decimal(candle.volume)), new Decimal(0))
      .div(candles.length);
    const recent = candles.slice(Math.max(0, candles.length - Math.min(5, candles.length)));
    recentAverage = recent.reduce((sum, candle) => sum.plus(new Decimal(candle.volume)), new Decimal(0))
      .div(recent.length);
  } catch {
    return invalid('invalid numeric candle data');
  }

  if (!close.isFinite() || volumeAverage.lte(0) || !recentAverage.isFinite()) {
    return invalid('invalid price or volume data');
  }

  const volumeAboveAverage = recentAverage.gt(volumeAverage);
  const flatSlope = vwap.vwapSlope.abs().lte(atr.div(10));
  const z = vwap.zScore;
  const insideValueArea = close.gte(profile.val) && close.lte(profile.vah);
  const keyLevel = profile.poc;

  if (insideValueArea && z.gte(-2) && z.lte(2) && flatSlope) {
    const confidence = Decimal.min(1, z.abs().div(2).mul(-1).plus(1).mul(flatSlope ? 1 : 0.5));
    return { regime: 'RANGING_MEAN_REVERSION', bias: 'NEUTRAL', confidence,
      keyLevel, isValid: true };
  }

  if (close.gt(profile.vah) && z.gt(1.5) && volumeAboveAverage && vwap.vwapSlope.gt(0)) {
    const confidence = Decimal.min(1, z.minus(1.5).div(1.5).plus(volumeAboveAverage ? 0.5 : 0));
    return { regime: 'TREND_EXPANSION_BULLISH', bias: 'BULLISH', confidence,
      keyLevel: profile.vah, isValid: true };
  }

  if (close.lt(profile.val) && z.lt(-1.5) && volumeAboveAverage && vwap.vwapSlope.lt(0)) {
    const confidence = Decimal.min(1, z.abs().minus(1.5).div(1.5).plus(volumeAboveAverage ? 0.5 : 0));
    return { regime: 'TREND_EXPANSION_BEARISH', bias: 'BEARISH', confidence,
      keyLevel: profile.val, isValid: true };
  }

  const brokeValueArea = close.gt(profile.vah) || close.lt(profile.val);
  const contracting = recentAverage.lte(volumeAverage);
  const lowConfidence = !volumeAboveAverage || contracting;
  const confidence = brokeValueArea || lowConfidence
    ? new Decimal(0.25)
    : new Decimal(0.35);
  return { regime: 'VOLATILE_CHOP', bias: 'NEUTRAL', confidence,
    keyLevel: profile.poc, isValid: true };
}
