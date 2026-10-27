import { Decimal } from 'decimal.js';
import type { Candle } from '../../types';

export interface VolumeProfileResult {
  readonly poc: Decimal;
  readonly vah: Decimal;
  readonly val: Decimal;
  readonly totalVolume: Decimal;
  readonly valueAreaVolume: Decimal;
  readonly isValid: boolean;
  readonly reason?: string;
}

export interface VolumeBin {
  readonly index: number;
  readonly lower: Decimal;
  readonly upper: Decimal;
  readonly volume: Decimal;
}

export function calculateVolumeProfile(
  candles: readonly Candle[],
  binsCount: number = 50,
  valueAreaRatio: Decimal = new Decimal('0.70'),
): VolumeProfileResult {
  const invalid = (reason: string): VolumeProfileResult => ({
    poc: new Decimal(0), vah: new Decimal(0), val: new Decimal(0),
    totalVolume: new Decimal(0), valueAreaVolume: new Decimal(0), isValid: false, reason,
  });

  if (candles.length === 0) return invalid('empty candle input');
  if (!Number.isInteger(binsCount) || binsCount < 1) return invalid('binsCount must be a positive integer');
  if (!valueAreaRatio.isFinite() || valueAreaRatio.lte(0) || valueAreaRatio.gt(1)) {
    return invalid('valueAreaRatio must be in (0, 1]');
  }

  const window = candles.slice(Math.max(0, candles.length - 96));
  let low = new Decimal(Infinity);
  let high = new Decimal(-Infinity);
  const parsed: Array<{ low: Decimal; high: Decimal; close: Decimal; volume: Decimal }> = [];
  let totalVolume = new Decimal(0);

  try {
    for (const candle of window) {
      const candleLow = new Decimal(candle.low);
      const candleHigh = new Decimal(candle.high);
      const close = new Decimal(candle.close);
      const volume = new Decimal(candle.volume);
      if (![candleLow, candleHigh, close, volume].every((value) => value.isFinite()) ||
          candleHigh.lt(candleLow) || volume.lt(0)) {
        return invalid('invalid or negative candle data');
      }
      low = Decimal.min(low, candleLow);
      high = Decimal.max(high, candleHigh);
      totalVolume = totalVolume.plus(volume);
      parsed.push({ low: candleLow, high: candleHigh, close, volume });
    }
  } catch {
    return invalid('invalid numeric candle data');
  }

  if (totalVolume.lte(0)) return invalid('total volume must be positive');
  if (high.lte(low)) return invalid('price range must be positive');

  const range = high.minus(low);
  const binWidth = range.div(binsCount);
  const bins: VolumeBin[] = Array.from({ length: binsCount }, (_, index) => {
    const lower = low.plus(binWidth.mul(index));
    return { index, lower, upper: index === binsCount - 1 ? high : lower.plus(binWidth), volume: new Decimal(0) };
  });

  const mutableVolumes = bins.map((bin) => bin.volume);
  for (const candle of parsed) {
    const midpoint = candle.low.plus(candle.high).div(2);
    if (candle.volume.eq(0)) continue;
    if (candle.high.eq(candle.low)) {
      const index = Decimal.min(binsCount - 1, Decimal.max(0, midpoint.minus(low).div(binWidth).floor())).toNumber();
      mutableVolumes[index] = mutableVolumes[index].plus(candle.volume);
      continue;
    }

    let assigned = new Decimal(0);
    for (let index = 0; index < bins.length; index++) {
      const bin = bins[index];
      const overlap = Decimal.min(candle.high, bin.upper).minus(Decimal.max(candle.low, bin.lower));
      if (overlap.lte(0)) continue;
      const fraction = overlap.div(candle.high.minus(candle.low));
      let amount = candle.volume.mul(fraction);
      if (index === bins.length - 1) amount = candle.volume.minus(assigned);
      mutableVolumes[index] = mutableVolumes[index].plus(amount);
      assigned = assigned.plus(amount);
    }
  }

  let pocIndex = 0;
  mutableVolumes.forEach((volume, index) => {
    if (volume.gt(mutableVolumes[pocIndex])) pocIndex = index;
  });

  let left = pocIndex;
  let right = pocIndex;
  let valueAreaVolume = mutableVolumes[pocIndex];
  const targetVolume = totalVolume.mul(valueAreaRatio);
  while (valueAreaVolume.lt(targetVolume) && (left > 0 || right < bins.length - 1)) {
    const leftVolume = left > 0 ? mutableVolumes[left - 1] : new Decimal(-1);
    const rightVolume = right < bins.length - 1 ? mutableVolumes[right + 1] : new Decimal(-1);
    if (rightVolume.gt(leftVolume)) right++;
    else left--;
    valueAreaVolume = valueAreaVolume.plus(rightVolume.gt(leftVolume) ? rightVolume : leftVolume);
  }

  return {
    poc: bins[pocIndex].lower.plus(bins[pocIndex].upper).div(2),
    vah: bins[right].upper,
    val: bins[left].lower,
    totalVolume,
    valueAreaVolume,
    isValid: true,
  };
}
