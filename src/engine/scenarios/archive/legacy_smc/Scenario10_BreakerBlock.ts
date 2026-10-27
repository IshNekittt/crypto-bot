import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/**
 * The broken block must be recent. A breaker is the failure of a block the market
 * is still trading against; a block from three days ago was already absorbed by
 * the trend it belonged to and cannot trap anybody.
 */
const OB_FRESHNESS_MS = 24 * 60 * 60 * 1000;
/**
 * The retest must follow the break closely. Breakers decay fast: once price has
 * run away from the broken block, the trapped inventory has been worked off and
 * the "retest" is just a new trend leg.
 */
const RETEST_WINDOW_MS = 4 * 60 * 60 * 1000;
/** Displacement floor for the break (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/**
 * Displacement FVG tolerance around the break candle, measured in LTF candles.
 * `detectFVGs()` stamps the gap with its FIRST candle and the gap is only complete
 * on `c3` (AGENTS.md §8.1), so the completion bar is compared, not the stamp.
 */
const FVG_WINDOW_CANDLES = 1;
/** Freshest break candidates walked before giving up (newest first). */
const MAX_BREAK_CANDIDATES = 6;
/** Fallback LTF spacing when the candle series is too short to measure. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

/** Fully validated breaker setup. Setters run only for a plan. */
interface BreakerPlan {
  readonly direction: Direction;
  readonly breakEvent: any;
  readonly brokenOb: any;
  readonly retestCandle: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario10Stats {
  totalEvals: number;
  noData: number;
  killzone: number;
  noBreak: number;
  bodyClose: number;
  displacement: number;
  noBrokenOb: number;
  obNotFresh: number;
  noLiquiditySweep: number;
  noFvg: number;
  noRetest: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noBrokenOb'
  | 'obNotFresh'
  | 'bodyClose'
  | 'displacement'
  | 'noLiquiditySweep'
  | 'noFvg'
  | 'noRetest'
  | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 10 — Breaker Block.
 *
 * An order block that fails. Price sweeps the stops resting beyond the block,
 * then closes through it with displacement — the traders who defended the block
 * are trapped, and their exit orders become the fuel for the mirror move. The
 * trade is the retest of the failed block from the other side.
 *
 * Causal contract:
 *  1. Everything is 15m. A 4H break cannot validate a 15m breaker, and a 4H block
 *     cannot be "retested" by a 15m candle in any meaningful sense. The legacy
 *     code filtered the break but left `zones` unfiltered, so the broken block was
 *     routinely HTF.
 *  2. The broken block exists BEFORE the break: `ob.timestamp < break.timestamp`.
 *     Without the strict inequality an OB created *by* the break is eligible to be
 *     the block the break broke, which is a causality inversion — hence the funnel
 *     separates `noBrokenOb` (nothing was cleared) from `obNotFresh` (something was
 *     cleared, but too long ago).
 *  3. The break is a BOS, not a CHoCH. A CHoCH is a reversal whose own retest is a
 *     continuation entry; the breaker requires the block to have been broken
 *     AGAINST its direction as a continuation event.
 *  4. The block's far extreme must have acted as liquidity: price wicked beyond it
 *     and closed back on the origin side before the break. Without that grab the
 *     "breaker" is an ordinary continuation break with nobody trapped.
 *  5. The retest is the candle that just closed — a later candle, inside 4h of the
 *     break, whose wick trades into the mirrored block and whose body holds on the
 *     post-break side of it.
 *  6. The target comes from the structural resolver. `skipMinorObstacles: false`
 *     keeps the nearest obstacle a hard wall: if it leaves less than
 *     DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
 *
 * Removed legacy logic:
 *  - `wasObExtremeLiquiditySwept()` rebuilt swing points with a nested 50-candle
 *    scan on every evaluation (O(n^2) per call) and matched them by index into a
 *    sliced array. The grab test is now a single linear pass over the candles
 *    between the block and the break, and it measures the same thing: the extreme
 *    was taken and rejected.
 *  - The hardcoded `2R` target, which was a restatement of the stop distance.
 *  - Zone ordering was assumed (`z.top` as a breaker top). It is not guaranteed
 *    (Invariant 11); both edges are normalised through `Decimal.min/max`.
 */
export class Scenario10_BreakerBlock extends BaseScenario {
  /** Deepest rejection of the chain — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario10Stats = {
    totalEvals: 0,
    noData: 0,
    killzone: 0,
    noBreak: 0,
    bodyClose: 0,
    displacement: 0,
    noBrokenOb: 0,
    obNotFresh: 0,
    noLiquiditySweep: 0,
    noFvg: 0,
    noRetest: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(10, 'Breaker Block Entry', config);
  }

  static getRejectionStats(): Scenario10Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      noData: 0,
      killzone: 0,
      noBreak: 0,
      bodyClose: 0,
      displacement: 0,
      noBrokenOb: 0,
      obNotFresh: 0,
      noLiquiditySweep: 0,
      noFvg: 0,
      noRetest: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario10_BreakerBlock.stats;
    stats.totalEvals++;
    this.resetFailure();

    if (!this.passesKillzone(patternData)) {
      this.logRejection('Breaker Block requires London or NY killzone');
      stats.killzone++;
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];

    if (candles15m.length === 0 || structures.length === 0 || zones.length === 0) {
      this.logRejection('Missing 15m candles, structures or zones');
      stats.noData++;
      return false;
    }

    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);

    // BOS only: a 15m CHoCH is a reversal, and a breaker is the failure of a block
    // in the direction of the prevailing push.
    const breakCandidates = structures
      .filter(
        (s: any) =>
          s?.type === 'BOS' &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          (s.direction === 'BULLISH' || s.direction === 'BEARISH') &&
          Number.isFinite(Number(s.timestamp)) &&
          Number(s.timestamp) <= lastTimestamp,
      )
      .sort((a: any, b: any) => Number(b.timestamp) - Number(a.timestamp))
      .slice(0, MAX_BREAK_CANDIDATES);

    if (breakCandidates.length === 0) {
      this.logRejection('No 15m BOS detected (no break event to build a breaker from)');
      stats.noBreak++;
      return false;
    }

    const ltfMs = this.resolveCandleMs(candles15m);

    for (const breakEvent of breakCandidates) {
      const plan = this.resolvePlan(
        breakEvent,
        patternData,
        candles15m,
        zones,
        ltfMs,
        lastTimestamp,
      );
      if (!plan) continue;

      const obTop = Decimal.max(
        new Decimal(plan.brokenOb.top),
        new Decimal(plan.brokenOb.bottom),
      );
      const obBottom = Decimal.min(
        new Decimal(plan.brokenOb.top),
        new Decimal(plan.brokenOb.bottom),
      );

      this.setLevels(plan.levels);
      // The zone burned for mitigation is the ORIGINAL block, with its original
      // direction: that is the object the recognizer will emit again on a later
      // evaluation, so it is the only shape `filterMitigatedZones()` can match.
      this.setZoneDetails({
        type: 'OB',
        top: obTop,
        bottom: obBottom,
        timeframe: ENTRY_TIMEFRAME,
        direction: plan.brokenOb.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH',
        timestamp: Number(plan.brokenOb.timestamp),
      });
      this.setStructureDetails({
        type: 'BOS',
        timestamp: Number(plan.breakEvent.timestamp),
        price: new Decimal(plan.breakEvent.price),
        direction: plan.direction,
      });
      this.setReason(plan.reason);
      return true;
    }

    this.reportFailure(stats);
    return false;
  }

  /**
   * Resolve one breaker end-to-end. Nothing is written to the scenario state until
   * the causality, the grab, the displacement gap and the retest all validate.
   */
  private resolvePlan(
    breakEvent: any,
    patternData: any,
    candles15m: any[],
    zones: any[],
    ltfMs: number,
    lastTimestamp: number,
  ): BreakerPlan | null {
    const direction: Direction =
      breakEvent.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
    const isLong = direction === 'BULLISH';
    const breakTimestamp = Number(breakEvent.timestamp);
    const breakPrice = new Decimal(breakEvent.price);

    // --- GATE 1: the break itself must be a validated, impulsive body close ---
    if (!this.isValidBodyClose(breakEvent)) {
      this.fail('bodyClose', 'Break not validated (wick only, no body close through)', 2);
      return null;
    }
    if (!this.isValidDisplacement(breakEvent, DISPLACEMENT_MULTIPLIER)) {
      this.fail(
        'displacement',
        `Break displaced < ${DISPLACEMENT_MULTIPLIER} ATR`,
        2,
      );
      return null;
    }

    // --- GATE 2: the block the break cleared, strictly before the break ---
    // The block is on the OPPOSITE side: a bullish break clears supply (BEARISH
    // OB), a bearish break clears demand (BULLISH OB).
    const obDirection: Direction = isLong ? 'BEARISH' : 'BULLISH';
    const brokenObCandidates = zones
      .filter(
        (z: any) =>
          z?.type === 'OB' &&
          z.direction === obDirection &&
          String(z.timeframe) === ENTRY_TIMEFRAME &&
          z.mitigated !== true &&
          z.top instanceof Decimal &&
          z.bottom instanceof Decimal &&
          z.top.isFinite() &&
          z.bottom.isFinite() &&
          Decimal.max(z.top, z.bottom).gt(Decimal.min(z.top, z.bottom)) &&
          Number(z.timestamp) < breakTimestamp &&
          // Causality of the break itself: the close must clear the WHOLE block,
          // not just its near edge, otherwise the block was never broken.
          (isLong
            ? breakPrice.gt(Decimal.max(z.top, z.bottom))
            : breakPrice.lt(Decimal.min(z.top, z.bottom))),
      )
      .sort((a: any, b: any) => Number(b.timestamp) - Number(a.timestamp));

    const brokenOb = brokenObCandidates[0];
    if (!brokenOb) {
      this.fail(
        'noBrokenOb',
        `No 15m ${obDirection} OB formed strictly before the break that the ` +
          `${direction} close cleared`,
        3,
      );
      return null;
    }

    // --- GATE 3: the block must still be fresh ---
    if (breakTimestamp - Number(brokenOb.timestamp) > OB_FRESHNESS_MS) {
      this.fail(
        'obNotFresh',
        `Broken ${obDirection} OB is older than ${OB_FRESHNESS_MS / 3_600_000}h — ` +
          'no longer the block this leg failed on',
        4,
      );
      return null;
    }

    const obTop = Decimal.max(new Decimal(brokenOb.top), new Decimal(brokenOb.bottom));
    const obBottom = Decimal.min(new Decimal(brokenOb.top), new Decimal(brokenOb.bottom));

    // --- GATE 4: the block's far extreme had to be liquidity ---
    // Post-break side extreme: the top of a broken supply block, the bottom of a
    // broken demand block. Price must have run those stops and rejected before it
    // closed through the block.
    if (
      !this.wasObExtremeLiquiditySwept(
        candles15m,
        Number(brokenOb.timestamp),
        breakTimestamp,
        isLong ? obTop : obBottom,
        isLong ? 'ABOVE' : 'BELOW',
      )
    ) {
      this.fail(
        'noLiquiditySweep',
        `Broken ${obDirection} OB extreme (${(isLong ? obTop : obBottom).toFixed(4)}) ` +
          'was never swept and rejected before the break — not a breaker',
        5,
      );
      return null;
    }

    // --- GATE 5: displacement gap at the break ---
    const hasFvg = zones.some((z: any) => {
      if (z?.type !== 'FVG' || z.direction !== direction) return false;
      if (String(z.timeframe) !== ENTRY_TIMEFRAME) return false;
      const stamp = Number(z.timestamp);
      if (!Number.isFinite(stamp)) return false;
      // `c1` stamp + 2 candles = the completion bar (AGENTS.md §8.1).
      const completion = stamp + 2 * ltfMs;
      return Math.abs(completion - breakTimestamp) <= FVG_WINDOW_CANDLES * ltfMs;
    });

    if (!hasFvg) {
      this.fail(
        'noFvg',
        `No 15m ${direction} displacement FVG at the break candle (impulse unconfirmed)`,
        6,
      );
      return null;
    }

    // --- GATE 6: the retest is the candle that just closed ---
    const retestCandle = candles15m[candles15m.length - 1];
    if (lastTimestamp <= breakTimestamp) {
      this.fail(
        'noRetest',
        'Entry is only valid on a candle AFTER the break candle closes',
        7,
      );
      return null;
    }
    if (lastTimestamp > breakTimestamp + RETEST_WINDOW_MS) {
      this.fail(
        'noRetest',
        `Retest arrived later than ${RETEST_WINDOW_MS / 3_600_000}h after the break — breaker expired`,
        7,
      );
      return null;
    }

    const retestHigh = new Decimal(retestCandle.high);
    const retestLow = new Decimal(retestCandle.low);
    const retestClose = new Decimal(retestCandle.close);

    // Mirror test: the wick trades into the failed block, the body holds on the
    // post-break side of it. A close back through the block would mean the break
    // failed, which is the opposite trade.
    const testingBreaker = isLong
      ? retestLow.lte(obTop) && retestClose.gte(obBottom)
      : retestHigh.gte(obBottom) && retestClose.lte(obTop);

    if (!testingBreaker) {
      this.fail(
        'noRetest',
        `Retest candle did not test the mirrored breaker zone ${obBottom.toFixed(4)}..${obTop.toFixed(4)} ` +
          '(wick in, body holding)',
        7,
      );
      return null;
    }

    // --- GATE 7: stop geometry, then the structural target ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    const entry = obTop.plus(obBottom).dividedBy(2);

    // The block edge is the invalidation, widened by the retest wick: if the
    // retest already traded below/above the edge, that wick is part of the entry
    // and a stop inside it would be taken out by the entry itself.
    const stopZone = isLong
      ? { top: obTop, bottom: Decimal.min(obBottom, retestLow), direction }
      : { top: Decimal.max(obTop, retestHigh), bottom: obBottom, direction };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(entry, stopZone, direction, atr, new Decimal(1));

    // `skipMinorObstacles: false` — the nearest obstacle is a hard wall. If it
    // leaves less than DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
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
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 8);
      return null;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      stopZone,
      direction,
      atr,
      resolution.takeProfit,
    );

    return {
      direction,
      breakEvent,
      brokenOb,
      retestCandle,
      levels,
      reason:
        `Breaker Block (${isLong ? 'Long' : 'Short'}): 15m ${obDirection} OB ` +
        `${obBottom.toFixed(4)}..${obTop.toFixed(4)} swept and broken by ${direction} BOS ` +
        `@ ${breakPrice.toFixed(4)} + displacement FVG + 0.5 retest, ` +
        `TP ${resolution.source} @ ${resolution.takeProfit.toFixed(4)}`,
    };
  }

