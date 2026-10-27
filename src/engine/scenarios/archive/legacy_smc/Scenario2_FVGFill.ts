import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/**
 * FVG timeframes that qualify as the HTF POI being filled.
 * `buildPatternData()` merges 15m + 4H zones only, so `240` is the HTF feed.
 */
const HTF_FVG_TIMEFRAMES = new Set(['240', '4H']);
/** `detectFVGs()` stamps a gap at c1; the three-bar pattern exists from c3. */
const FVG_FORMATION_CANDLES = 2;
/** Length of one HTF candle — the completion offset uses the gap's own timeframe. */
const HTF_CANDLE_MS: Record<string, number> = {
  '240': 4 * 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
};
/** Causality budget: the CHoCH must follow the fill inside one 4H window. */
const CAUSALITY_WINDOW_CANDLES = 16;
/** Confluence window: sweep / CHoCH / BOS in the 15 candles before the FVG formed. */
const LIQUIDITY_CONTEXT_CANDLES = 15;
/** Displacement floor for the confirming CHoCH (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/** Fallback LTF spacing when the candle series is too short to measure. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

/** Fully validated fill chain. Setters are applied only for a plan. */
interface FvgPlan {
  readonly direction: Direction;
  readonly fvg: any;
  readonly choch: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario2Stats {
  totalEvals: number;
  killzone: number;
  noHtfFvg: number;
  noFvgTouch: number;
  noChoch: number;
  displacement: number;
  premiumDiscount: number;
  noLiquidityContext: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noFvgTouch'
  | 'premiumDiscount'
  | 'noLiquidityContext'
  | 'noChoch'
  | 'displacement'
  | 'tpInvalid';

/** A rejection plus how far down the funnel it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 2 — FVG Fill (HTF fair-value gap → LTF continuation).
 *
 * Handbook §3: an HTF imbalance is a magnet; once price fills it to equilibrium
 * (0.5) and an LTF CHoCH confirms the reaction, the gap acts as the entry POI.
 *
 * Causal contract:
 *  1. Direction comes from the HTF FVG being tested — a bullish gap can only
 *     produce a long, a bearish gap only a short. There is no hardcoded side and
 *     no separate "HTF trend" opinion that can contradict the POI.
 *  2. The gap must actually be filled: the current candle trades through its
 *     equilibrium.
 *  3. Premium/Discount is mirrored, not long-only: a bullish gap is a buy POI
 *     only below the dealing-range equilibrium, a bearish gap a sell POI only
 *     above it.
 *  4. The fill is the FIRST touch inside the current 4H window at/after the gap
 *     completes. That candle — not the gap's `c1` stamp — is the causality
 *     anchor for the CHoCH: a CHoCH printed before the gap was filled describes
 *     the previous leg and cannot confirm this one.
 *
 * The legacy `hasBullish4h` filter is gone. It required a bullish 4H BOS *and*
 * the total absence of bearish 4H structure, so it duplicated the gap's own
 * direction or vetoed it on an unrelated break — and it was asymmetric
 * (long-only) by construction.
 */
export class Scenario2_FVGFill extends BaseScenario {
  /** Deepest rejection of the scan — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario2Stats = {
    totalEvals: 0,
    killzone: 0,
    noHtfFvg: 0,
    noFvgTouch: 0,
    noChoch: 0,
    displacement: 0,
    premiumDiscount: 0,
    noLiquidityContext: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(2, 'FVG Fill', config);
  }

  static getRejectionStats(): Scenario2Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noHtfFvg: 0,
      noFvgTouch: 0,
      noChoch: 0,
      displacement: 0,
      premiumDiscount: 0,
      noLiquidityContext: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario2_FVGFill.stats;
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
      stats.noHtfFvg++;
      return false;
    }

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];
    const htfFvgs = zones.filter(
      (z) =>
        z.type === 'FVG' &&
        HTF_FVG_TIMEFRAMES.has(String(z.timeframe)) &&
        (z.direction === 'BULLISH' || z.direction === 'BEARISH'),
    );

    if (htfFvgs.length === 0) {
      this.logRejection('No HTF FVG found');
      stats.noHtfFvg++;
      return false;
    }

    const ltfMs = this.resolveCandleMs(candles15m);
    const pd = this.resolvePremiumDiscount(patternData);

    // Freshest gap first: the most recent imbalance is the one price is still
    // working with. Older gaps remain valid but are only reached if the fresh
    // one cannot complete the chain.
    const candidates = [...htfFvgs].sort(
      (a, b) => Number(b.timestamp) - Number(a.timestamp),
    );

    for (const fvg of candidates) {
      const plan = this.resolvePlan(fvg, patternData, zones, pd, ltfMs);
      if (!plan) continue;

      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const top = Decimal.max(new Decimal(fvg.top), new Decimal(fvg.bottom));
      const bottom = Decimal.min(new Decimal(fvg.top), new Decimal(fvg.bottom));

      this.setLevels(plan.levels);
      this.setZoneDetails({
        type: 'FVG',
        top,
        bottom,
        timeframe: String(fvg.timeframe),
        direction: plan.direction,
        timestamp: Number(fvg.timestamp),
      });
      this.setStructureDetails({
        type: 'CHoCH',
        timestamp: Number(plan.choch.timestamp),
        price: new Decimal(plan.choch.price),
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
      this.logRejection('No valid HTF FVG fill setup');
    }
    return false;
  }

  /**
   * Resolve one HTF FVG end-to-end. Returns a complete plan only when the fill,
   * the Premium/Discount context, the confluence window, the CHoCH and the
   * structural target all validate — nothing is written to the scenario state
   * until every gate has passed.
   */
  private resolvePlan(
    fvg: any,
    patternData: any,
    zones: any[],
    pd: { equilibrium: Decimal } | null,
    ltfMs: number,
  ): FvgPlan | null {
    const direction = fvg.direction as Direction;
    const candles15m: any[] = patternData.candles15m;
    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);
    const lastClose = new Decimal(last.close);
    const lastHigh = new Decimal(last.high);
    const lastLow = new Decimal(last.low);

    // Zone top/bottom ordering is not guaranteed (Invariant 11).
    const top = Decimal.max(new Decimal(fvg.top), new Decimal(fvg.bottom));
    const bottom = Decimal.min(new Decimal(fvg.top), new Decimal(fvg.bottom));
    if (!top.gt(bottom)) return null;

    const equilibrium = top.plus(bottom).dividedBy(2);

    // --- GATE 1: the gap must actually be filled to 0.5 right now ---
    const touched50 = lastHigh.gte(equilibrium) && lastLow.lte(equilibrium);
    if (!touched50) {
      this.fail(
        'noFvgTouch',
        `Price has not touched 0.5 (Equilibrium) of HTF ${direction} FVG. Current: ${lastClose.toFixed(4)}, EQ: ${equilibrium.toFixed(4)}`,
        1,
      );
      return null;
    }

    // --- GATE 2: Premium/Discount alignment ---
    if (pd) {
      const aligned =
        direction === 'BULLISH'
          ? equilibrium.lt(pd.equilibrium)
          : equilibrium.gt(pd.equilibrium);
      if (!aligned) {
        this.fail(
          'premiumDiscount',
          `${direction} HTF FVG not in ${direction === 'BULLISH' ? 'Discount' : 'Premium'} zone (equilibrium ${pd.equilibrium.toFixed(4)})`,
          2,
        );
        return null;
      }
    }

    // --- GATE 3: liquidity context before the gap formed ---
    if (!this.hasLiquidityContext(patternData, Number(fvg.timestamp))) {
      this.fail(
        'noLiquidityContext',
        'No liquidity context (sweep/CHoCH/BOS) in 15 candles before HTF FVG formation',
        3,
      );
      return null;
    }

    // --- GATE 4: locate the fill (the causality anchor) ---
    // The gap only exists once `c3` prints, so a touch on `c1`/`c2` is not a
    // fill of this gap. `FVG_FORMATION_CANDLES` is measured in the GAP's own
    // timeframe — 2 × 4H for a 4H gap, never the 15m spacing.
    const completionTimestamp =
      Number(fvg.timestamp) +
      FVG_FORMATION_CANDLES * (HTF_CANDLE_MS[String(fvg.timeframe)] ?? 0);

    // The anchor must live inside the current 4H causality window: an ancient
    // fill followed by a fresh re-entry would otherwise pin the CHoCH to a leg
    // that is no longer being traded.
    const windowStart =
      lastTimestamp - (CAUSALITY_WINDOW_CANDLES - 1) * ltfMs;
    // Gate 1 already proved the CURRENT candle is inside the gap, so the search
    // always has at least one hit. It identifies the first bar of the reaction —
    // the bar the CHoCH must follow. When the gap is newer than its own
    // completion + window (a just-printed 4H gap), nothing can precede this
    // candle, so the confirmation has to come from here on.
    const fill = this.findFill(
      candles15m,
      Math.max(completionTimestamp, windowStart),
      lastTimestamp,
      top,
      bottom,
    ) ?? { timestamp: lastTimestamp };

    // --- GATE 5: CHoCH at/after the fill, inside one 4H window ---
    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const windowEnd = fill.timestamp + CAUSALITY_WINDOW_CANDLES * ltfMs;
    const chochs = structures
      .filter(
        (s: any) =>
          s.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= fill.timestamp &&
          Number(s.timestamp) <= windowEnd &&
          Number(s.timestamp) <= lastTimestamp,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochs[chochs.length - 1];
    if (!choch) {
      this.fail('noChoch', `No 15m ${direction} CHoCH after FVG touch`, 5);
      return null;
    }

    if (!this.isValidDisplacement(choch, DISPLACEMENT_MULTIPLIER)) {
      this.fail('displacement', '15m CHoCH displacement < 1.5 ATR', 6);
      return null;
    }

    // --- GATE 6: stop geometry and structural take-profit ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // The stop must sit beyond THIS candle: a wick that pierced the gap while
    // filling it is part of the entry, not a level the position may be stopped
    // by an hour later.
    const stopZone =
      direction === 'BULLISH'
        ? { top, bottom: Decimal.min(bottom, lastLow), direction }
        : { top: Decimal.max(top, lastHigh), bottom, direction };

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
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 7);
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
      fvg,
      choch,
      levels,
      reason: `FVG Fill: ${direction} HTF FVG 0.5 touch + Premium/Discount + liquidity context + 15m ${direction} CHoCH`,
    };
  }

