import { Decimal } from 'decimal.js';
import { timeframeLabel } from '../../utils/timeframe';
import type { Timeframe } from '../../types';
import type { Candle } from '../../types';
import type { MacroContext, Structure, Zone } from '../../smc/patternRecognizer';

/**
 * Top-Down Order Flow Matrix — Module 1: HTF Roadmap.
 *
 * This module is a pure read-only lens over the 4H market. It answers three
 * questions before any entry is considered:
 *
 *   1. WHERE is price inside the active 4H dealing range?
 *   2. WHAT is the dominant 4H institutional bias?
 *   3. WHICH macro level is the primary liquidity draw?
 *
 * CONTRACT
 * --------
 * - Pure: no I/O, no logger, no config mutation, no side effects.
 * - Every price, level and percentage is a `Decimal`; no native `number`
 *   arithmetic is used for market values.
 * - Input arrays are never mutated. Sorting/filtering always happens on
 *   shallow copies.
 * - Degenerate data fails closed (`isValid = false`) instead of fabricating a
 *   range or a target.
 *
 * The output is intentionally conservative. `NEUTRAL` means "no trade
 * allowed"; a directional bias without a structural target is also marked
 * invalid so a caller cannot accidentally trade blind.
 */

export type HtfBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type HtfPhase = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';

export interface HtfRoadmap {
  readonly bias: HtfBias;
  readonly dealingRange: {
    readonly high: Decimal;
    readonly low: Decimal;
    readonly equilibrium: Decimal;
  };
  readonly phase: HtfPhase;
  readonly primaryTarget: {
    readonly price: Decimal;
    readonly label: string;
    readonly type: 'LIQUIDITY_POOL' | 'HTF_ZONE';
  } | null;
  readonly targetDistancePct: Decimal;
  readonly isValid: boolean;
  readonly reason?: string;
}

export interface HtfRoadmapInput {
  readonly htfTimeframe?: Timeframe;
  readonly candles4h: readonly Candle[];
  readonly structures4h: readonly Structure[];
  readonly zones4h: readonly Zone[];
  readonly macroContext: MacroContext;
}

const RANGE_LOOKBACK = 50;
const SWING_LOOKBACK = 3;

/** 0.2% equilibrium band from the specification. */
const PREMIUM_MULTIPLIER = new Decimal('1.002');
const DISCOUNT_MULTIPLIER = new Decimal('0.998');

/** Equal-high/low tolerance: 0.1% relative difference. */
const EQUAL_LEVEL_TOLERANCE = new Decimal('0.001');

const ZERO = new Decimal(0);

interface ParsedCandle {
  readonly timestamp: number;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
}

interface DealingRange {
  readonly high: Decimal;
  readonly low: Decimal;
  readonly equilibrium: Decimal;
}

interface ConfirmedSwing {
  readonly index: number;
  readonly price: Decimal;
}

interface BiasResult {
  readonly bias: HtfBias;
  readonly reason?: string;
}

interface RawTarget {
  readonly price: Decimal;
  readonly label: string;
  readonly type: 'LIQUIDITY_POOL' | 'HTF_ZONE';
  /** Lower wins when two sources describe the same price. */
  readonly rank: number;
}

/** Same guard used by the dynamic TP resolver. */
function isUsablePrice(value: unknown): value is Decimal {
  return value instanceof Decimal && value.isFinite() && value.gt(0);
}

function parseCandle(candle: Candle | undefined): ParsedCandle | null {
  if (!candle || !Number.isFinite(candle.timestamp)) return null;

  try {
    const open = new Decimal(candle.open);
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    const close = new Decimal(candle.close);

    if (
      !isUsablePrice(open) ||
      !isUsablePrice(high) ||
      !isUsablePrice(low) ||
      !isUsablePrice(close)
    ) {
      return null;
    }

    // Reject malformed OHLC rather than silently repairing it.
    if (high.lt(low)) return null;
    if (open.lt(low) || open.gt(high)) return null;
    if (close.lt(low) || close.gt(high)) return null;

    return { timestamp: candle.timestamp, open, high, low, close };
  } catch {
    return null;
  }
}

function invalidRoadmap(reason: string): HtfRoadmap {
  return {
    bias: 'NEUTRAL',
    dealingRange: { high: ZERO, low: ZERO, equilibrium: ZERO },
    phase: 'EQUILIBRIUM',
    primaryTarget: null,
    targetDistancePct: ZERO,
    isValid: false,
    reason,
  };
}

