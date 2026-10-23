import { Decimal } from 'decimal.js';
import type { Candle } from '../../types';

/**
 * Top-Down Order Flow Matrix — Module 2: Volume Exhaustion.
 *
 * This module is a pure diagnostic layer over 15m candles. It answers two
 * questions before a POI reaction is allowed to become an entry:
 *
 *   1. Did selling/buying pressure actually dry up during the pullback?
 *   2. Did the POI touch print an institutional volume surge?
 *
 * CONTRACT
 * --------
 * - Pure: no I/O, no logger, no config mutation, no side effects.
 * - Every volume, average and ratio is a `Decimal`; no native `number`
 *   arithmetic is used for market values.
 * - Input arrays are never mutated. Sorting always happens on a shallow copy.
 * - Degenerate data fails closed (`isValid = false`) instead of fabricating an
 *   exhaustion signal.
 * - `failureCode` partitions the diagnostic outcome so callers can expose
 *   truthful funnel telemetry instead of a catch-all "not exhausted" bucket.
 *
 * The result is intentionally conservative. `isValid` describes data and
 * structural integrity; `isExhausted` and `isReactionConfirmed` are the two
 * independent trading gates. A clean panic dump can be `isValid = true` while
 * `isExhausted = false`, which is exactly the information the caller needs.
 */

export type VolumeExhaustionFailureCode =
  | 'INVALID_DIRECTION'
  | 'INVALID_VOLUME_SMA_PERIOD'
  | 'INVALID_MAX_PULLBACK_VOLUME_RATIO'
  | 'INVALID_MIN_REACTION_VOLUME_RATIO'
  | 'MALFORMED_CANDLES'
  | 'INSUFFICIENT_HISTORY'
  | 'INVALID_POI'
  | 'INVALID_ATR'
  | 'TOUCH_CANDLE_NOT_FOUND'
  | 'NO_PULLBACK_ORIGIN'
  | 'INSUFFICIENT_PULLBACK_CANDLES'
  | 'POI_VIOLATED'
  | 'NO_POI_TOUCH'
  | 'INSUFFICIENT_BASELINE_HISTORY'
  | 'ZERO_BASELINE_VOLUME'
  | 'INVALID_BASELINE_VOLUME'
  | 'ZERO_PULLBACK_VOLUME'
  | 'ZERO_REACTION_VOLUME'
  | 'PULLBACK_VOLUME_HEAVY'
  | 'REACTION_VOLUME_WEAK';

export interface VolumeExhaustionInput {
  readonly candles15m: readonly Candle[];
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly poiZone: {
    readonly top: Decimal;
    readonly bottom: Decimal;
    readonly timestamp?: number;
  };
  /**
   * 15m ATR used by the volatility-aware POI invalidation buffer.
   * Required: a missing ATR must fail closed rather than silently falling back
   * to a brittle fixed percentage.
   */
  readonly atr15m: Decimal;
  /**
   * Closed 15m candle evaluated as the POI touch. Defaults to the latest candle.
   * Scenario 13 passes an explicit timestamp so a touch from the previous
   * closed candle can remain primed while the 1m trigger develops.
   */
  readonly touchCandleTimestamp?: number;
  /** Baseline volume SMA period. Default: 20. */
  readonly volumeSmaPeriod?: number;
  /** Maximum average pullback volume / baseline. Default: 1.5. */
  readonly maxPullbackVolumeRatio?: Decimal;
  /** Minimum reaction candle volume / baseline. Default: 1.0. */
  readonly minReactionVolumeRatio?: Decimal;
}

export interface VolumeExhaustionResult {
  readonly isExhausted: boolean;
  readonly isReactionConfirmed: boolean;
  readonly pullbackAvgRatio: Decimal;
  readonly reactionVolumeRatio: Decimal;
  readonly baselineVolume: Decimal;
  readonly pullbackCandleCount: number;
  readonly pullbackOriginTimestamp?: number;
  readonly isValid: boolean;
  readonly failureCode?: VolumeExhaustionFailureCode;
  readonly reason?: string;
}

const DEFAULT_VOLUME_SMA_PERIOD = 20;
const DEFAULT_MAX_PULLBACK_VOLUME_RATIO = new Decimal('1.5');
const DEFAULT_MIN_REACTION_VOLUME_RATIO = new Decimal('1.0');

/**
 * POI invalidation tolerance. A corrective close must exceed the POI boundary
 * by the LARGER of:
 *   - 50% of the zone height, or
 *   - 40% of the 15m ATR.
 *
 * A static percentage is too fragile on 15m crypto charts where ATR routinely
 * runs 0.5%–1.5% of price. The ATR term lets normal deep mitigation wicks trade
 * through the zone without falsely declaring it destroyed, while the zone-height
 * term keeps thin zones from becoming infinitely tolerant.
 */
