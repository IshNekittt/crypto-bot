import { Decimal } from 'decimal.js';
import {
  Candle,
  Direction,
  FVG,
  OrderBlock,
  StructureBreak,
  StructureBreakKind,
  SwingPoint,
  SwingType,
  Trend,
} from '../types';

export const SWING_LOOKBACK_CANDLES = 3;
export const AVERAGE_BODY_WINDOW = 10;
export const IMPULSE_MIN_FACTOR = new Decimal(2);
export const MIN_FVG_GAP_PERCENT = new Decimal('0.1');
export const STOP_LOSS_BUFFER_PERCENT = new Decimal('0.1');
export const TAKE_PROFIT_RR_RATIO = new Decimal(3);
export const LIQUIDITY_SWEEP_LOOKBACK = 10;

export function bodyOf(candle: Candle): Decimal {
  return new Decimal(candle.open).minus(candle.close).abs();
}

function isBullishCandle(candle: Candle): boolean {
  return new Decimal(candle.close).greaterThan(new Decimal(candle.open));
}

function isSwingHigh(candles: readonly Candle[], index: number): boolean {
  const candidate = candles[index];
  const candidateHigh = new Decimal(candidate.high);
  for (let offset = 1; offset <= SWING_LOOKBACK_CANDLES; offset++) {
    const left = candles[index - offset];
    const right = candles[index + offset];
    if (!left || !right) return false;
    if (new Decimal(left.high).greaterThanOrEqualTo(candidateHigh)) return false;
    if (new Decimal(right.high).greaterThanOrEqualTo(candidateHigh)) return false;
  }
  return true;
}

function isSwingLow(candles: readonly Candle[], index: number): boolean {
  const candidate = candles[index];
  const candidateLow = new Decimal(candidate.low);
  for (let offset = 1; offset <= SWING_LOOKBACK_CANDLES; offset++) {
    const left = candles[index - offset];
    const right = candles[index + offset];
    if (!left || !right) return false;
    if (new Decimal(left.low).lessThanOrEqualTo(candidateLow)) return false;
    if (new Decimal(right.low).lessThanOrEqualTo(candidateLow)) return false;
  }
  return true;
}

function toSwingPoint(type: SwingType, candles: readonly Candle[], index: number): SwingPoint {
  const candle = candles[index];
  const price = type === 'HIGH' ? new Decimal(candle.high) : new Decimal(candle.low);
  return { type, index, timestamp: candle.timestamp, price };
}

export function findSwingPoints(candles: readonly Candle[]): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = SWING_LOOKBACK_CANDLES; i < candles.length - SWING_LOOKBACK_CANDLES; i++) {
    if (isSwingHigh(candles, i)) points.push(toSwingPoint('HIGH', candles, i));
    else if (isSwingLow(candles, i)) points.push(toSwingPoint('LOW', candles, i));
  }
  return points;
}

export function averageBodyBefore(candles: readonly Candle[], index: number): Decimal {
  const startIndex = index - AVERAGE_BODY_WINDOW;
  if (startIndex < 0) {
    throw new RangeError(`Need at least ${AVERAGE_BODY_WINDOW} candles before index ${index}`);
  }
  let total = new Decimal(0);
  for (let i = startIndex; i < index; i++) {
    total = total.plus(bodyOf(candles[i]));
  }
  return total.div(AVERAGE_BODY_WINDOW);
}

function classifyBreak(direction: Direction, trend: Trend | null): StructureBreakKind {
  if (trend === null || trend !== toTrend(direction)) return 'CHOCH';
  return 'BOS';
}

function toTrend(direction: Direction): Trend {
  return direction === 'BULLISH' ? Trend.UP : Trend.DOWN;
}

export function detectStructureBreaks(candles: readonly Candle[]): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  let activeHigh: SwingPoint | null = null;
  let activeLow: SwingPoint | null = null;
  let trend: Trend | null = null;

  for (let i = SWING_LOOKBACK_CANDLES * 2; i < candles.length; i++) {
    const confirmedIndex = i - SWING_LOOKBACK_CANDLES;
    if (isSwingHigh(candles, confirmedIndex)) {
      activeHigh = toSwingPoint('HIGH', candles, confirmedIndex);
    }
    if (isSwingLow(candles, confirmedIndex)) {
      activeLow = toSwingPoint('LOW', candles, confirmedIndex);
    }
    if (i < AVERAGE_BODY_WINDOW) continue;

    const candle = candles[i];
    const close = new Decimal(candle.close);
    const body = bodyOf(candle);

    if (activeHigh && close.greaterThan(activeHigh.price)) {
      const averageBody = averageBodyBefore(candles, i);
      const impulseFactor = body.div(averageBody);
      if (body.greaterThan(0) && impulseFactor.greaterThanOrEqualTo(IMPULSE_MIN_FACTOR)) {
        const direction: Direction = 'BULLISH';
        breaks.push({
          kind: classifyBreak(direction, trend),
          direction,
          brokenSwing: activeHigh,
          candleIndex: i,
          impulseFactor,
        });
        trend = toTrend(direction);
        activeHigh = null;
      }
    }

    if (activeLow && close.lessThan(activeLow.price)) {
      const averageBody = averageBodyBefore(candles, i);
      const impulseFactor = body.div(averageBody);
      if (body.greaterThan(0) && impulseFactor.greaterThanOrEqualTo(IMPULSE_MIN_FACTOR)) {
        const direction: Direction = 'BEARISH';
        breaks.push({
          kind: classifyBreak(direction, trend),
          direction,
          brokenSwing: activeLow,
          candleIndex: i,
          impulseFactor,
        });
        trend = toTrend(direction);
        activeLow = null;
      }
    }
  }
  return breaks;
}

