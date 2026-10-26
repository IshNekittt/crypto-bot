import { BaseScenario, TradeLevels } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/**
 * EQH/EQL proximity to the range boundary: `max(0.1%, 0.5 x ATR)` (AGENTS.md §7.1).
 * A "cluster" further than this from the boundary did not form the range, so it
 * is not the stop pool this turtle soup is taking.
 */
const EQ_TOLERANCE_MIN_PCT = new Decimal('0.001');
const EQ_TOLERANCE_ATR_MULTIPLIER = new Decimal('0.5');
/** Fallback rejection-wick floor when the config value is unusable. */
const DEFAULT_MIN_WICK_RATIO = new Decimal('0.25');

type Direction = 'BULLISH' | 'BEARISH';

/**
 * A tradeable side of the range: the boundary, the equal-highs/lows cluster that
 * confirms stops rest there, and the level the wick must actually clear.
 */
interface ArmedSide {
  /** Trade direction implied by the swept side (high sweep → short). */
  readonly direction: Direction;
  /** The visible trading-range extreme. */
  readonly boundary: Decimal;
  /** The EQH/EQL price — the actual stop cluster behind the boundary. */
  readonly pool: Decimal;
  /**
   * The further of the two. Both the boundary and the cluster must be taken for
   * the stops to be harvested, so the sweep gate uses the stricter level.
   */
  readonly sweptLevel: Decimal;
}

/** A confirmed single-bar SFP at one side of the range. */
interface SfpEvent {
  readonly side: ArmedSide;
  readonly candle: any;
  /** Depth beyond `sweptLevel`; breaks ties when one bar clears both sides. */
  readonly penetration: Decimal;
}

