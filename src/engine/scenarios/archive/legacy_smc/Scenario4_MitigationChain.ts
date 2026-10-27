import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/**
 * Mitigation window: a block is only a tradeable mitigation while the break it
 * produced is still the operative one. 24h on the entry timeframe.
 */
const BOS_WINDOW_MS = 24 * 60 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

/** Fully validated mitigation chain. Setters are applied only for a plan. */
interface MitigationPlan {
  readonly direction: Direction;
  readonly baseOb: any;
  readonly bounce: { timestamp: number; index: number };
  readonly bos: any;
  readonly continuationOb: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario4Stats {
  totalEvals: number;
  killzone: number;
  noValidOb: number;
  premiumDiscount: number;
  noBounce: number;
  noBos: number;
  noRetest: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'premiumDiscount'
  | 'noBounce'
  | 'noBos'
  | 'noRetest'
  | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 4 — Mitigation Chain (Order Flow).
 *
 * A mitigation block is a zone the market has already defended once. The trade
 * is not the first touch — it is the CONTINUATION after that defence proved
 * itself with a break of structure, entering on the retest of the block the
 * break created.
 *
 * Chain (strictly ordered, every link causal):
 *  1. A 15m OB exists. Its direction defines the trade — demand can only produce
 *     longs, supply only shorts. The freshest block that completes the whole
 *     chain wins, so no hardcoded side is involved.
 *  2. It is MITIGATED: a later candle trades into the block and closes back on
 *     the origin side. That rejection is the defence the scenario trades.
 *  3. A 15m BOS in the block's direction prints strictly AFTER that bounce, and
 *     within 24h of it. A break that happened before the defence describes a
 *     different leg and cannot validate this block.
 *  4. The retest targets the NEW block the break created — the freshest
 *     same-direction 15m OB formed at/after the mitigated one and at/before the
 *     BOS (falling back to the mitigated block when the break produced no new
 *     zone). The current candle must trade through that block's equilibrium.
 *
 * Removed legacy gates:
 *  - `hasBullish4h`: required a bullish 4H BOS *and* zero bearish 4H structure,
 *    which duplicated the block's own direction, vetoed valid setups on
 *    unrelated 4H breaks, and made the scenario long-only. Direction now comes
 *    from the block being traded, with Premium/Discount as the positioning
 *    check.
 *  - The CHoCH requirement: a mitigation chain is defined by a BOS after the
 *    defence, not by a change of character somewhere in the buffer. Requiring
 *    both discarded every chain where the continuation broke structure without
 *    first reversing.
 *  - The explicit displacement check: `detectStructureBreaks()` only emits a
 *    structure when the break candle's body clears the displacement threshold,
 *    so `BOS` already implies displacement (AGENTS.md §7.2).
 */
export class Scenario4_MitigationChain extends BaseScenario {
  /** Deepest rejection of the scan — the stage the chain actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario4Stats = {
    totalEvals: 0,
    killzone: 0,
    noValidOb: 0,
    premiumDiscount: 0,
    noBounce: 0,
    noBos: 0,
    noRetest: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(4, 'Mitigation Chain', config);
  }

  static getRejectionStats(): Scenario4Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noValidOb: 0,
      premiumDiscount: 0,
      noBounce: 0,
      noBos: 0,
      noRetest: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario4_MitigationChain.stats;
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
      stats.noValidOb++;
      return false;
    }

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];
    // NOTE: `!z.mitigated` is intentionally absent — `PatternRecognizer` hardcodes
    // `mitigated: false`, so the predicate was a permanent no-op. Re-entry is
    // blocked by `ScenarioRouter.filterMitigatedZones` (timestamp/price match);
    // here "mitigated" is proven by price action (the bounce gate).
    const ltfObs = zones.filter(
      (z) =>
        z.type === 'OB' &&
        String(z.timeframe) === ENTRY_TIMEFRAME &&
        (z.direction === 'BULLISH' || z.direction === 'BEARISH'),
    );
    if (ltfObs.length === 0) {
      this.logRejection('No 15m Order Block available');
      stats.noValidOb++;
      return false;
    }

    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const pd = this.resolvePremiumDiscount(patternData);

    // Freshest block first: the most recent mitigation is the one whose
    // continuation is still in play. Older blocks are only reached when no
    // fresher chain completes.
    const ordered = [...ltfObs].sort(
      (a, b) => Number(b.timestamp) - Number(a.timestamp),
    );

    for (const baseOb of ordered) {
      const plan = this.resolvePlan(baseOb, patternData, zones, ltfObs, structures, pd);
      if (!plan) continue;

      const contTop = Decimal.max(
        new Decimal(plan.continuationOb.top),
        new Decimal(plan.continuationOb.bottom),
      );
      const contBottom = Decimal.min(
        new Decimal(plan.continuationOb.top),
        new Decimal(plan.continuationOb.bottom),
      );

      this.setLevels(plan.levels);
      // The POI actually being entered is the block the break created — that is
      // what gets burned, not the already-mitigated base block.
      this.setZoneDetails({
        type: 'OB',
        top: contTop,
        bottom: contBottom,
        timeframe: ENTRY_TIMEFRAME,
        direction: plan.direction,
        timestamp: Number(plan.continuationOb.timestamp),
      });
      this.setStructureDetails({
        type: 'BOS',
        timestamp: Number(plan.bos.timestamp),
        price: new Decimal(plan.bos.price),
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
      this.logRejection('No valid Mitigation Chain setup');
    }
    return false;
  }

  /**
   * Resolve one mitigation chain end-to-end. Nothing is written to the scenario
   * state until every link — bounce, BOS, new block, equilibrium retest and
   * structural target — has validated.
   */
  private resolvePlan(
    baseOb: any,
    patternData: any,
    zones: any[],
    ltfObs: any[],
    structures: any[],
    pd: { equilibrium: Decimal } | null,
  ): MitigationPlan | null {
    const direction = baseOb.direction as Direction;
    const isLong = direction === 'BULLISH';

    const baseTimestamp = Number(baseOb.timestamp);
    if (!Number.isFinite(baseTimestamp) || baseTimestamp <= 0) return null;

    // Zone top/bottom ordering is not guaranteed (Invariant 11).
    const baseTop = Decimal.max(new Decimal(baseOb.top), new Decimal(baseOb.bottom));
    const baseBottom = Decimal.min(
      new Decimal(baseOb.top),
      new Decimal(baseOb.bottom),
    );
    if (!baseTop.gt(baseBottom)) return null;

    const candles15m: any[] = patternData.candles15m;
    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);
    const lastHigh = new Decimal(last.high);
    const lastLow = new Decimal(last.low);

    // --- GATE 1: Premium/Discount positioning ---
    // A demand block below the dealing-range equilibrium is a discount long; a
    // supply block above it is a premium short. Mirrored, not long-only.
    if (pd) {
      const baseMid = baseTop.plus(baseBottom).dividedBy(2);
      const aligned = isLong
        ? baseMid.lt(pd.equilibrium)
        : baseMid.gt(pd.equilibrium);
      if (!aligned) {
        this.fail(
          'premiumDiscount',
          `${direction} OB not in ${isLong ? 'Discount' : 'Premium'} zone (equilibrium ${pd.equilibrium.toFixed(4)})`,
          1,
        );
        return null;
      }
    }

    // --- GATE 2: the block was mitigated (bounced) ---
    const bounce = this.findBounce(candles15m, baseTimestamp, direction, baseTop, baseBottom);
    if (!bounce) {
      this.fail(
        'noBounce',
        `15m ${direction} OB was never mitigated (no candle traded into it and closed back on the origin side)`,
        2,
      );
      return null;
    }

    // --- GATE 3: BOS strictly after the bounce, inside the 24h window ---
    const bosCandidates = structures
      .filter(
        (s: any) =>
          s.type === 'BOS' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) > bounce.timestamp &&
          Number(s.timestamp) <= bounce.timestamp + BOS_WINDOW_MS &&
          Number(s.timestamp) <= lastTimestamp,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const bos = bosCandidates[bosCandidates.length - 1];
    if (!bos) {
      this.fail(
        'noBos',
        `No 15m ${direction} BOS after the OB bounce within 24h`,
        3,
      );
      return null;
    }

    // --- GATE 4: the new block the break created ---
    // `detectOrderBlocks()` derives every OB from a break, so the freshest
    // same-direction block at/before the BOS IS the block that produced it.
    // Falling back to the mitigated block covers breaks with no new zone.
    const continuationCandidates = ltfObs.filter(
      (z: any) =>
        z.direction === direction &&
        Number(z.timestamp) >= baseTimestamp &&
        Number(z.timestamp) <= Number(bos.timestamp),
    );
    const continuationOb = continuationCandidates.reduce(
      (freshest: any, candidate: any) =>
        Number(candidate.timestamp) > Number(freshest.timestamp)
          ? candidate
          : freshest,
      baseOb,
    );

    const contTop = Decimal.max(
      new Decimal(continuationOb.top),
      new Decimal(continuationOb.bottom),
    );
    const contBottom = Decimal.min(
      new Decimal(continuationOb.top),
      new Decimal(continuationOb.bottom),
    );
    if (!contTop.gt(contBottom)) return null;

    // --- GATE 5: the current candle retests the new block's equilibrium ---
    const equilibrium = contTop.plus(contBottom).dividedBy(2);
    const retestsEquilibrium =
      lastHigh.gte(equilibrium) && lastLow.lte(equilibrium);
    if (!retestsEquilibrium) {
      this.fail(
        'noRetest',
        `Price has not returned to the new 15m ${direction} OB equilibrium (${equilibrium.toFixed(4)})`,
        4,
      );
      return null;
    }

    // --- GATE 6: levels ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // The stop must sit beyond the retest candle's wick as well: a mitigation
    // entry whose stop is inside its own trigger bar is stopped by noise, not by
    // the block actually failing.
    const stopZone =
      direction === 'BULLISH'
        ? { top: contTop, bottom: Decimal.min(contBottom, lastLow), direction }
        : { top: Decimal.max(contTop, lastHigh), bottom: contBottom, direction };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(
      equilibrium,
      stopZone,
      direction,
      atr,
      new Decimal(1),
    );

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
      equilibrium,
      stopZone,
      direction,
      atr,
      resolution.takeProfit,
    );

    return {
      direction,
      baseOb,
      bounce,
      bos,
      continuationOb,
      levels,
      reason: `Mitigation Chain: 15m ${direction} OB mitigated + BOS after bounce + new OB 0.5 retest`,
    };
  }

