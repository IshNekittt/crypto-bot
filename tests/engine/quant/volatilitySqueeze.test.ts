import { Decimal } from 'decimal.js';
import { Candle } from '../../../src/types';
import { calculateVolatilitySqueeze } from '../../../src/engine/quant/volatilitySqueeze';

const TF_MS = 15 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);

function makeCandle(index: number, close: number, range = 0.1): Candle {
  return {
    timestamp: BASE + index * TF_MS,
    open: String(close),
    high: String(close + range),
    low: String(close - range),
    close: String(close),
    volume: '1',
  };
}

function flatCandles(count: number, price = 100): Candle[] {
  return Array.from({ length: count }, (_, index) => makeCandle(index, price));
}

describe('calculateVolatilitySqueeze', () => {
  it('uses BB(20, 2), ATR-based KC(20, 1.5), and identifies complete containment', () => {
    const points = calculateVolatilitySqueeze(flatCandles(25));
    const point = points[points.length - 1];

    expect(points).toHaveLength(6);
    expect(point.isSqueezed).toBe(true);
    expect(point.bollingerMiddle.eq(100)).toBe(true);
    expect(point.bollingerUpper.eq(100)).toBe(true);
    expect(point.keltnerUpper.gt(point.bollingerUpper)).toBe(true);
    expect(point.keltnerLower.lt(point.bollingerLower)).toBe(true);
    expect(point.atr.eq(new Decimal('0.2'))).toBe(true);
    expect(point.isFiring).toBe(false);
  });

  it('marks only the first expansion after at least five squeeze bars as firing', () => {
    const candles = [...flatCandles(25), makeCandle(25, 120, 0.1), makeCandle(26, 121, 0.1)];
    const points = calculateVolatilitySqueeze(candles);
    const firstExpansion = points.find((point) => point.timestamp === candles[25].timestamp)!;
    const nextPoint = points.find((point) => point.timestamp === candles[26].timestamp)!;

    expect(firstExpansion.isFiring).toBe(true);
    expect(firstExpansion.priorSqueezeCandles).toBeGreaterThanOrEqual(5);
    expect(firstExpansion.momentum.gt(0)).toBe(true);
    expect(nextPoint.isFiring).toBe(false);
  });

  it('reports negative regression momentum for a falling sequence', () => {
    const candles = [
      ...flatCandles(25),
      makeCandle(25, 80, 0.1),
    ];
    const point = calculateVolatilitySqueeze(candles).at(-1)!;
    expect(point.isFiring).toBe(true);
    expect(point.momentum.lt(0)).toBe(true);
  });

  it('rejects malformed periods and invalid OHLC ranges', () => {
    expect(() => calculateVolatilitySqueeze(flatCandles(25), 1)).toThrow(/period/);
    const malformed = flatCandles(20);
    malformed[10] = { ...malformed[10], high: '99', low: '101' };
    expect(() => calculateVolatilitySqueeze(malformed)).toThrow(/Invalid candle range/);
  });
});