/** Fully validated turtle soup. Setters are applied only for a plan. */
interface TurtleSoupPlan {
  readonly direction: Direction;
  readonly sfp: SfpEvent;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario9Stats {
  totalEvals: number;
  killzone: number;
  noTradingRange: number;
  noEqhEql: number;
  noSweep: number;
  bodyClose: number;
  weakWick: number;
  tpInvalid: number;
}

type FailureKind = 'none' | 'bodyClose' | 'weakWick' | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 9 — Turtle Soup (range SFP).
 *
 * A tight trading range is a double top / double bottom: equal highs at the range
 * high (EQH) and equal lows at the range low (EQL) are where the crowd's stops
 * sit. Price spikes through one boundary to harvest those stops, fails to hold,
 * and closes back inside. The trade is that failure.
 *
 * Causal contract:
 *  1. Direction comes from the swept side, never from a hardcoded side. Sweeping
 *     the range HIGH (EQH) is a failed breakout and produces a short back to the
 *     equilibrium; sweeping the range LOW (EQL) produces a long. The legacy
 *     long path was unreachable in the bearish-first branch and is now a
 *     first-class mirror.
 *  2. The trigger is the candle that just closed, and only that candle. Turtle
 *     soup is a single-bar event: entering on the SFP close is the whole point,
 *     and re-scanning history would re-fire a spent manipulation.
 *  3. The wick must take the liquidity — both the visible boundary and the
 *     EQH/EQL cluster behind it — while the BODY closes strictly back inside the
 *     range (AGENTS.md §7.1). A close outside is acceptance of the breakout, not
 *     a sweep.
 *  4. Rejection quality is measured as the share of the candle's total range that
 *     the rejection wick occupies (`high - max(open, close)` for a high sweep),
 *     floored by `SMC_SWEEP_MIN_WICK_RATIO`. Candle colour is deliberately NOT
 *     gated: the SFP definition is "wick beyond, body back inside", and an
 *     additional colour test rejects valid recoveries (see Scenario 12).
 *  5. The stop is the entire SFP candle range — the wick that took the liquidity
 *     IS the invalidation. `calculateLevels()` adds the 0.1% / ATR offset on top.
 *  6. The target comes from the structural resolver (range equilibrium, the
 *     opposing EQH/EQL cluster, session extremes). `skipMinorObstacles: false`
 *     keeps the nearest obstacle a hard wall: if it leaves less than
 *     DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
 *
 * Removed legacy logic:
 *  - The `R:R >= 3` check that compared a fixed `3R` target against itself. It
 *    could never fail (the TP was derived from the stop) and is replaced by the
 *    structural resolver's `minRr` floor.
 *  - The `levelsEqual(price, boundary, max(0.1%, 0.5*ATR/boundary))` ratio dance.
 *    The tolerance is now an absolute distance, which is what the ATR term always
 *    meant.
 *  - The Premium/Discount bucket. It was never evaluated on the long path, and
 *    the structural target already encodes where price may travel.
 */
export class Scenario9_TurtleSoup extends BaseScenario {
  /** Deepest rejection of the chain — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario9Stats = {
    totalEvals: 0,
    killzone: 0,
    noTradingRange: 0,
    noEqhEql: 0,
    noSweep: 0,
    bodyClose: 0,
    weakWick: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(9, 'Turtle Soup', config);
  }

  static getRejectionStats(): Scenario9Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noTradingRange: 0,
      noEqhEql: 0,
      noSweep: 0,
      bodyClose: 0,
      weakWick: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario9_TurtleSoup.stats;
    stats.totalEvals++;
    this.resetFailure();

    if (!this.passesKillzone(patternData)) {
      this.logRejection('Turtle Soup requires London or NY killzone');
      stats.killzone++;
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    const tradingRange = patternData.tradingRange;
    if (
      candles15m.length === 0 ||
      !tradingRange ||
      !(tradingRange.high instanceof Decimal) ||
      !(tradingRange.low instanceof Decimal) ||
      !tradingRange.high.gt(tradingRange.low)
    ) {
      this.logRejection('No valid trading range available');
      stats.noTradingRange++;
      return false;
    }

    const rangeHigh = new Decimal(tradingRange.high);
    const rangeLow = new Decimal(tradingRange.low);
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');
    const liquidityPools: any[] = Array.isArray(patternData.liquidityPools)
      ? patternData.liquidityPools
      : [];

    // Both sides are armed independently: the short needs EQH stops above the
    // range high, the long needs EQL stops below the range low.
    const sides = this.armSides(rangeHigh, rangeLow, atr, liquidityPools);
    if (sides.length === 0) {
      this.logRejection('No EQH/EQL liquidity at range boundaries');
      stats.noEqhEql++;
      return false;
    }

    // The trigger is the just-closed candle. `candles15m` is chronological and
    // the router runs on confirmed closes, so this is the bar that printed the
    // SFP — never a stale one from earlier in the session.
    const candle = candles15m[candles15m.length - 1];
    const sweeps = this.findSweeps(candle, sides);
    if (sweeps.length === 0) {
      this.logRejection(
        `Range boundaries not swept by the last closed candle (no ${sides
          .map((s) => s.direction === 'BEARISH' ? 'EQH' : 'EQL')
          .join('/')} turtle soup)`,
      );
      stats.noSweep++;
      return false;
    }

    // One bar can clear both boundaries. The deeper penetration took the real
    // liquidity, so it is evaluated first; the shallower side is the fallback.
    sweeps.sort((a, b) => b.penetration.comparedTo(a.penetration));

    const minWickRatio =
      this.config.smcSweepMinWickRatio instanceof Decimal &&
      this.config.smcSweepMinWickRatio.gt(0)
        ? this.config.smcSweepMinWickRatio
        : DEFAULT_MIN_WICK_RATIO;

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];

    for (const sfp of sweeps) {
      const plan = this.resolvePlan(
        sfp,
        patternData,
        zones,
        rangeHigh,
        rangeLow,
        atr,
        minWickRatio,
      );
      if (!plan) continue;

      this.setLevels(plan.levels);
      // There is no entry zone: the fill is the SFP close. The structure anchor is
      // the swept boundary (a SWEEP, never a CHoCH) so the trigger that produced
      // this trade is recorded for mitigation bookkeeping.
      this.setStructureDetails({
        type: 'SWEEP',
        timestamp: Number(sfp.candle.timestamp),
        price: sfp.side.sweptLevel,
        direction: plan.direction,
      });
      this.setReason(plan.reason);
      return true;
    }

    this.reportFailure(stats);
    return false;
  }

  /**
   * Resolve one turtle soup end-to-end. Nothing is written to the scenario state
   * until the body close, the rejection wick and the structural target validate.
   */
  private resolvePlan(
    sfp: SfpEvent,
    patternData: any,
    zones: any[],
    rangeHigh: Decimal,
    rangeLow: Decimal,
    atr: Decimal,
    minWickRatio: Decimal,
  ): TurtleSoupPlan | null {
    const direction = sfp.side.direction;
    const isShort = direction === 'BEARISH';
    const candle = sfp.candle;

    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    const open = new Decimal(candle.open);
    const close = new Decimal(candle.close);

    // --- GATE 1: the breakout failed — the body closes strictly back inside ---
    // A close outside the range is acceptance of the new price, not a sweep. This
    // gate is measured against the RANGE boundary, not the EQH/EQL level: closing
    // above the range high but below a slightly higher EQH is still a breakout.
    const closedInside = close.lt(rangeHigh) && close.gt(rangeLow);
    if (!closedInside) {
      this.fail(
        'bodyClose',
        `${isShort ? 'Range High' : 'Range Low'} SFP closed outside the range ` +
          `(${close.toFixed(4)} not inside ${rangeLow.toFixed(4)}..${rangeHigh.toFixed(4)})`,
        1,
      );
      return null;
    }

    // --- GATE 2: rejection-wick quality ---
    // Share of the candle's total range taken by the wick that rejected the level.
    const candleRange = high.minus(low);
    if (!candleRange.gt(0)) {
      this.fail('weakWick', 'SFP candle has zero range', 2);
      return null;
    }
    const wick = isShort
      ? high.minus(Decimal.max(open, close))
      : Decimal.min(open, close).minus(low);
    const wickRatio = wick.div(candleRange);
    if (wickRatio.lt(minWickRatio)) {
      this.fail(
        'weakWick',
        `${isShort ? 'Upper' : 'Lower'} rejection wick ${wickRatio.mul(100).toFixed(1)}% ` +
          `< ${minWickRatio.mul(100).toString()}% of the SFP candle range`,
        2,
      );
      return null;
    }

    // --- GATE 3: stop geometry, then the structural target ---
    // The whole SFP candle is the invalidation: the wick that took the liquidity
    // is the last place the level was defended. `calculateLevels()` adds the
    // ATR / 0.1% offset on top of it (Invariant 11).
    const entry = close;
    const stopZone = {
      top: high,
      bottom: low,
      direction,
    };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(entry, stopZone, direction, atr, new Decimal(1));

    // The resolver sees the range equilibrium, the opposing EQH/EQL cluster and
    // any session extreme / opposing zone. `skipMinorObstacles: false` — the
    // nearest obstacle is a hard wall. If it leaves less than
    // DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
    const resolution = resolveTakeProfit({
      direction,
      entry: base.entry,
      stopLoss: base.stopLoss,
      zones,
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
      skipMinorObstacles: false,
    });

    if (!resolution.ok) {
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 3);
      return null;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      stopZone,
      direction,
      atr,
      resolution.takeProfit,
    );