  /**
   * The fill event: the first candle trading into the gap at/after
   * `searchFrom`, never past `lastTimestamp`.
   *
   * Both bounds matter. `searchFrom` encodes the gap's own completion (a zone
   * stamped at `c1` cannot be filled before `c3`), and the window start keeps
   * the anchor inside the current 4H leg instead of pinning it to the first
   * time the gap was ever touched.
   */
  private findFill(
    candles: any[],
    searchFrom: number,
    lastTimestamp: number,
    top: Decimal,
    bottom: Decimal,
  ): { timestamp: number } | null {
    for (const candle of candles) {
      const timestamp = Number(candle.timestamp);
      if (timestamp < searchFrom) continue;
      if (timestamp > lastTimestamp) break;
      const high = new Decimal(candle.high);
      const low = new Decimal(candle.low);
      if (high.gte(bottom) && low.lte(top)) {
        return { timestamp };
      }
    }
    return null;
  }

  /**
   * Confluence gate: a liquidity pool or a CHoCH/BOS inside the 15 LTF candles
   * preceding the gap's formation.
   *
   * The old lookup required an exact timestamp match, which can never happen for
   * an HTF gap: a 4H zone is stamped with a 4H candle timestamp that does not
   * exist in the 15m series, so `findIndex(===)` always returned -1 and the gate
   * permanently rejected every 4H FVG. Anchoring on the first 15m candle at or
   * after the stamp fixes that without loosening the window.
   */
  private hasLiquidityContext(patternData: any, fvgTimestamp: number): boolean {
    const candles: any[] = patternData.candles15m;
    if (!candles?.length) return false;

    let anchor = candles.findIndex(
      (c: any) => Number(c.timestamp) >= fvgTimestamp,
    );
    if (anchor < 0) anchor = candles.length - 1;

    const start = Math.max(0, anchor - LIQUIDITY_CONTEXT_CANDLES);
    if (start >= anchor) return false;

    const from = Number(candles[start].timestamp);
    const to = Number(candles[anchor].timestamp);

    // NOTE: `isTaken` is intentionally ignored — `PatternRecognizer` always emits
    // `isTaken: false`, so filtering on it made this gate permanently dead.
    // Presence of a pool inside the window IS the sweep context.
    const pools: any[] = patternData.liquidityPools ?? [];
    if (
      pools.some(
        (p: any) =>
          Number(p.timestamp) >= from && Number(p.timestamp) <= to,
      )
    ) {
      return true;
    }

    const structures: any[] = patternData.structures ?? [];
    return structures.some(
      (s: any) =>
        (s.type === 'CHOCH' || s.type === 'BOS') &&
        Number(s.timestamp) >= from &&
        Number(s.timestamp) <= to,
    );
  }