function isConfirmedHtfStructure(structure: Structure, htfTimeframe: string): boolean {
  if (!structure) return false;
  if (structure.timeframe !== htfTimeframe) return false;
  if (structure.isValidated === false) return false;
  if (!Number.isFinite(structure.timestamp)) return false;
  return structure.type === 'BOS' || structure.type === 'CHOCH';
}

function findIndexAtOrAfter(
  candles: readonly ParsedCandle[],
  timestamp: number,
): number {
  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i].timestamp >= timestamp) return i;
  }
  return -1;
}

/**
 * Confirmed fractal swings (3 candles on each side). Equal highs/lows are not
 * swings; flat data falls through to the candle-extreme fallback.
 */
function findConfirmedSwings(candles: readonly ParsedCandle[]): {
  highs: ConfirmedSwing[];
  lows: ConfirmedSwing[];
} {
  const highs: ConfirmedSwing[] = [];
  const lows: ConfirmedSwing[] = [];

  for (let i = SWING_LOOKBACK; i < candles.length - SWING_LOOKBACK; i += 1) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - SWING_LOOKBACK; j <= i + SWING_LOOKBACK; j += 1) {
      if (j === i) continue;
      if (candles[j].high.gte(candles[i].high)) isHigh = false;
      if (candles[j].low.lte(candles[i].low)) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }

  return { highs, lows };
}

/**
 * Build the active dealing range.
 *
 * When the window contains confirmed 4H swings, the range is the highest
 * confirmed swing high / lowest confirmed swing low. If there are not enough
 * confirmed swings (short history or a fresh CHoCH), fall back to the running
 * high/low of the window — itself capped at the last 50 4H candles.
 */
function buildDealingRange(window: readonly ParsedCandle[]): DealingRange | null {
  const swings = findConfirmedSwings(window);

  if (swings.highs.length > 0 && swings.lows.length > 0) {
    let swingHigh = swings.highs[0].price;
    let swingLow = swings.lows[0].price;

    for (const swing of swings.highs) {
      swingHigh = Decimal.max(swingHigh, swing.price);
    }
    for (const swing of swings.lows) {
      swingLow = Decimal.min(swingLow, swing.price);
    }

    if (swingHigh.gt(swingLow)) {
      return {
        high: swingHigh,
        low: swingLow,
        equilibrium: swingHigh.plus(swingLow).div(2),
      };
    }
  }

  let high = window[0].high;
  let low = window[0].low;

  for (const candle of window) {
    high = Decimal.max(high, candle.high);
    low = Decimal.min(low, candle.low);
  }

  if (!high.gt(low)) return null;

  return { high, low, equilibrium: high.plus(low).div(2) };
}

function classifyPhase(close: Decimal, equilibrium: Decimal): HtfPhase {
  if (close.gt(equilibrium.mul(PREMIUM_MULTIPLIER))) return 'PREMIUM';
  if (close.lt(equilibrium.mul(DISCOUNT_MULTIPLIER))) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}

function resolveBias(structures: readonly Structure[]): BiasResult {
  // `buildHtfRoadmap` already filters to validated 4H BOS/CHoCH entries and
  // sorts them ascending. The newest confirmed structure defines the current
  // institutional direction:
  //   - BOS  -> continuation of the active leg;
  //   - CHoCH -> the reversal leg that just changed character.
  // Requiring a 2-BOS run (or discarding an opposing CHoCH) marked most of the
  // tape NEUTRAL and paralyzed the scenario during exactly the reversals a
  // top-down model is supposed to catch.
  if (structures.length === 0) {
    return {
      bias: 'NEUTRAL',
      reason: 'Insufficient confirmed 4H BOS/CHoCH structure',
    };
  }

  const latest = structures[structures.length - 1];
  return { bias: latest.direction };
}

function findEqualHighs(swings: readonly ConfirmedSwing[]): Decimal[] {
  const levels: Decimal[] = [];

  for (let i = 0; i < swings.length; i += 1) {
    for (let j = i + 1; j < swings.length; j += 1) {
      const first = swings[i].price;
      const second = swings[j].price;
      const base = Decimal.min(first, second);
      if (base.lte(0)) continue;

      if (first.minus(second).abs().div(base).lte(EQUAL_LEVEL_TOLERANCE)) {
        levels.push(Decimal.max(first, second));
      }
    }
  }

  return levels;
}