  /**
   * The bounce: the first candle after the block's formation that trades into it
   * and closes back on the origin side (above a demand block, below a supply
   * block).
   *
   * A candle that closes INSIDE the block is mitigation of the zone, not a
   * defence of it — including it would let a broken block validate its own
   * continuation. The scan starts strictly after the OB candle, so the block can
   * never be its own bounce.
   */
  private findBounce(
    candles: any[],
    obTimestamp: number,
    direction: Direction,
    top: Decimal,
    bottom: Decimal,
  ): { timestamp: number; index: number } | null {
    const startIndex = candles.findIndex(
      (c: any) => Number(c.timestamp) > obTimestamp,
    );
    if (startIndex < 0) return null;

    for (let i = startIndex; i < candles.length; i++) {
      const high = new Decimal(candles[i].high);
      const low = new Decimal(candles[i].low);
      const close = new Decimal(candles[i].close);

      const intersects = high.gte(bottom) && low.lte(top);
      if (!intersects) continue;

      const closedAway =
        direction === 'BULLISH' ? close.gte(top) : close.lte(bottom);
      if (closedAway) {
        return { timestamp: Number(candles[i].timestamp), index: i };
      }
    }
    return null;
  }

  /**
   * Keep the DEEPEST rejection, not the first one.
   *
   * The scan walks blocks newest → oldest, so a first-wins bucket would always be
   * named by the newest block ("it was never mitigated") and hide the fact that
   * an older mitigation reached the BOS or the retest. The reported bucket
   * therefore describes how far the chain got.
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

  /** Dealing-range equilibrium, or null when the recognizer is unavailable. */
  private resolvePremiumDiscount(
    patternData: any,
  ): { equilibrium: Decimal } | null {
    const recognizer = patternData.patternRecognizer;
    if (!recognizer || typeof recognizer.calculatePremiumDiscount !== 'function') {
      return null;
    }
    // The traded block is a 15m zone: its positioning is measured against the
    // 15m dealing range, not the 4H one.
    const pd = recognizer.calculatePremiumDiscount(patternData.candles15m);
    return pd ?? null;
  }
}
