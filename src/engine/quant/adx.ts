import { Decimal } from 'decimal.js';
import type { Candle } from '../../types';

/**
 * Average Directional Index (Wilder, 1978).
 *
 * Pure, read-only, causal: every value at index `i` is derived exclusively from
 * candles `0..i`. There is no lookahead, no I/O and no mutable module state, so
 * the same function serves the live router and the backtester.
 *
 * Pipeline:
 *   1. TR / +DM / -DM per candle (from the second candle onwards).
 *   2. Wilder smoothing (RMA) of each series:
 *        seed  = SMA(period) of the first `period` observations
 *        next  = prev - prev / period + current
 *   3. +DI = 100 * smoothed(+DM) / smoothed(TR),  -DI likewise.
 *   4. DX = 100 * |+DI - -DI| / (+DI + -DI).
 *   5. ADX seed = SMA(period) of the first `period` DX values, then
 *        ADX_t = (ADX_{t-1} * (period - 1) + DX_t) / period.
 *
 * Minimum history: the first smoothed series lands on index `period`, and the
 * ADX seed needs `period` DX values, so `2 * period` candles are required.
 * Anything shorter returns `null` — a filter must never invent a regime from
 * data it cannot measure.
 *
 * Degenerate windows (a perfectly flat series where smoothed TR is zero) yield
 * DX = 0 rather than a division-by-zero. A non-finite final value returns
 * `null` so callers can fall back instead of comparing against NaN.
 */
export const ADX_DEFAULT_PERIOD = 14;

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

export function calculateADX(
  candles: readonly Candle[],
  period: number = ADX_DEFAULT_PERIOD,
): Decimal | null {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error(`ADX period must be an integer >= 2, got ${period}`);
  }

  // 2 * period is the exact minimum: `period` observations to seed the RMA and
  // `period` DX values to seed the ADX average.
  if (candles.length < period * 2) return null;

  const count = candles.length;
  const highs: Decimal[] = new Array(count);
  const lows: Decimal[] = new Array(count);
  const closes: Decimal[] = new Array(count);

  for (let index = 0; index < count; index++) {
    const high = new Decimal(candles[index].high);
    const low = new Decimal(candles[index].low);
    const close = new Decimal(candles[index].close);
    if (!high.isFinite() || !low.isFinite() || !close.isFinite() || high.lt(low)) {
      throw new Error(`Invalid candle range at index ${index}`);
    }
    highs[index] = high;
    lows[index] = low;
    closes[index] = close;
  }

  // Index 0 has no predecessor, so TR/DM are defined from index 1 onwards.
  const trueRanges: Decimal[] = new Array(count).fill(ZERO);
  const plusDm: Decimal[] = new Array(count).fill(ZERO);
  const minusDm: Decimal[] = new Array(count).fill(ZERO);

  for (let index = 1; index < count; index++) {
    const upMove = highs[index].minus(highs[index - 1]);
    const downMove = lows[index - 1].minus(lows[index]);

    // Directional movement is exclusive: only the larger of the two survives,
    // and a non-positive move contributes nothing.
    plusDm[index] = upMove.gt(0) && upMove.gt(downMove) ? upMove : ZERO;
    minusDm[index] = downMove.gt(0) && downMove.gt(upMove) ? downMove : ZERO;

    const previousClose = closes[index - 1];
    trueRanges[index] = Decimal.max(
      highs[index].minus(lows[index]),
      highs[index].minus(previousClose).abs(),
      lows[index].minus(previousClose).abs(),
    );
  }

  const seedAverage = (values: readonly Decimal[]): Decimal => {
    let sum = ZERO;
    for (let index = 1; index <= period; index++) {
      sum = sum.plus(values[index]);
    }
    return sum.div(period);
  };

  let smoothedTr = seedAverage(trueRanges);
  let smoothedPlusDm = seedAverage(plusDm);
  let smoothedMinusDm = seedAverage(minusDm);

  const dxValues: Decimal[] = [];

  const recordDx = (): void => {
    // A flat window has no directional information; DX is defined as 0 instead
    // of letting 0/0 poison the recursion with NaN.
    if (smoothedTr.lte(0)) {
      dxValues.push(ZERO);
      return;
    }

    const plusDi = HUNDRED.mul(smoothedPlusDm).div(smoothedTr);
    const minusDi = HUNDRED.mul(smoothedMinusDm).div(smoothedTr);
    const diSum = plusDi.plus(minusDi);

    if (diSum.lte(0)) {
      dxValues.push(ZERO);
      return;
    }

    dxValues.push(HUNDRED.mul(plusDi.minus(minusDi).abs()).div(diSum));
  };

  recordDx(); // DX at index `period` — the first index with a seeded RMA.

  for (let index = period + 1; index < count; index++) {
    smoothedTr = smoothedTr.minus(smoothedTr.div(period)).plus(trueRanges[index]);
    smoothedPlusDm = smoothedPlusDm
      .minus(smoothedPlusDm.div(period))
      .plus(plusDm[index]);
    smoothedMinusDm = smoothedMinusDm
      .minus(smoothedMinusDm.div(period))
      .plus(minusDm[index]);
    recordDx();
  }

  // Defensive: the length guard above already guarantees this, but a future
  // refactor of the seeding rules must fail closed rather than throw on [0].
  if (dxValues.length < period) return null;

  let adx = ZERO;
  for (let index = 0; index < period; index++) {
    adx = adx.plus(dxValues[index]);
  }
  adx = adx.div(period);

  for (let index = period; index < dxValues.length; index++) {
    adx = adx.mul(period - 1).plus(dxValues[index]).div(period);
  }

  return adx.isFinite() ? adx : null;
}
