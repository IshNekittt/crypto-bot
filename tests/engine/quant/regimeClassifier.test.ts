import { Decimal } from 'decimal.js';
import type { Candle } from '../../../src/types';
import { classifyMarketRegime } from '../../../src/engine/quant/regimeClassifier';
import { calculateVwap } from '../../../src/engine/quant/vwap';
import { calculateVolumeProfile } from '../../../src/engine/quant/volumeProfile';

const candle = (close: string, volume = '1', high?: string, low?: string): Candle => ({
  timestamp: 0,
  open: close,
  high: high ?? close,
  low: low ?? close,
  close,
  volume,
});

const inputs = (candles: readonly Candle[]) => ({
  candles,
  vwap: calculateVwap(candles),
  profile: calculateVolumeProfile(candles),
});

describe('classifyMarketRegime', () => {
  it('classifies a flat market inside VWAP and value area as mean reversion', () => {
    const data = inputs(Array.from({ length: 12 }, () => candle(
      '100.5', '10', '100.6', '100.4')));

    const result = classifyMarketRegime(data.candles, data.vwap, data.profile, new Decimal('2'));

    expect(result.isValid).toBe(true);
    expect(result.regime).toBe('RANGING_MEAN_REVERSION');
    expect(result.bias).toBe('NEUTRAL');
    expect(result.confidence.gte(0)).toBe(true);
    expect(result.confidence.lte(1)).toBe(true);
  });

  it('classifies a bullish expansion outside the upper value area', () => {
    const candles = Array.from({ length: 12 }, (_, index) => candle(
      index === 11 ? '115' : '100', index > 8 ? '20' : '10'));
    const data = inputs(candles);

    const result = classifyMarketRegime(data.candles, data.vwap, data.profile, new Decimal('1'));

    expect(result.isValid).toBe(true);
    expect(result.regime).toBe('TREND_EXPANSION_BULLISH');
    expect(result.bias).toBe('BULLISH');
  });

  it('classifies a bearish expansion outside the lower value area', () => {
    const candles = Array.from({ length: 12 }, (_, index) => candle(
      index === 11 ? '85' : '100', index > 8 ? '20' : '10'));
    const data = inputs(candles);

    const result = classifyMarketRegime(data.candles, data.vwap, data.profile, new Decimal('1'));

    expect(result.isValid).toBe(true);
    expect(result.regime).toBe('TREND_EXPANSION_BEARISH');
    expect(result.bias).toBe('BEARISH');
  });

  it('fails closed for empty candles or degenerate ATR', () => {
    const data = inputs([candle('100', '1')]);

    expect(classifyMarketRegime([], data.vwap, data.profile, new Decimal(1)).isValid).toBe(false);
    expect(classifyMarketRegime(data.candles, data.vwap, data.profile, new Decimal(0)).isValid).toBe(false);
  });

  it('fails closed when VWAP or volume profile is invalid', () => {
    const candles = [candle('100', '1')];
    const data = inputs(candles);

    expect(classifyMarketRegime(candles, { ...data.vwap, isValid: false }, data.profile, new Decimal(1)).isValid)
      .toBe(false);
    expect(classifyMarketRegime(candles, data.vwap, { ...data.profile, isValid: false }, new Decimal(1)).isValid)
      .toBe(false);
  });

  it('is deterministic and does not mutate any input', () => {
    const candles = Object.freeze(Array.from({ length: 12 }, (_, index) =>
      Object.freeze(candle(String(100 + (index % 3)), '10'))));
    const data = inputs(candles);
    const snapshot = JSON.stringify(candles);

    const first = classifyMarketRegime(candles, data.vwap, data.profile, new Decimal('1'));
    const second = classifyMarketRegime(candles, data.vwap, data.profile, new Decimal('1'));

    expect(first).toEqual(second);
    expect(JSON.stringify(candles)).toBe(snapshot);
  });
});