function findEqualLows(swings: readonly ConfirmedSwing[]): Decimal[] {
  const levels: Decimal[] = [];

  for (let i = 0; i < swings.length; i += 1) {
    for (let j = i + 1; j < swings.length; j += 1) {
      const first = swings[i].price;
      const second = swings[j].price;
      const base = Decimal.min(first, second);
      if (base.lte(0)) continue;

      if (first.minus(second).abs().div(base).lte(EQUAL_LEVEL_TOLERANCE)) {
        levels.push(Decimal.min(first, second));
      }
    }
  }

  return levels;
}

/**
 * Nearest structural target in the bias direction.
 *
 * Bullish targets: unmitigated 4H supply OB/FVG, PDH, PWH, 4H EQH.
 * Bearish targets: unmitigated 4H demand OB/FVG, PDL, PWL, 4H EQL.
 *
 * Liquidity wins over a zone at the same price (stops rest there), and an OB
 * wins over an FVG. Ties are deterministic.
 */
function collectPrimaryTarget(
  bias: 'BULLISH' | 'BEARISH',
  close: Decimal,
  zones: readonly Zone[],
  macroContext: MacroContext | undefined,
  candles: readonly ParsedCandle[],
  htfTimeframe: Timeframe,
): HtfRoadmap['primaryTarget'] {
  const isLong = bias === 'BULLISH';
  const htf = timeframeLabel(htfTimeframe);
  const raw: RawTarget[] = [];

  const addTarget = (
    price: Decimal | undefined,
    label: string,
    type: RawTarget['type'],
    rank: number,
  ): void => {
    if (!isUsablePrice(price)) return;
    if (isLong ? !price.gt(close) : !price.lt(close)) return;
    raw.push({ price, label, type, rank });
  };

  const addLiquidity = (price: Decimal | undefined, label: string): void => {
    addTarget(price, label, 'LIQUIDITY_POOL', 0);
  };

  if (isLong) {
    addLiquidity(macroContext?.dailyLevels?.pdh, 'PDH');
    addLiquidity(macroContext?.weeklyLevels?.pwh, 'PWH');
  } else {
    addLiquidity(macroContext?.dailyLevels?.pdl, 'PDL');
    addLiquidity(macroContext?.weeklyLevels?.pwl, 'PWL');
  }

  // Macro liquidity pools may already carry EQH/EQL levels. Only consume the
  // side relevant to the bias; BSL/SSL are intentionally not primary targets.
  for (const pool of macroContext?.liquidityPools ?? []) {
    if (pool.isTaken) continue;
    if (isLong && pool.type === 'EQH') {
      addLiquidity(pool.priceLevel, `${htf} EQH`);
    } else if (!isLong && pool.type === 'EQL') {
      addLiquidity(pool.priceLevel, `${htf} EQL`);
    }
  }

  // Derive 4H equal highs/lows locally so the module does not depend on the
  // 15m-derived EQH/EQL pools produced by buildPatternData.
  const targetWindow = candles.slice(
    Math.max(0, candles.length - RANGE_LOOKBACK),
  );
  const swings = findConfirmedSwings(targetWindow);

  if (isLong) {
    for (const level of findEqualHighs(swings.highs)) {
      addLiquidity(level, `${htf} EQH`);
    }
  } else {
    for (const level of findEqualLows(swings.lows)) {
      addLiquidity(level, `${htf} EQL`);
    }
  }

  const opposingDirection = isLong ? 'BEARISH' : 'BULLISH';

  for (const zone of zones) {
    if (zone.timeframe !== htfTimeframe) continue;
    if (zone.mitigated) continue;
    if (zone.direction !== opposingDirection) continue;
    if (zone.type !== 'OB' && zone.type !== 'FVG') continue;
    if (!isUsablePrice(zone.top) || !isUsablePrice(zone.bottom)) continue;

    // Zone top/bottom ordering is not guaranteed (Invariant 11).
    const nearEdge = isLong
      ? Decimal.min(zone.top, zone.bottom)
      : Decimal.max(zone.top, zone.bottom);

    addTarget(
      nearEdge,
      `${htf} ${zone.type}`,
      'HTF_ZONE',
      zone.type === 'OB' ? 1 : 2,
    );
  }

  const byPrice = new Map<string, RawTarget>();
  for (const target of raw) {
    const key = target.price.toFixed(8);
    const existing = byPrice.get(key);
    if (!existing || target.rank < existing.rank) {
      byPrice.set(key, target);
    }
  }

  const candidates = [...byPrice.values()];
  if (candidates.length === 0) return null;

  candidates.sort((first, second) => {
    const byPriceOrder = isLong
      ? first.price.comparedTo(second.price)
      : second.price.comparedTo(first.price);
    if (byPriceOrder !== 0) return byPriceOrder;

    if (first.rank !== second.rank) return first.rank - second.rank;

    if (first.label < second.label) return -1;
    if (first.label > second.label) return 1;
    return 0;
  });

  const best = candidates[0];
  return { price: best.price, label: best.label, type: best.type };
}