const POI_VIOLATION_ZONE_FRACTION = new Decimal('0.5');
const POI_VIOLATION_ATR_FRACTION = new Decimal('0.4');

const ZERO = new Decimal(0);

interface ParsedCandle {
  readonly timestamp: number;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
}

interface FailureDetails {
  readonly isExhausted?: boolean;
  readonly isReactionConfirmed?: boolean;
  readonly pullbackAvgRatio?: Decimal;
  readonly reactionVolumeRatio?: Decimal;
  readonly baselineVolume?: Decimal;
  readonly pullbackCandleCount?: number;
  readonly pullbackOriginTimestamp?: number;
}

function isUsablePrice(value: unknown): value is Decimal {
  return value instanceof Decimal && value.isFinite() && value.gt(0);
}

function isNonNegativeRatio(value: unknown): value is Decimal {
  return value instanceof Decimal && value.isFinite() && value.gte(0);
}

function parseCandle(candle: Candle | undefined): ParsedCandle | null {
  if (!candle || !Number.isFinite(candle.timestamp)) return null;

  try {
    const open = new Decimal(candle.open);
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    const close = new Decimal(candle.close);
    const volume = new Decimal(candle.volume);

    if (
      !isUsablePrice(open) ||
      !isUsablePrice(high) ||
      !isUsablePrice(low) ||
      !isUsablePrice(close)
    ) {
      return null;
    }

    // Volume is allowed to be zero at parse time; the analyzed windows reject
    // it later with a window-specific reason.
    if (!volume.isFinite() || volume.lt(0)) return null;

    // Reject malformed OHLC rather than silently repairing it.
    if (high.lt(low)) return null;
    if (open.lt(low) || open.gt(high)) return null;
    if (close.lt(low) || close.gt(high)) return null;

    return {
      timestamp: candle.timestamp,
      open,
      high,
      low,
      close,
      volume,
    };
  } catch {
    return null;
  }
}

function fail(
  code: VolumeExhaustionFailureCode,
  reason: string,
  details: FailureDetails = {},
): VolumeExhaustionResult {
  return {
    isExhausted: details.isExhausted ?? false,
    isReactionConfirmed: details.isReactionConfirmed ?? false,
    pullbackAvgRatio: details.pullbackAvgRatio ?? ZERO,
    reactionVolumeRatio: details.reactionVolumeRatio ?? ZERO,
    baselineVolume: details.baselineVolume ?? ZERO,
    pullbackCandleCount: details.pullbackCandleCount ?? 0,
    pullbackOriginTimestamp: details.pullbackOriginTimestamp,
    isValid: false,
    failureCode: code,
    reason,
  };
}

/**
 * Finds the structural extreme that anchors the pullback.
 *
 * A rigid 2-left/2-right fractal is not required: sharp crypto pullbacks often
 * print a V-shaped or equal-high extreme that never satisfies a symmetric pivot
 * test. Instead, the origin is the highest high (BULLISH) or lowest low
 * (BEARISH) strictly between the POI anchor and the touch candle. Ties resolve
 * to the most recent extreme, because that is the swing the current pullback
 * actually left behind.
 *
 * The extreme must sit beyond the POI boundary; otherwise the window contains
 * no genuine approach into the zone and the diagnostic fails closed.
 */
function findPullbackOrigin(
  candles: readonly ParsedCandle[],
  testIndex: number,
  direction: 'BULLISH' | 'BEARISH',
  zoneTop: Decimal,
  zoneBottom: Decimal,
  startIndex: number,
): { index: number; extreme: Decimal } | null {
  if (testIndex <= 0) return null;

  const from = Math.max(0, startIndex);
  let originIndex = -1;
  let extreme: Decimal | null = null;

  for (let i = from; i < testIndex; i += 1) {
    const value = direction === 'BULLISH' ? candles[i].high : candles[i].low;
    if (extreme === null) {
      extreme = value;
      originIndex = i;
      continue;
    }

    const isNewExtreme =
      direction === 'BULLISH' ? value.gte(extreme) : value.lte(extreme);
    if (isNewExtreme) {
      extreme = value;
      originIndex = i;
    }
  }

  if (originIndex < 0 || extreme === null) return null;

  const isBeyondZone =
    direction === 'BULLISH' ? extreme.gt(zoneTop) : extreme.lt(zoneBottom);
  if (!isBeyondZone) return null;

  return { index: originIndex, extreme };
}

/** Index of the last candle at or before the POI anchor timestamp. */
function resolvePoiAnchorIndex(
  candles: readonly ParsedCandle[],
  poiTimestamp: number | undefined,
): number {
  if (poiTimestamp === undefined) return 0;
  if (!Number.isFinite(poiTimestamp)) return -1;

  let anchor = -1;
  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i].timestamp <= poiTimestamp) anchor = i;
    else break;
  }
  return anchor;
}

