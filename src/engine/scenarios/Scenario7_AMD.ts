import { BaseScenario, TradeLevels } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/** Manipulation window: the sweep must sit inside the last 8 LTF candles (2h at 15m). */
const SWEEP_WINDOW_CANDLES = 8;
/** Causality budget after the sweep: 32 LTF candles (8h at 15m). */
const CAUSALITY_WINDOW_CANDLES = 32;
/** Displacement floor for the confirming CHoCH (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/**
 * Accumulation quality gate: an Asian range wider than 3 x ATR(4H) is a trend,
 * not a coil. There is no single pool of resting liquidity to manipulate and
 * then distribute from, so AMD does not apply.
 */
const ASIAN_RANGE_MAX_ATR4H = new Decimal(3);
/** Fallback LTF spacing when the candle series is too short to measure. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

/** A confirmed session-extreme sweep (the manipulation leg). */
interface SweepEvent {
  /** Trade direction implied by the swept side. */
  readonly direction: Direction;
  /** The session extreme that was taken (Asian low → long, Asian high → short). */
  readonly level: Decimal;
  /** The SFP candle that took the level and closed back inside it. */
  readonly candle: any;
}

/** Fully validated AMD chain. Setters are applied only for a plan. */
interface AmdPlan {
  readonly direction: Direction;
  readonly fvg: any;
  readonly choch: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario7Stats {
  totalEvals: number;
  killzone: number;
  noAsianRange: number;
  asianRangeTooWide: number;
  noSweep: number;
  noChoch: number;
  displacement: number;
  noFvg: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noChoch'
  | 'displacement'
  | 'noFvg'
  | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 7 — AMD (Accumulation, Manipulation, Distribution).
 *
 * The Asian session builds a coil. The London/NY open manipulates one extreme of
 * that coil to harvest the stops resting there, then distributes to the other
 * extreme. The trade is the reversal AFTER the manipulation, not the breakout.
 *
 * Causal contract:
 *  1. Direction comes from the swept side, never from a hardcoded long. Sweeping
 *     the Asian LOW feeds a long that distributes to the Asian HIGH; sweeping the
 *     Asian HIGH feeds a short that distributes to the Asian LOW.
 *  2. The sweep is the NEWEST one inside the manipulation window. `candles15m` is
 *     chronological, so the scan runs backwards and stops on the first hit: a
 *     forward scan anchors on the oldest sweep and lets a CHoCH that printed
 *     before a fresher manipulation validate a dead leg.
 *  3. A sweep is an SFP: the wick pierces the session extreme and the BODY closes
 *     back on the correct side of it (AGENTS.md §7.1). Trading beyond a level is
 *     acceptance, not manipulation; the reclaim is what proves absorption.
 *  4. The confirming CHoCH must print AT or AFTER the sweep (a CHoCH that formed
 *     before the manipulation describes the previous leg) and inside the 8h
 *     causality window, with >= 1.5 ATR displacement.
 *  5. The entry POI is the equilibrium (0.5) of the freshest 15m FVG printed at or
 *     after that CHoCH.
 *
 * Removed legacy logic:
 *  - The manual `levels.takeProfit = asianHigh / asianLow` override. It bypassed
 *    the structural resolver and could silently rewrite the geometry. The opposing
 *    Asian extreme is now handed to `resolveTakeProfit()` as a SESSION_RANGE
 *    candidate, and `skipMinorObstacles: false` keeps the nearest obstacle a hard
 *    wall: if it leaves less than DYNAMIC_TP_MIN_RR the setup is rejected, never
 *    clamped to a boundary the market has already invalidated.
 *  - The ATR-wide "sweep tolerance" that accepted candles which never actually
 *    pierced the level (`low < asianLow + 2*ATR`). A manipulation must take the
 *    liquidity; a candle that stops two ATR short of it took nothing.
 */
export class Scenario7_AMD extends BaseScenario {
  /** Deepest rejection of the chain — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario7Stats = {
    totalEvals: 0,
    killzone: 0,
    noAsianRange: 0,
    asianRangeTooWide: 0,
    noSweep: 0,
    noChoch: 0,
    displacement: 0,
    noFvg: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(7, 'AMD (Accumulation-Manipulation-Distribution)', config);
  }

  static getRejectionStats(): Scenario7Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noAsianRange: 0,
      asianRangeTooWide: 0,
      noSweep: 0,
      noChoch: 0,
      displacement: 0,
      noFvg: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario7_AMD.stats;
    stats.totalEvals++;
    this.resetFailure();

    // AMD trades the London/NY manipulation and distribution phases. The Asian
    // session itself is accumulation — there is nothing to reverse inside it.
    if (!this.passesKillzone(patternData)) {
      this.logRejection('AMD requires London or NY killzone (Manipulation/Distribution phase)');
      stats.killzone++;
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    const sessionRanges: any[] = Array.isArray(patternData.sessionRanges)
      ? patternData.sessionRanges
      : [];

    // Freshest Asian range: `detectSessionRanges()` returns up to two days,
    // chronological, and today's coil is the only one still being distributed.
    const asianRange = [...sessionRanges]
      .reverse()
      .find(
        (r: any) =>
          r?.name === 'ASIAN' &&
          r.high instanceof Decimal &&
          r.low instanceof Decimal &&
          r.high.gt(r.low),
      );

    if (candles15m.length === 0 || !asianRange) {
      this.logRejection('No Asian Range detected');
      stats.noAsianRange++;
      return false;
    }

    const asianHigh = new Decimal(asianRange.high);
    const asianLow = new Decimal(asianRange.low);

    const atr4h =
      patternData.atr4h instanceof Decimal && patternData.atr4h.gt(0)
        ? patternData.atr4h
        : new Decimal('0.01');
    const asianRangeHeight = asianHigh.minus(asianLow);
    const maxAllowedHeight = atr4h.mul(ASIAN_RANGE_MAX_ATR4H);
    if (asianRangeHeight.gt(maxAllowedHeight)) {
      this.logRejection(
        `Asian Range too wide for accumulation: ${asianRangeHeight.toFixed(2)} > 3.0*ATR4H (${maxAllowedHeight.toFixed(2)})`,
      );
      stats.asianRangeTooWide++;
      return false;
    }

    const sweep = this.findFreshestSweep(candles15m, asianLow, asianHigh, Number(asianRange.end));
    if (!sweep) {
      this.logRejection(
        `Asian range extremes not swept in the last ${SWEEP_WINDOW_CANDLES} candles (no SFP manipulation)`,
      );
      stats.noSweep++;
      return false;
    }

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];
    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const ltfMs = this.resolveCandleMs(candles15m);

    const plan = this.resolvePlan(sweep, patternData, zones, structures, asianRange, ltfMs);
    if (!plan) {
      this.reportFailure(stats);
      return false;
    }

    // Zone top/bottom ordering is not guaranteed (Invariant 11).
    const fvgTop = Decimal.max(new Decimal(plan.fvg.top), new Decimal(plan.fvg.bottom));
    const fvgBottom = Decimal.min(new Decimal(plan.fvg.top), new Decimal(plan.fvg.bottom));

    this.setLevels(plan.levels);
    this.setZoneDetails({
      type: 'FVG',
      top: fvgTop,
      bottom: fvgBottom,
      timeframe: ENTRY_TIMEFRAME,
      direction: plan.direction,
      timestamp: Number(plan.fvg.timestamp),
    });
    // The CHoCH is the confirmation that must never be re-used: burning it blocks
    // a re-entry on the same distribution leg (Invariant 25 — timestamp identity).
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: Number(plan.choch.timestamp),
      price: new Decimal(plan.choch.price),
      direction: plan.direction,
    });
    this.setReason(plan.reason);
    return true;
  }

  /**
   * Resolve one AMD chain end-to-end. Nothing is written to the scenario state
   * until the CHoCH, the entry POI and the structural target have all validated.
   */
  private resolvePlan(
    sweep: SweepEvent,
    patternData: any,
    zones: any[],
    structures: any[],
    asianRange: any,
    ltfMs: number,
  ): AmdPlan | null {
    const direction = sweep.direction;
    const candles15m: any[] = patternData.candles15m;
    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);
    const sweepTimestamp = Number(sweep.candle.timestamp);
    const windowEnd = sweepTimestamp + CAUSALITY_WINDOW_CANDLES * ltfMs;

    // --- GATE 1: the CHoCH confirms the manipulation, so it cannot precede it ---
    const chochs = structures
      .filter(
        (s: any) =>
          s.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= sweepTimestamp &&
          Number(s.timestamp) <= windowEnd &&
          Number(s.timestamp) <= lastTimestamp,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochs[chochs.length - 1];
    if (!choch) {
      this.fail(
        'noChoch',
        `No 15m ${direction} CHoCH at or after the Asian ${direction === 'BULLISH' ? 'low' : 'high'} sweep`,
        1,
      );
      return null;
    }

    if (!this.isValidDisplacement(choch, DISPLACEMENT_MULTIPLIER)) {
      this.fail('displacement', 'CHoCH after Asian sweep displacement < 1.5 ATR', 2);
      return null;
    }

    // --- GATE 2: the entry POI printed with/after the confirming break ---
    const fvgs = zones
      .filter(
        (z: any) =>
          z.type === 'FVG' &&
          z.direction === direction &&
          String(z.timeframe) === ENTRY_TIMEFRAME &&
          Number(z.timestamp) >= Number(choch.timestamp) &&
          Number(z.timestamp) <= windowEnd &&
          Number(z.timestamp) <= lastTimestamp &&
          z.top instanceof Decimal &&
          z.bottom instanceof Decimal &&
          z.top.gt(z.bottom),
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const fvg = fvgs[fvgs.length - 1];
    if (!fvg) {
      this.fail('noFvg', `No 15m ${direction} FVG after the CHoCH to define the entry POI`, 3);
      return null;
    }

    const fvgTop = new Decimal(fvg.top);
    const fvgBottom = new Decimal(fvg.bottom);
    const entry = fvgTop.plus(fvgBottom).dividedBy(2);

    // --- GATE 3: stop geometry, then the structural target ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // The stop must sit beyond the manipulation wick: that wick IS the thesis. A
    // stop tucked inside the swept range is taken out by the retest of the very
    // level the setup was built on. The entry candle's own wick is included too —
    // a POI the current bar already pierced is part of the entry, not a level the
    // position may be stopped by later.
    const sweepExtreme =
      direction === 'BULLISH'
        ? new Decimal(sweep.candle.low)
        : new Decimal(sweep.candle.high);
    const stopZone =
      direction === 'BULLISH'
        ? {
            top: fvgTop,
            bottom: Decimal.min(fvgBottom, sweepExtreme, new Decimal(last.low)),
            direction,
          }
        : {
            top: Decimal.max(fvgTop, sweepExtreme, new Decimal(last.high)),
            bottom: fvgBottom,
            direction,
          };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(entry, stopZone, direction, atr, new Decimal(1));

    // The opposing Asian extreme is injected as a SESSION_RANGE candidate by
    // passing the accumulation range itself, so the distribution target is a
    // structural fact rather than a post-hoc clamp.
    //
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
      sessionRanges: [asianRange],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
      skipMinorObstacles: false,
    });

    if (!resolution.ok) {
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 4);
      return null;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      stopZone,
      direction,
      atr,
      resolution.takeProfit,
    );

    const sweptSide = direction === 'BULLISH' ? 'low' : 'high';
    return {
      direction,
      fvg,
      choch,
      levels,
      reason:
        `AMD: Asian ${sweptSide} swept (${sweep.level.toFixed(4)}) + 15m ${direction} CHoCH + ` +
        `FVG 0.5 entry, TP ${resolution.source} @ ${resolution.takeProfit.toFixed(4)}`,
    };
  }