/**
 * Build the 4H roadmap.
 *
 * Fail-closed conditions:
 * - no candles / one candle / malformed OHLC;
 * - degenerate range (high == low);
 * - no confirmed 4H BOS/CHoCH structure;
 * - directional bias with no structural target.
 *
 * Premium/discount is reported as `phase` but never vetoes a directional bias:
 * it is an entry-timing gate for the 15m pullback, not a trend filter.
 */
export function buildHtfRoadmap(input: HtfRoadmapInput): HtfRoadmap {
  const htfTimeframe = input?.htfTimeframe ?? '240';
  const htf = timeframeLabel(htfTimeframe);
  const rawCandles = input?.candles4h ?? [];

  if (rawCandles.length === 0) {
    return invalidRoadmap(`No ${htf} candles provided`);
  }

  const candles: ParsedCandle[] = [];
  for (const candle of rawCandles) {
    const parsed = parseCandle(candle);
    if (!parsed) {
      return invalidRoadmap(`Malformed ${htf} candle data`);
    }
    candles.push(parsed);
  }

  if (candles.length < 2) {
    return invalidRoadmap(`Insufficient ${htf} candles for a dealing range`);
  }

  // Never sort the caller's array.
  candles.sort((first, second) => first.timestamp - second.timestamp);

  const structures = (input?.structures4h ?? [])
    .filter(structure => isConfirmedHtfStructure(structure, htfTimeframe))
    .sort((first, second) => first.timestamp - second.timestamp);

  let latestChoch: Structure | undefined;
  for (let i = structures.length - 1; i >= 0; i -= 1) {
    if (structures[i].type === 'CHOCH') {
      latestChoch = structures[i];
      break;
    }
  }

  const fallbackStart = Math.max(0, candles.length - RANGE_LOOKBACK);
  let rangeStart = fallbackStart;

  if (latestChoch) {
    const chochIndex = findIndexAtOrAfter(candles, latestChoch.timestamp);
    if (chochIndex >= 0 && candles.length - chochIndex >= 2) {
      rangeStart = Math.max(fallbackStart, chochIndex);
    }
  }

  const rangeWindow = candles.slice(rangeStart);
  const range = buildDealingRange(rangeWindow);

  if (!range) {
    return invalidRoadmap(`Degenerate ${htf} dealing range (high equals low)`);
  }

  const lastCandle = candles[candles.length - 1];
  const close = lastCandle.close;
  const phase = classifyPhase(close, range.equilibrium);
  const biasResult = resolveBias(structures);

  if (biasResult.bias === 'NEUTRAL') {
    return {
      bias: 'NEUTRAL',
      dealingRange: range,
      phase,
      primaryTarget: null,
      targetDistancePct: ZERO,
      isValid: false,
      reason: biasResult.reason ?? `No directional ${htf} bias`,
    };
  }

  const target = collectPrimaryTarget(
    biasResult.bias,
    close,
    input?.zones4h ?? [],
    input?.macroContext,
    candles,
    htfTimeframe,
  );

  if (!target) {
    return {
      bias: biasResult.bias,
      dealingRange: range,
      phase,
      primaryTarget: null,
      targetDistancePct: ZERO,
      isValid: false,
      reason: `No ${htf} liquidity pool or unmitigated zone ${
        biasResult.bias === 'BULLISH' ? 'above' : 'below'
      } current price`,
    };
  }

  const targetDistancePct = target.price.minus(close).abs().div(close);

  if (!targetDistancePct.gt(0)) {
    return {
      bias: biasResult.bias,
      dealingRange: range,
      phase,
      primaryTarget: null,
      targetDistancePct: ZERO,
      isValid: false,
      reason: `Primary target is at the current ${htf} close`,
    };
  }

  return {
    bias: biasResult.bias,
    dealingRange: range,
    phase,
    primaryTarget: target,
    targetDistancePct,
    isValid: true,
  };
}
