import { Decimal } from 'decimal.js';

import { calculateADX, ADX_DEFAULT_PERIOD } from '../../../src/engine/quant/adx';
import type { Candle } from '../../../src/types';

function candle(
  timestamp: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return {
    timestamp,
    open: String(close),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: '1',
  };
}

/**
 * A monotonic ramp with a constant 1.5 true range and a constant 1.0 directional
 * move. Every DX value is exactly 100, so ADX must be exactly 100 regardless of
 * the smoothing length — an independent closed-form expectation, not a
 * re-implementation of the algorithm under test.
 */
function monotonicRamp(direction: 1 | -1, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + direction * index;
    return candle(index * 14_400_000, base + 0.5, base - 0.5, base);
  });
}

/** Alternating ±1 expansion around a flat close: +DM and -DM cancel, so DX ≈ 0. */
function alternatingChop(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const spike = index % 2;
    return candle(index * 14_400_000, 100 + spike, 100 - spike, 100);
  });
}

describe('calculateADX', () => {
  it('returns null below 2 × period candles', () => {
    const period = ADX_DEFAULT_PERIOD;
    expect(calculateADX(monotonicRamp(1, period * 2 - 1), period)).toBeNull();
    expect(calculateADX([], period)).toBeNull();
  });

  it('produces a value at exactly 2 × period candles', () => {
    const period = ADX_DEFAULT_PERIOD;
    const adx = calculateADX(monotonicRamp(1, period * 2), period);
    expect(adx).not.toBeNull();
    expect(adx!.isFinite()).toBe(true);
  });

  it('is exactly 100 on a monotonic uptrend', () => {
    const adx = calculateADX(monotonicRamp(1, 60));
    expect(adx).not.toBeNull();
    expect(adx!.toFixed(8)).toBe(new Decimal(100).toFixed(8));
  });

  it('is exactly 100 on a monotonic downtrend', () => {
    const adx = calculateADX(monotonicRamp(-1, 60));
    expect(adx).not.toBeNull();
    expect(adx!.toFixed(8)).toBe(new Decimal(100).toFixed(8));
  });

  it('collapses to 0 on a perfectly flat series (zero true range)', () => {
    const flat = Array.from({ length: 60 }, (_, index) =>
      candle(index * 14_400_000, 100, 100, 100),
    );
    const adx = calculateADX(flat);
    expect(adx).not.toBeNull();
    expect(adx!.isZero()).toBe(true);
  });

  it('stays below the 25 trend threshold on alternating chop', () => {
    const adx = calculateADX(alternatingChop(60));
    expect(adx).not.toBeNull();
    expect(adx!.lt(25)).toBe(true);
  });

  it('separates trend from range on the same period', () => {
    const trend = calculateADX(monotonicRamp(1, 60))!;
    const range = calculateADX(alternatingChop(60))!;
    expect(trend.gte(25)).toBe(true);
    expect(range.lt(25)).toBe(true);
  });

  it('never exceeds the 0..100 bounds', () => {
    for (const series of [
      monotonicRamp(1, 80),
      monotonicRamp(-1, 80),
      alternatingChop(80),
    ]) {
      const adx = calculateADX(series)!;
      expect(adx.gte(0)).toBe(true);
      expect(adx.lte(100)).toBe(true);
    }
  });

  it('rejects an invalid period', () => {
    expect(() => calculateADX(monotonicRamp(1, 60), 1)).toThrow(
      /period must be an integer >= 2/,
    );
    expect(() => calculateADX(monotonicRamp(1, 60), 2.5)).toThrow(
      /period must be an integer >= 2/,
    );
  });

  it('rejects malformed candles instead of fabricating a regime', () => {
    const broken = monotonicRamp(1, 40);
    broken[5] = { ...broken[5], high: '90', low: '100' };
    expect(() => calculateADX(broken)).toThrow(/Invalid candle range at index 5/);
  });
});