/**
 * Evaluates 15m volume exhaustion during a pullback into a POI and validates
 * the volume signature of the POI reaction.
 *
 * `touchCandleTimestamp` makes the diagnostic causal and reusable across the
 * 30-minute reaction window: the function evaluates exactly the supplied closed
 * candle and ignores every later candle, so an older touch cannot borrow future
 * data.
 */
export function analyzeVolumeExhaustion(
  input: VolumeExhaustionInput,
): VolumeExhaustionResult {
  const direction = input?.direction;
  if (direction !== 'BULLISH' && direction !== 'BEARISH') {
    return fail('INVALID_DIRECTION', 'Invalid direction');
  }

  const volumeSmaPeriod = input?.volumeSmaPeriod ?? DEFAULT_VOLUME_SMA_PERIOD;
  if (!Number.isInteger(volumeSmaPeriod) || volumeSmaPeriod <= 0) {
    return fail('INVALID_VOLUME_SMA_PERIOD', 'Invalid volumeSmaPeriod');
  }

  const maxPullbackVolumeRatio =
    input?.maxPullbackVolumeRatio ?? DEFAULT_MAX_PULLBACK_VOLUME_RATIO;
  const minReactionVolumeRatio =
    input?.minReactionVolumeRatio ?? DEFAULT_MIN_REACTION_VOLUME_RATIO;

  if (!isNonNegativeRatio(maxPullbackVolumeRatio)) {
    return fail(
      'INVALID_MAX_PULLBACK_VOLUME_RATIO',
      'Invalid maxPullbackVolumeRatio',
    );
  }
  if (!isNonNegativeRatio(minReactionVolumeRatio)) {
    return fail(
      'INVALID_MIN_REACTION_VOLUME_RATIO',
      'Invalid minReactionVolumeRatio',
    );
  }

  const rawCandles = input?.candles15m;
  if (!Array.isArray(rawCandles)) {
    return fail('MALFORMED_CANDLES', 'Malformed 15m candle data');
  }

  const atr15m = input?.atr15m;
  if (!isUsablePrice(atr15m)) {
    return fail('INVALID_ATR', 'Invalid atr15m');
  }

  // Sort a shallow copy; the caller's array must stay untouched. Then cut the
  // series at the requested touch candle so no future candle can leak into the
  // pullback, baseline or reaction calculations.
  const sortedRaw = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);
  let endExclusive = sortedRaw.length;

  if (input.touchCandleTimestamp !== undefined) {
    if (!Number.isFinite(input.touchCandleTimestamp)) {
      return fail('TOUCH_CANDLE_NOT_FOUND', 'Invalid touchCandleTimestamp');
    }
    const touchIndex = sortedRaw.findIndex(
      (candle) => candle.timestamp === input.touchCandleTimestamp,
    );
    if (touchIndex < 0) {
      return fail(
        'TOUCH_CANDLE_NOT_FOUND',
        `Touch candle ${input.touchCandleTimestamp} not found`,
      );
    }
    endExclusive = touchIndex + 1;
  }

  const windowRaw = sortedRaw.slice(0, endExclusive);
  if (windowRaw.length < volumeSmaPeriod + 3) {
    return fail('INSUFFICIENT_HISTORY', 'Insufficient history');
  }

  const parsedCandles: ParsedCandle[] = [];
  for (const candle of windowRaw) {
    const parsed = parseCandle(candle);
    if (!parsed) return fail('MALFORMED_CANDLES', 'Malformed 15m candle data');
    parsedCandles.push(parsed);
  }

  const zone = input?.poiZone;
  if (!zone || !isUsablePrice(zone.top) || !isUsablePrice(zone.bottom)) {
    return fail('INVALID_POI', 'Invalid POI zone');
  }

  // POI bounds are normalized defensively: zone objects in this codebase do
  // not guarantee top > bottom ordering.
  const zoneTop = Decimal.max(zone.top, zone.bottom);
  const zoneBottom = Decimal.min(zone.top, zone.bottom);
  const zoneHeight = zoneTop.minus(zoneBottom);

  const violationBuffer = Decimal.max(
    zoneHeight.mul(POI_VIOLATION_ZONE_FRACTION),
    atr15m.mul(POI_VIOLATION_ATR_FRACTION),
  );

  const testIndex = parsedCandles.length - 1;
  const testCandle = parsedCandles[testIndex];

  if (zone.timestamp !== undefined && zone.timestamp > testCandle.timestamp) {
    return fail(
      'NO_PULLBACK_ORIGIN',
      'POI anchor is after the touch candle',
    );
  }

  const anchorIndex = resolvePoiAnchorIndex(parsedCandles, zone.timestamp);
  const originStart = anchorIndex >= 0 ? anchorIndex : 0;

  // Only a decisive close beyond the boundary invalidates the POI. The buffer
  // is max(50% of zone height, 40% of 15m ATR): deep institutional mitigations
  // are tolerated, while an accepted break is still rejected.
  const violatesZone = (candle: ParsedCandle): boolean =>
    direction === 'BULLISH'
      ? candle.close.lt(zoneBottom.minus(violationBuffer))
      : candle.close.gt(zoneTop.plus(violationBuffer));

  // A decisive close through the POI on the evaluated candle invalidates the
  // zone immediately, even when no valid pullback origin exists. This is what
  // clears an older PRIMED touch after a fresh 15m breakdown.
  if (violatesZone(testCandle)) {
    return fail('POI_VIOLATED', 'POI structurally violated on pullback');
  }

  const origin = findPullbackOrigin(
    parsedCandles,
    testIndex,
    direction,
    zoneTop,
    zoneBottom,
    originStart,
  );
  if (!origin) {
    return fail('NO_PULLBACK_ORIGIN', 'No valid pullback origin');
  }

  const correctiveStart = origin.index + 1;
  const pullbackCandleCount = testIndex - correctiveStart;

  if (pullbackCandleCount < 2) {
    return fail('INSUFFICIENT_PULLBACK_CANDLES', 'Insufficient corrective candles', {
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  const pullbackCandles = parsedCandles.slice(correctiveStart, testIndex);

  // Corrective candles are checked by the same rule. The evaluated candle was
  // already checked above, before the origin search.
  if (pullbackCandles.some(violatesZone)) {
    return fail('POI_VIOLATED', 'POI structurally violated on pullback', {
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  const touchesZone =
    testCandle.high.gte(zoneBottom) && testCandle.low.lte(zoneTop);
  if (!touchesZone) {
    return fail('NO_POI_TOUCH', 'Touch candle did not touch the POI', {
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  const baselineStart = correctiveStart - volumeSmaPeriod;
  if (baselineStart < 0) {
    return fail('INSUFFICIENT_BASELINE_HISTORY', 'Insufficient history for baseline', {
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  const baselineCandles = parsedCandles.slice(baselineStart, correctiveStart);
  if (baselineCandles.some((candle) => candle.volume.lte(0))) {
    return fail('ZERO_BASELINE_VOLUME', 'Zero volume in baseline', {
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  let baselineSum = ZERO;
  for (const candle of baselineCandles) {
    baselineSum = baselineSum.plus(candle.volume);
  }
  const baselineVolume = baselineSum.div(new Decimal(volumeSmaPeriod));

  if (!baselineVolume.isFinite() || baselineVolume.lte(0)) {
    return fail(
      'INVALID_BASELINE_VOLUME',
      'Baseline volume is zero or invalid',
      {
        pullbackCandleCount,
        pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
      },
    );
  }

  if (pullbackCandles.some((candle) => candle.volume.lte(0))) {
    return fail('ZERO_PULLBACK_VOLUME', 'Zero volume in pullback', {
      baselineVolume,
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  let pullbackSum = ZERO;
  for (const candle of pullbackCandles) {
    pullbackSum = pullbackSum.plus(candle.volume);
  }
  const pullbackAvgVolume = pullbackSum.div(
    new Decimal(pullbackCandleCount),
  );
  const pullbackAvgRatio = pullbackAvgVolume.div(baselineVolume);

  if (testCandle.volume.lte(0)) {
    return fail('ZERO_REACTION_VOLUME', 'Zero volume in reaction candle', {
      baselineVolume,
      pullbackAvgRatio,
      pullbackCandleCount,
      pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    });
  }

  const reactionVolumeRatio = testCandle.volume.div(baselineVolume);
  const isExhausted = pullbackAvgRatio.lte(maxPullbackVolumeRatio);
  const isReactionConfirmed = reactionVolumeRatio.gte(minReactionVolumeRatio);

  let failureCode: VolumeExhaustionFailureCode | undefined;
  let reason: string | undefined;

  if (!isExhausted) {
    failureCode = 'PULLBACK_VOLUME_HEAVY';
    reason = `Heavy pullback volume (ratio ${pullbackAvgRatio.toFixed(2)} > ${maxPullbackVolumeRatio.toString()})`;
  } else if (!isReactionConfirmed) {
    failureCode = 'REACTION_VOLUME_WEAK';
    reason = `No reaction volume at POI touch (ratio ${reactionVolumeRatio.toFixed(2)} < ${minReactionVolumeRatio.toString()})`;
  }

  return {
    isExhausted,
    isReactionConfirmed,
    pullbackAvgRatio,
    reactionVolumeRatio,
    baselineVolume,
    pullbackCandleCount,
    pullbackOriginTimestamp: parsedCandles[origin.index].timestamp,
    isValid: true,
    failureCode,
    reason,
  };
}