  /**
   * Did the block's far extreme act as a liquidity pool before the break?
   *
   * A breaker is a FAILED block: price had to run the stops resting beyond the
   * block and reject, and only then close through it. Without the grab the broken
   * block is a routine continuation and nobody is trapped.
   *
   * Linear by construction: the callers bound the interval through
   * `OB_FRESHNESS_MS`, so this never walks more than the freshness window.
   */
  private wasObExtremeLiquiditySwept(
    candles15m: any[],
    obTimestamp: number,
    breakTimestamp: number,
    extreme: Decimal,
    side: 'ABOVE' | 'BELOW',
  ): boolean {
    for (const candle of candles15m) {
      const timestamp = Number(candle?.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp <= obTimestamp || timestamp >= breakTimestamp) continue;

      const close = new Decimal(candle.close);
      if (side === 'ABOVE') {
        // Wick above the block top, body back below it.
        if (new Decimal(candle.high).gt(extreme) && close.lt(extreme)) return true;
      } else {
        // Wick below the block bottom, body back above it.
        if (new Decimal(candle.low).lt(extreme) && close.gt(extreme)) return true;
      }
    }
    return false;
  }

  /** Killzone gate: London/NY only, bypassable via ENFORCE_KILLZONES=false. */
  private passesKillzone(patternData: any): boolean {
    if (this.config.enforceKillzones === false) return true;
    const killzone = patternData.currentKillzone;
    return killzone === 'LONDON' || killzone === 'NY';
  }

  /** Candle spacing of the entry series, in milliseconds (Invariant 12). */
  private resolveCandleMs(candles: any[]): number {
    const start = Math.max(1, candles.length - 5);
    for (let i = start; i < candles.length; i++) {
      const delta = Number(candles[i].timestamp) - Number(candles[i - 1].timestamp);
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
    return DEFAULT_LTF_MS;
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
  private reportFailure(stats: Scenario10Stats): void {
    const failure = this.failure;
    if (!failure) {
      this.logRejection('No valid breaker block setup');
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
