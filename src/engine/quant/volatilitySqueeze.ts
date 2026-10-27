import { Decimal } from 'decimal.js';
import { Candle } from '../../types';

const ZERO = new Decimal(0);
const DEFAULT_PERIOD = 20;
const DEFAULT_BB_MULTIPLIER = new Decimal(2);
const DEFAULT_ATR_MULTIPLIER = new Decimal('1.5');
const MIN_SQUEEZE_CANDLES = 5;

export interface VolatilitySqueezePoint {
  readonly timestamp: number;
  readonly bollingerUpper: Decimal;
  readonly bollingerMiddle: Decimal;
  readonly bollingerLower: Decimal;
  readonly keltnerUpper: Decimal;
  readonly keltnerMiddle: Decimal;
  readonly keltnerLower: Decimal;
  readonly atr: Decimal;
  /** Change in the rolling linear-regression endpoint, in price units per bar. */
  readonly momentum: Decimal;
  readonly isSqueezed: boolean;
  /** True only on the first non-squeeze candle after the required squeeze run. */
  readonly isFiring: boolean;
  /** Consecutive squeeze candles immediately preceding this candle. */
  readonly priorSqueezeCandles: number;
}

function mean(values: readonly Decimal[]): Decimal {
  if (values.length === 0) return ZERO;
  return values.reduce((sum, value) => sum.plus(value), ZERO).div(values.length);
}

function linearRegressionSlope(values: readonly Decimal[]): Decimal {
  const count = values.length;
  if (count < 2) return ZERO;

  let sumX = ZERO;
  let sumY = ZERO;
  let sumXY = ZERO;
  let sumXX = ZERO;
  for (let index = 0; index < count; index++) {
    const x = new Decimal(index);
    sumX = sumX.plus(x);
    sumY = sumY.plus(values[index]);
    sumXY = sumXY.plus(x.mul(values[index]));
    sumXX = sumXX.plus(x.mul(x));
  }

  const denominator = new Decimal(count).mul(sumXX).minus(sumX.mul(sumX));
  if (denominator.isZero()) return ZERO;
  return new Decimal(count).mul(sumXY).minus(sumX.mul(sumY)).div(denominator);
}

/**
 * Calculate causal Bollinger/Keltner squeeze snapshots for closed candles.
 * Bollinger deviation uses population variance; Keltner midline is SMA(close)
 * and its width is 1.5 × SMA(True Range). No future candle is read.
 */
export function calculateVolatilitySqueeze(
  candles: readonly Candle[],
  period = DEFAULT_PERIOD,
  bbMultiplier = DEFAULT_BB_MULTIPLIER,
  atrMultiplier = DEFAULT_ATR_MULTIPLIER,
  minSqueezeCandles = MIN_SQUEEZE_CANDLES,
): VolatilitySqueezePoint[] {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error(`period must be an integer >= 2, got ${period}`);
  }
  if (!Number.isInteger(minSqueezeCandles) || minSqueezeCandles < 1) {
    throw new Error(`minSqueezeCandles must be an integer >= 1, got ${minSqueezeCandles}`);
  }
  if (!bbMultiplier.isFinite() || bbMultiplier.lt(0)) {
    throw new Error(`bbMultiplier must be finite and >= 0, got ${bbMultiplier.toString()}`);
  }
  if (!atrMultiplier.isFinite() || atrMultiplier.lt(0)) {
    throw new Error(`atrMultiplier must be finite and >= 0, got ${atrMultiplier.toString()}`);
  }

  const closes = candles.map((candle) => new Decimal(candle.close));
  const trueRanges = candles.map((candle, index) => {
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    if (!high.isFinite() || !low.isFinite() || high.lt(low)) {
      throw new Error(`Invalid candle range at index ${index}`);
    }
    if (index === 0) return high.minus(low);
    const previousClose = closes[index - 1];
    return Decimal.max(
      high.minus(low),
      high.minus(previousClose).abs(),
      low.minus(previousClose).abs(),
    );
  });

  const snapshots: VolatilitySqueezePoint[] = [];
  let consecutiveSqueezeCandles = 0;

  for (let index = 0; index < candles.length; index++) {
    if (index + 1 < period) continue;

    const windowStart = index - period + 1;
    const closeWindow = closes.slice(windowStart, index + 1);
    const trWindow = trueRanges.slice(windowStart, index + 1);
    const middle = mean(closeWindow);
    const variance = mean(closeWindow.map((close) => close.minus(middle).pow(2)));
    const deviation = variance.sqrt();
    const atr = mean(trWindow);
    const bbWidth = deviation.mul(bbMultiplier);
    const kcWidth = atr.mul(atrMultiplier);
    const bollingerUpper = middle.plus(bbWidth);
    const bollingerLower = middle.minus(bbWidth);
    const keltnerUpper = middle.plus(kcWidth);
    const keltnerLower = middle.minus(kcWidth);
    const isSqueezed = bollingerUpper.lte(keltnerUpper) && bollingerLower.gte(keltnerLower);

    // Regression slope over the current close window is the momentum measure;
    // its sign determines breakout direction without using future observations.
    const momentum = linearRegressionSlope(closeWindow);
    const priorSqueezeCandles = consecutiveSqueezeCandles;
    const isFiring = !isSqueezed && priorSqueezeCandles >= minSqueezeCandles;

    snapshots.push({
      timestamp: candles[index].timestamp,
      bollingerUpper,
      bollingerMiddle: middle,
      bollingerLower,
      keltnerUpper,
      keltnerMiddle: middle,
      keltnerLower,
      atr,
      momentum,
      isSqueezed,
      isFiring,
      priorSqueezeCandles,
    });
    consecutiveSqueezeCandles = isSqueezed ? consecutiveSqueezeCandles + 1 : 0;
  }

  return snapshots;
}