    const sideLabel = isShort ? 'Range High' : 'Range Low';
    const poolLabel = isShort ? 'EQH' : 'EQL';
    return {
      direction,
      sfp,
      levels,
      reason:
        `Turtle Soup (${isShort ? 'Short' : 'Long'}): ${sideLabel} SFP ` +
        `@ ${sfp.side.sweptLevel.toFixed(4)} (${poolLabel} ${sfp.side.pool.toFixed(4)}), ` +
        `close inside at ${entry.toFixed(4)}, ` +
        `TP ${resolution.source} @ ${resolution.takeProfit.toFixed(4)}`,
    };
  }

  /**
   * Arm each side of the range that has a qualifying equal-highs / equal-lows
   * cluster behind it. The sweep level is the further of the boundary and its
   * cluster, so a wick must take both before the side counts as swept.
   */
  private armSides(
    rangeHigh: Decimal,
    rangeLow: Decimal,
    atr: Decimal,
    liquidityPools: any[],
  ): ArmedSide[] {
    const sides: ArmedSide[] = [];

    const eqh = this.findCluster(liquidityPools, 'EQH', rangeHigh, atr, 'max');
    if (eqh) {
      sides.push({
        direction: 'BEARISH',
        boundary: rangeHigh,
        pool: eqh,
        sweptLevel: Decimal.max(rangeHigh, eqh),
      });
    }

    const eql = this.findCluster(liquidityPools, 'EQL', rangeLow, atr, 'min');
    if (eql) {
      sides.push({
        direction: 'BULLISH',
        boundary: rangeLow,
        pool: eql,
        sweptLevel: Decimal.min(rangeLow, eql),
      });
    }

    return sides;
  }