  /**
   * The freshest SFP inside the manipulation window.
   *
   * Newest → oldest is mandatory: the trade is the reversal of the LATEST
   * manipulation. A CHoCH that confirms an older sweep is already spent once a
   * fresher sweep has printed on top of it.
   *
   * A candle is an SFP only when the wick closes beyond the session extreme and
   * the body finishes back on the correct side of it. If one bar takes both
   * extremes (outside bar) the deeper penetration names the side — deterministic,
   * and the shallower side was never the real liquidity draw.
   */
  private findFreshestSweep(
    candles: any[],
    asianLow: Decimal,
    asianHigh: Decimal,
    sessionEnd: number,
  ): SweepEvent | null {
    const window = Math.min(SWEEP_WINDOW_CANDLES, candles.length);

    for (let i = candles.length - 1; i >= candles.length - window; i--) {
      const candle = candles[i];
      const timestamp = Number(candle.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      // The manipulation must postdate the accumulation window it is sweeping.
      if (Number.isFinite(sessionEnd) && sessionEnd > 0 && timestamp <= sessionEnd) {
        continue;
      }

      const high = new Decimal(candle.high);
      const low = new Decimal(candle.low);
      const close = new Decimal(candle.close);

      const sweptLow = low.lt(asianLow) && close.gt(asianLow);
      const sweptHigh = high.gt(asianHigh) && close.lt(asianHigh);
      if (!sweptLow && !sweptHigh) continue;

      const below = sweptLow ? asianLow.minus(low) : new Decimal(0);
      const above = sweptHigh ? high.minus(asianHigh) : new Decimal(0);
      const direction: Direction =
        sweptLow && (!sweptHigh || below.gte(above)) ? 'BULLISH' : 'BEARISH';

      return {
        direction,
        level: direction === 'BULLISH' ? asianLow : asianHigh,
        candle,
      };
    }

    return null;
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
  private reportFailure(stats: Scenario7Stats): void {
    const failure = this.failure;
    if (!failure) {
      this.logRejection('No valid AMD setup');
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
