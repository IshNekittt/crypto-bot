import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/** "Just below/above": how far the real OB may sit beyond the swept level. */
const PROXIMITY_ATR_MULTIPLIER = new Decimal(2);
const PROXIMITY_MIN_PCT = new Decimal('0.005');

type Direction = 'BULLISH' | 'BEARISH';

/** Fully validated inducement chain. Setters are applied only for a plan. */
interface IdmPlan {
  readonly direction: Direction;
  readonly structure: any;
  readonly sweptLevel: Decimal;
  readonly realOb: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario3Stats {
  totalEvals: number;
  killzone: number;
  noOb: number;
  noStructure: number;
  noSweep: number;
  noRealOb: number;
  proximity: number;
  noObTest: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noSweep'
  | 'noRealOb'
  | 'proximity'
  | 'noObTest'
  | 'tpInvalid';

/** A rejection plus how far down the funnel it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 3 — IDM (Inducement).
 *
 * Handbook §2.3: the first pullback after a structural break is the inducement.
 * It exists to trap early entries, and the real point of interest sits *beyond*
 * it. Price must run the liquidity resting behind that obvious level and only
 * then reach the unmitigated order block that actually absorbs the move.
 *
 * Causal contract:
 *  1. Direction is read from the market, never assumed. A swept structural LOW
 *     (the level a bearish break left behind) can only feed a long; a swept HIGH
 *     can only feed a short.
 *  2. The swept level comes from `patternData.structures`, never from the legacy
 *     `brokenSwing` field — that field is emitted only by the deprecated `smc.ts`
 *     detector, so every production structure lacked it and the scenario could
 *     never fire live.
 *  3. A sweep is a WICK beyond the level plus a BODY back inside it (AGENTS.md
 *     §7.1). Merely trading below a broken low is not a sweep: after a bearish
 *     break price lives there. The reclaim is what proves the level was taken
 *     for liquidity rather than accepted as value.
 *  4. The wick that takes the inducement must reach the real OB in the same bar
 *     — that is the "immediate test". A block the sweep does not touch is not
 *     the destination of this move.
 *  5. The real OB must pre-exist the trigger candle, sit strictly beyond the
 *     swept level, and be close enough that the same wick can reach it.
 */
export class Scenario3_IDM extends BaseScenario {
  /** Deepest rejection of the scan — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario3Stats = {
    totalEvals: 0,
    killzone: 0,
    noOb: 0,
    noStructure: 0,
    noSweep: 0,
    noRealOb: 0,
    proximity: 0,
    noObTest: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(3, 'IDM', config);
  }

  static getRejectionStats(): Scenario3Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noOb: 0,
      noStructure: 0,
      noSweep: 0,
      noRealOb: 0,
      proximity: 0,
      noObTest: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario3_IDM.stats;
    stats.totalEvals++;
    this.resetFailure();

    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      stats.killzone++;
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    if (candles15m.length === 0) {
      this.logRejection('No 15m candle available');
      stats.noOb++;
      return false;
    }

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];
    const ltfObs = zones.filter(
      (z) =>
        z.type === 'OB' &&
        String(z.timeframe) === ENTRY_TIMEFRAME &&
        (z.direction === 'BULLISH' || z.direction === 'BEARISH'),
    );
    if (ltfObs.length === 0) {
      this.logRejection('No 15m Order Block available');
      stats.noOb++;
      return false;
    }

    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);

    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const ltfStructures = structures.filter(
      (s) =>
        (s.type === 'BOS' || s.type === 'CHOCH') &&
        String(s.timeframe) === ENTRY_TIMEFRAME &&
        (s.direction === 'BULLISH' || s.direction === 'BEARISH') &&
        // A level printed by the trigger candle itself is not an inducement:
        // the sweep must be of pre-existing liquidity.
        Number(s.timestamp) < lastTimestamp,
    );
    if (ltfStructures.length === 0) {
      this.logRejection('No 15m structure available to define the inducement');
      stats.noStructure++;
      return false;
    }

    // Freshest structure first: the inducement belongs to the most recent leg.
    const ordered = [...ltfStructures].sort(
      (a, b) => Number(b.timestamp) - Number(a.timestamp),
    );

    for (const structure of ordered) {
      const plan = this.resolvePlan(structure, patternData, zones, ltfObs);
      if (!plan) continue;

      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const obTop = Decimal.max(
        new Decimal(plan.realOb.top),
        new Decimal(plan.realOb.bottom),
      );
      const obBottom = Decimal.min(
        new Decimal(plan.realOb.top),
        new Decimal(plan.realOb.bottom),
      );

      this.setLevels(plan.levels);
      this.setZoneDetails({
        type: 'OB',
        top: obTop,
        bottom: obBottom,
        timeframe: ENTRY_TIMEFRAME,
        direction: plan.direction,
        timestamp: Number(plan.realOb.timestamp),
      });
      // The burn anchor is the TRIGGER candle: that is the event we traded, and
      // its timestamp is unique, so the same inducement cannot be re-entered
      // (Invariant 25 — structures are matched by timestamp only).
      this.setStructureDetails({
        type: 'SWEEP',
        timestamp: lastTimestamp,
        price: plan.sweptLevel,
        direction: plan.direction,
      });
      this.setReason(plan.reason);
      return true;
    }

    const failure = this.failure;
    if (failure) {
      this.logRejection(failure.reason);
      if (failure.kind !== 'none') stats[failure.kind]++;
    } else {
      this.logRejection('No valid IDM setup');
    }
    return false;
  }

  /**
   * Resolve one inducement chain end-to-end.
   *
   * A structure's `price` is the swing level its break consumed: a bearish break
   * leaves a LOW behind, a bullish break leaves a HIGH. That level is exactly
   * the obvious minor swing retail stops sit behind, i.e. the inducement.
   */
  private resolvePlan(
    structure: any,
    patternData: any,
    zones: any[],
    ltfObs: any[],
  ): IdmPlan | null {
    // A bearish break left a LOW behind: sweeping it feeds a long.
    // A bullish break left a HIGH behind: sweeping it feeds a short.
    const direction: Direction =
      structure.direction === 'BEARISH' ? 'BULLISH' : 'BEARISH';
    const isLong = direction === 'BULLISH';

    const sweptLevel = new Decimal(structure.price);
    if (!sweptLevel.isFinite() || sweptLevel.lte(0)) return null;

    const candles: any[] = patternData.candles15m;
    const last = candles[candles.length - 1];
    const lastTimestamp = Number(last.timestamp);
    const lastHigh = new Decimal(last.high);
    const lastLow = new Decimal(last.low);
    const lastClose = new Decimal(last.close);

    // --- GATE 1: the trigger candle sweeps the level and reclaims it ---
    const pierced = isLong
      ? lastLow.lt(sweptLevel)
      : lastHigh.gt(sweptLevel);
    const reclaimed = isLong
      ? lastClose.gt(sweptLevel)
      : lastClose.lt(sweptLevel);
    if (!pierced || !reclaimed) {
      this.fail(
        'noSweep',
        `No IDM sweep of the ${isLong ? 'low' : 'high'} at ${sweptLevel.toString()}: wick beyond + close back inside required`,
        1,
      );
      return null;
    }

    // --- GATE 2: the real OB beyond the swept level ---
    // It must pre-exist the trigger candle: a block printed by the sweep is a
    // reaction to it, not the destination the sweep was reaching for.
    const realObs = ltfObs.filter((z: any) => {
      if (z.direction !== direction) return false;
      if (Number(z.timestamp) >= lastTimestamp) return false;
      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const obTop = Decimal.max(new Decimal(z.top), new Decimal(z.bottom));
      const obBottom = Decimal.min(new Decimal(z.top), new Decimal(z.bottom));
      return isLong ? obTop.lt(sweptLevel) : obBottom.gt(sweptLevel);
    });

    if (realObs.length === 0) {
      this.fail(
        'noRealOb',
        `No real ${direction} OB ${isLong ? 'below' : 'above'} the swept level`,
        2,
      );
      return null;
    }

    const realOb = realObs.reduce((freshest: any, candidate: any) =>
      Number(candidate.timestamp) > Number(freshest.timestamp)
        ? candidate
        : freshest,
    );
    const obTop = Decimal.max(new Decimal(realOb.top), new Decimal(realOb.bottom));
    const obBottom = Decimal.min(
      new Decimal(realOb.top),
      new Decimal(realOb.bottom),
    );

    // --- GATE 3: proximity — the OB must be "just" beyond, not a distant level ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');
    const gap = isLong
      ? sweptLevel.minus(obTop)
      : obBottom.minus(sweptLevel);
    const tolerance = Decimal.max(
      atr.mul(PROXIMITY_ATR_MULTIPLIER),
      sweptLevel.mul(PROXIMITY_MIN_PCT),
    );
    if (gap.gt(tolerance)) {
      this.fail(
        'proximity',
        `Real OB is ${gap.toFixed(4)} beyond the swept level (> ${tolerance.toFixed(4)} tolerance)`,
        3,
      );
      return null;
    }

    // --- GATE 4: the sweep wick reaches the real OB (the "immediate test") ---
    const testedOb = isLong ? lastLow.lte(obTop) : lastHigh.gte(obBottom);
    if (!testedOb) {
      this.fail(
        'noObTest',
        'Price not testing real OB after IDM sweep (the sweep wick did not reach the block)',
        4,
      );
      return null;
    }

    // --- GATE 5: levels ---
    const entry = obTop.plus(obBottom).dividedBy(2);
    // The stop must sit beyond the wick that took the inducement; otherwise the
    // position is protected only by a level its own trigger candle already
    // violated.
    const stopZone =
      direction === 'BULLISH'
        ? { top: obTop, bottom: Decimal.min(obBottom, lastLow), direction }
        : { top: Decimal.max(obTop, lastHigh), bottom: obBottom, direction };

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
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 5);
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
      structure,
      sweptLevel,
      realOb,
      levels,
      reason: `IDM: ${isLong ? 'low' : 'high'} at ${sweptLevel.toString()} swept and reclaimed + real 15m ${direction} OB 0.5 test`,
    };
  }

  /**
   * Keep the DEEPEST rejection, not the first one.
   *
   * The scan walks structures newest → oldest, so a first-wins bucket would
   * always be named by the newest structure ("its level was not swept") and hide
   * the fact that an older inducement reached the proximity or trigger gate.
   * The reported bucket therefore describes how far the funnel got.
   */
  private fail(kind: FailureKind, reason: string, stage: number): void {
    if (this.failure && this.failure.stage >= stage) return;
    this.failure = { kind, reason, stage };
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