  /**
   * The furthest qualifying cluster for one boundary.
   *
   * When several equal highs sit inside the tolerance band, the HIGHEST one holds
   * the real stop stack (and the lowest one the least), so the strictest level
   * wins: nothing is assumed swept until every cluster at that boundary is taken.
   */
  private findCluster(
    liquidityPools: any[],
    type: 'EQH' | 'EQL',
    boundary: Decimal,
    atr: Decimal,
    pick: 'max' | 'min',
  ): Decimal | null {
    const tolerance = Decimal.max(
      boundary.mul(EQ_TOLERANCE_MIN_PCT),
      atr.mul(EQ_TOLERANCE_ATR_MULTIPLIER),
    );

    let best: Decimal | null = null;
    for (const pool of liquidityPools) {
      if (!pool || pool.type !== type) continue;
      if (pool.isTaken === true) continue;
      const price = pool.priceLevel;
      if (!(price instanceof Decimal) || !price.isFinite() || price.lte(0)) continue;
      if (price.minus(boundary).abs().gt(tolerance)) continue;
      if (best === null) {
        best = price;
        continue;
      }
      best = pick === 'max' ? Decimal.max(best, price) : Decimal.min(best, price);
    }
    return best;
  }

  /**
   * Which armed sides the last closed candle actually swept.
   *
   * A side is swept only when the wick trades THROUGH `sweptLevel` — a candle
   * that stops short of the cluster took nothing. ATR tolerance is deliberately
   * absent: proximity is not penetration.
   */
  private findSweeps(candle: any, sides: ArmedSide[]): SfpEvent[] {
    if (!candle) return [];
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    const events: SfpEvent[] = [];

    for (const side of sides) {
      if (side.direction === 'BEARISH') {
        if (!high.gt(side.sweptLevel)) continue;
        events.push({ side, candle, penetration: high.minus(side.sweptLevel) });
      } else {
        if (!low.lt(side.sweptLevel)) continue;
        events.push({ side, candle, penetration: side.sweptLevel.minus(low) });
      }
    }

    return events;
  }

  /** Killzone gate: London/NY only, bypassable via ENFORCE_KILLZONES=false. */
  private passesKillzone(patternData: any): boolean {
    if (this.config.enforceKillzones === false) return true;
    const killzone = patternData.currentKillzone;
    return killzone === 'LONDON' || killzone === 'NY';
  }

  /**
   * Keep the DEEPEST rejection, not the first one.
   *
   * Reported bucket describes how far the chain got, not which gate happened to be
   * evaluated first.
   */
  private fail(kind: FailureKind, reason: string, stage: number): void {
    if (this.failure && this.failure.stage >= stage) return;
    this.failure = { kind, reason, stage };
  }

  /** Emit the deepest rejection of this evaluation and bump its counter. */
  private reportFailure(stats: Scenario9Stats): void {
    const failure = this.failure;
    if (!failure) {
      this.logRejection('No valid Turtle Soup setup');
      return;
    }
    this.logRejection(failure.reason);
    if (failure.kind !== 'none') stats[failure.kind]++;
  }

  /**
   * Clear the per-evaluation failure.
   *
   * Kept behind a method so the compiler does not narrow `this.failure` to `null`
   * for the rest of `evaluateInternal()` — calls to `fail()` mutate it through a
   * different frame, which intra-procedural flow analysis cannot see.
   */
  private resetFailure(): void {
    this.failure = null;
  }
}