export function findFVGs(candles: readonly Candle[]): FVG[] {
  const fvgs: FVG[] = [];
  for (let i = 0; i + 2 < candles.length; i++) {
    const first = candles[i];
    const middle = candles[i + 1];
    const third = candles[i + 2];
    const referencePrice = new Decimal(middle.close);
    if (referencePrice.isZero()) continue;

    const bullishGap = new Decimal(third.low).minus(first.high);
    if (bullishGap.greaterThan(0)
      && bullishGap.div(referencePrice).mul(100).greaterThanOrEqualTo(MIN_FVG_GAP_PERCENT)) {
      fvgs.push({
        direction: 'BULLISH',
        index: i,
        timestamp: first.timestamp,
        top: new Decimal(third.low),
        bottom: new Decimal(first.high),
      });
    }

    const bearishGap = new Decimal(first.low).minus(third.high);
    if (bearishGap.greaterThan(0)
      && bearishGap.div(referencePrice).mul(100).greaterThanOrEqualTo(MIN_FVG_GAP_PERCENT)) {
      fvgs.push({
        direction: 'BEARISH',
        index: i,
        timestamp: first.timestamp,
        top: new Decimal(first.low),
        bottom: new Decimal(third.high),
      });
    }
  }
  return fvgs;
}

function findOriginCandle(candles: readonly Candle[], breakEvent: StructureBreak): number {
  const originIsBullish = breakEvent.direction === 'BEARISH';
  for (let j = breakEvent.candleIndex - 1; j >= 0; j--) {
    if (isBullishCandle(candles[j]) === originIsBullish) return j;
  }
  return -1;
}

function isInvalidateClose(close: Decimal, block: OrderBlock): boolean {
  return block.direction === 'BULLISH'
    ? close.lessThan(block.bottom)
    : close.greaterThan(block.top);
}

export function findOrderBlocks(
  candles: readonly Candle[],
  breaks: readonly StructureBreak[],
): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  for (const breakEvent of breaks) {
    const originIndex = findOriginCandle(candles, breakEvent);
    if (originIndex < 0) continue;
    const origin = candles[originIndex];
    const candidate: OrderBlock = {
      direction: breakEvent.direction,
      index: originIndex,
      timestamp: origin.timestamp,
      top: new Decimal(origin.high),
      bottom: new Decimal(origin.low),
      breakEvent,
      invalidated: false,
    };
    let invalidated = false;
    for (let k = breakEvent.candleIndex + 1; k < candles.length; k++) {
      if (isInvalidateClose(new Decimal(candles[k].close), candidate)) {
        invalidated = true;
        break;
      }
    }
    blocks.push({ ...candidate, invalidated });
  }
  return blocks;
}

export function hasRecentLiquiditySweep(
  candles: readonly Candle[],
  direction: Direction,
): boolean {
  const swings = findSwingPoints(candles);
  const targets = swings.filter((s) => (direction === 'BULLISH' ? s.type === 'LOW' : s.type === 'HIGH'));
  if (targets.length === 0) return false;

  const scanStart = Math.max(SWING_LOOKBACK_CANDLES, candles.length - LIQUIDITY_SWEEP_LOOKBACK);
  for (let i = scanStart; i < candles.length; i++) {
    const candle = candles[i];
    const low = new Decimal(candle.low);
    const high = new Decimal(candle.high);
    const close = new Decimal(candle.close);
    for (const swing of targets) {
      if (swing.index >= i) continue;
      if (direction === 'BULLISH') {
        if (low.lessThan(swing.price) && close.greaterThan(swing.price)) return true;
      } else if (high.greaterThan(swing.price) && close.lessThan(swing.price)) {
        return true;
      }
    }
  }
  return false;
}

export function calculateStopLoss(block: OrderBlock, timeframeDirection: Direction): Decimal {
  const bufferFactor = STOP_LOSS_BUFFER_PERCENT.div(100);
  if (timeframeDirection === 'BULLISH') {
    return block.bottom.mul(new Decimal(1).minus(bufferFactor));
  }
  return block.top.mul(new Decimal(1).plus(bufferFactor));
}

export function calculateTakeProfit(entry: Decimal, stopLoss: Decimal): Decimal {
  return entry.plus(entry.minus(stopLoss).mul(TAKE_PROFIT_RR_RATIO));
}