  /**
   * Keep the DEEPEST rejection, not the first one.
   *
   * The scan walks gaps newest → oldest, so a first-wins bucket would always be
   * named by the newest gap ("price is not at its equilibrium yet") and hide the
   * fact that an older, actually-tested gap reached the CHoCH or the target gate.
   * The reported bucket therefore describes how far the funnel got, not which
   * gap happened to be freshest.
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

  /** Candle spacing of the entry series, in milliseconds (Invariant 12). */
  private resolveCandleMs(candles: any[]): number {
    const start = Math.max(1, candles.length - 5);
    for (let i = start; i < candles.length; i++) {
      const delta =
        Number(candles[i].timestamp) - Number(candles[i - 1].timestamp);
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
    return DEFAULT_LTF_MS;
  }

  /** Dealing-range equilibrium, or null when the recognizer is unavailable. */
  private resolvePremiumDiscount(
    patternData: any,
  ): { equilibrium: Decimal } | null {
    const recognizer = patternData.patternRecognizer;
    if (!recognizer || typeof recognizer.calculatePremiumDiscount !== 'function') {
      return null;
    }
    // An HTF gap is measured against the HTF dealing range when it is available;
    // the 15m series is the fallback for callers that only pass LTF candles.
    const range =
      Array.isArray(patternData.candles4h) && patternData.candles4h.length
        ? patternData.candles4h
        : patternData.candles15m;
    const pd = recognizer.calculatePremiumDiscount(range);
    return pd ?? null;
  }
}
