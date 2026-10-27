import { Decimal } from 'decimal.js';
import type { Candle } from '../../../src/types';
import { calculateVwap } from '../../../src/engine/quant/vwap';

const candle = (close: string, volume: string, spread = '0'): Candle => {
  const price = new Decimal(close);
  const halfSpread = new Decimal(spread).div(2);
  return {
    timestamp: 0,
    open: close,
    high: price.plus(halfSpread).toString(),
    low: price.minus(halfSpread).toString(),
    close,
    volume,
  };
};

describe('calculateVwap', () => {
  it('calculates weighted VWAP, bands, z-score and positive slope', () => {
    const result = calculateVwap([
      candle('100', '1'), candle('110', '3'), candle('120', '1'),
    ]);

    expect(result.isValid).toBe(true);
    expect(result.vwap.toFixed(6)).toBe('110.000000');
    expect(result.lower1.lte(result.vwap)).toBe(true);
    expect(result.upper3.gt(result.upper2)).toBe(true);
    expect(result.vwapSlope.gt(0)).toBe(true);
    expect(result.zScore.gt(0)).toBe(true);
  });

  it('returns flat slope and zero standard deviation for equal-price candles', () => {
    const result = calculateVwap([candle('50', '2'), candle('50', '4'), candle('50', '1')]);

    expect(result.isValid).toBe(true);
    expect(result.vwap.toString()).toBe('50');
    expect(result.stdDev.toString()).toBe('0');
    expect(result.zScore.toString()).toBe('0');
    expect(result.vwapSlope.toString()).toBe('0');
  });

  it('uses only the requested lookback and does not mutate input', () => {
    const candles = Object.freeze([
      Object.freeze(candle('100', '1')),
      Object.freeze(candle('200', '1')),
      Object.freeze(candle('300', '1')),
    ]);
    const snapshot = JSON.stringify(candles);

    const result = calculateVwap(candles, 2);

    expect(result.isValid).toBe(true);
    expect(result.vwap.toString()).toBe('250');
    expect(result.vwapSlope.toString()).toBe('50');
    expect(JSON.stringify(candles)).toBe(snapshot);
  });

  it.each([
    { name: 'empty input', candles: [] as readonly Candle[], lookback: undefined },
    { name: 'invalid lookback', candles: [candle('100', '1')], lookback: 0 },
    { name: 'zero volume', candles: [candle('100', '0'), candle('101', '0')], lookback: undefined },
    { name: 'negative volume', candles: [candle('100', '-1')], lookback: undefined },
    { name: 'inverted range', candles: [{ ...candle('100', '1'), high: '99', low: '101' }], lookback: undefined },
    { name: 'non-finite price', candles: [candle('NaN', '1')], lookback: undefined },
  ])('fails closed for $name', ({ candles, lookback }) => {
    const result = calculateVwap(candles, lookback);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.vwap.isZero()).toBe(true);
  });
});
