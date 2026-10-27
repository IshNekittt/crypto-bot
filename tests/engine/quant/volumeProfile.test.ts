import { Decimal } from 'decimal.js';
import type { Candle } from '../../../src/types';
import { calculateVolumeProfile } from '../../../src/engine/quant/volumeProfile';

const candle = (
  low: string,
  high: string,
  close: string,
  volume: string,
  timestamp = 0,
): Candle => ({ timestamp, open: close, high, low, close, volume });

describe('calculateVolumeProfile', () => {
  it('returns POC and a value area containing the configured volume share', () => {
    const result = calculateVolumeProfile([
      candle('99', '101', '100', '10'),
      candle('99', '101', '100', '10'),
      candle('101', '103', '102', '4'),
      candle('97', '99', '98', '1'),
    ], 10, new Decimal('0.70'));

    expect(result.isValid).toBe(true);
    expect(result.poc.gte(99)).toBe(true);
    expect(result.poc.lte(101)).toBe(true);
    expect(result.val.lt(result.poc)).toBe(true);
    expect(result.vah.gt(result.poc)).toBe(true);
    expect(result.valueAreaVolume.gte(result.totalVolume.mul('0.70'))).toBe(true);
  });

  it('handles zero-volume candles and includes only positive-volume range', () => {
    const result = calculateVolumeProfile([
      candle('90', '95', '92', '0'),
      candle('100', '110', '105', '3'),
      candle('100', '110', '105', '3'),
    ], 10);

    expect(result.isValid).toBe(true);
    expect(result.totalVolume.toString()).toBe('6');
    expect(result.poc.gte(100)).toBe(true);
  });

  it('does not mutate candles and ignores candles outside the 96-bar window', () => {
    const candles = Object.freeze(Array.from({ length: 97 }, (_, index) =>
      Object.freeze(candle('99', '101', '100', index === 0 ? '1000' : '1', index))));
    const snapshot = JSON.stringify(candles);

    const result = calculateVolumeProfile(candles, 5);

    expect(result.isValid).toBe(true);
    expect(result.totalVolume.toString()).toBe('96');
    expect(JSON.stringify(candles)).toBe(snapshot);
  });

  it.each([
    { name: 'empty input', candles: [] as readonly Candle[], bins: 10 },
    { name: 'zero bins', candles: [candle('99', '101', '100', '1')], bins: 0 },
    { name: 'fractional bins', candles: [candle('99', '101', '100', '1')], bins: 2.5 },
    { name: 'zero total volume', candles: [candle('99', '101', '100', '0')], bins: 10 },
    { name: 'zero price range', candles: [candle('100', '100', '100', '1')], bins: 10 },
    { name: 'negative volume', candles: [candle('99', '101', '100', '-1')], bins: 10 },
  ])('fails closed for $name', ({ candles, bins }) => {
    const result = calculateVolumeProfile(candles, bins);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.totalVolume.isZero()).toBe(true);
  });

  it('rejects invalid value-area ratios', () => {
    expect(calculateVolumeProfile([candle('99', '101', '100', '1')], 10, new Decimal(0)).isValid).toBe(false);
    expect(calculateVolumeProfile([candle('99', '101', '100', '1')], 10, new Decimal(1.1)).isValid).toBe(false);
  });
});
