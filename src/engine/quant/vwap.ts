import { Decimal } from 'decimal.js';
import type { Candle } from '../../types';

export interface VwapResult {
  readonly vwap: Decimal;
  readonly upper1: Decimal;
  readonly lower1: Decimal;
  readonly upper2: Decimal;
  readonly lower2: Decimal;
  readonly upper3: Decimal;
  readonly lower3: Decimal;
  readonly zScore: Decimal;
  readonly stdDev: Decimal;
  readonly vwapSlope: Decimal;
  readonly isValid: boolean;
  readonly reason?: string;
}

export function calculateVwap(candles: readonly Candle[], lookback?: number): VwapResult {
  const invalid = (reason: string): VwapResult => ({
    vwap: new Decimal(0), upper1: new Decimal(0), lower1: new Decimal(0),
    upper2: new Decimal(0), lower2: new Decimal(0), upper3: new Decimal(0),
    lower3: new Decimal(0), zScore: new Decimal(0), stdDev: new Decimal(0),
    vwapSlope: new Decimal(0), isValid: false, reason,
  });

  const count = lookback ?? candles.length;
  if (!Number.isInteger(count) || count < 1) return invalid('lookback must be a positive integer');
  if (candles.length === 0) return invalid('empty candle input');

  const window = candles.slice(Math.max(0, candles.length - count));
  let volumeSum = new Decimal(0);
  let weightedPriceSum = new Decimal(0);
  const observations: Array<{ typical: Decimal; volume: Decimal }> = [];

  try {
    for (const candle of window) {
      const high = new Decimal(candle.high);
      const low = new Decimal(candle.low);
      const close = new Decimal(candle.close);
      const volume = new Decimal(candle.volume);
      if (!high.isFinite() || !low.isFinite() || !close.isFinite() || !volume.isFinite() ||
          volume.lt(0) || high.lt(low)) {
        return invalid('invalid or negative candle data');
      }
      const typical = high.plus(low).plus(close).div(3);
      weightedPriceSum = weightedPriceSum.plus(typical.mul(volume));
      volumeSum = volumeSum.plus(volume);
      observations.push({ typical, volume });
    }
  } catch {
    return invalid('invalid numeric candle data');
  }

  if (volumeSum.lte(0)) return invalid('total volume must be positive');

  const vwap = weightedPriceSum.div(volumeSum);
  const variance = observations.reduce((sum, item) =>
    sum.plus(item.volume.mul(item.typical.minus(vwap).pow(2))), new Decimal(0)).div(volumeSum);
  const stdDev = variance.sqrt();

  const priorWindow = observations.length > 1
    ? observations.slice(0, observations.length - 1)
    : observations;
  const priorVolume = priorWindow.reduce((sum, item) => sum.plus(item.volume), new Decimal(0));
  const priorVwap = priorVolume.gt(0)
    ? priorWindow.reduce((sum, item) => sum.plus(item.typical.mul(item.volume)), new Decimal(0)).div(priorVolume)
    : vwap;
  const vwapSlope = vwap.minus(priorVwap);
  const currentPrice = (() => {
    try { return new Decimal(window[window.length - 1].close); } catch { return new Decimal(0); }
  })();
  const zScore = stdDev.gt(0) ? currentPrice.minus(vwap).div(stdDev) : new Decimal(0);

  return {
    vwap,
    upper1: vwap.plus(stdDev), lower1: vwap.minus(stdDev),
    upper2: vwap.plus(stdDev.mul(2)), lower2: vwap.minus(stdDev.mul(2)),
    upper3: vwap.plus(stdDev.mul(3)), lower3: vwap.minus(stdDev.mul(3)),
    zScore, stdDev, vwapSlope, isValid: true,
  };
}
