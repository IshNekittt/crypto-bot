import { BaseScenario, type TradeLevels } from '../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../config/env';
import type { LiquidityPool, PatternData, Structure, Zone } from '../../../smc/patternRecognizer';
import { buildHtfRoadmap } from '../../brain/htfRoadmap';
import {
  analyzeVolumeExhaustion,
  type VolumeExhaustionFailureCode,
  type VolumeExhaustionResult,
} from '../../brain/volumeExhaustion';
import { resolveTakeProfit } from '../../tpResolver';

/**
 * Scenario 13 — Top-Down Order Flow.
 *
 * The apex orchestrator: it trades ONLY when the higher timeframes agree on the
 * same idea, in a strict causal order.
 *
 *   4H  — Macro Roadmap (`buildHtfRoadmap`): directional bias, dealing range and
 *         the primary liquidity draw (target).
 *   15m — Volume Exhaustion (`analyzeVolumeExhaustion`): the POI in the correct
 *         premium/discount phase must show decaying counter-pressure and an
 *         institutional reaction volume at the touch.
 *
 * EXECUTION MODEL
 * ---------------
 * Scenario 13 is a strict 1m Sniper strategy. It requires
 * `ENABLE_SNIPER_MODE=true` and a live 1m feed (>= 15 candles); otherwise it
 * fails closed with the `disabled` funnel bucket. The 15m POI touch primes a
 * 30-minute reaction window, and a 1m CHoCH/BOS in the trade direction is the
 * only valid entry trigger. There is no blind 15m fallback: trading the POI
 * midpoint without 1m confirmation produced a negative-expectancy,
 * fee-dominated result (-$268 across BTC/SOL/NEAR in the 60-day test).
 *
 * The take-profit is NOT a constant multiple of risk. It is resolved from market
 * structure by `resolveTakeProfit`, anchored to the roadmap's primary target, and
 * rejected unless the resulting asymmetry clears the user-configured floor
 * (`DYNAMIC_TP_MIN_RR`, e.g. 1.5R). A hardcoded 3.5R / 2R gate choked off valid
 * 1.5R-3R trend continuations.
 */

/**
 * A POI touch remains primed for two 15m candles (30 minutes). The 1m CHoCH
 * routinely confirms 5–20 minutes after the touch, i.e. after the touch candle
 * itself has closed. A 30-minute window covers the touch candle and the next
 * one without accepting a stale third candle.
 */
const REACTION_WINDOW_MS = 30 * 60 * 1000;
/** Number of closed 15m candles inspected for a primed POI touch. */
const REACTION_WINDOW_CANDLES = 2;
/** Minimum 1m candles required to compute ATR(14) inside the window. */
const MIN_REACTION_CANDLES = 15;
/** Minimum number of 15m candles the volume module needs (SMA 20 + swings). */
const MIN_CANDLES_15M = 23;
/** Default 1m displacement multiplier (AGENTS.md §7.2). */
const DEFAULT_SNIPER_DISPLACEMENT = '1.5';
/**
 * POI proximity band, in 15m ATRs. Only zones whose midpoint sits inside this
 * band are considered — a zone 6 ATR away cannot be the reference price's POI,
 * and letting it shadow a nearer zone is what starved gate 3.
 */
const POI_PROXIMITY_ATR_MULTIPLIER = 3;
/** Physical length of the 15m candle that produced the primed touch. */
const REACTION_CANDLE_MS = 15 * 60 * 1000;

const EMPTY_REJECTION_STATS = {
  totalEvals: 0,
  disabled: 0,
  noHtfRoadmap: 0,
  htfNeutral: 0,
  noPoi: 0,
  noPullbackOrigin: 0,
  insufficientPullbackCandles: 0,
  pullbackVolumeHeavy: 0,
  poiViolated: 0,
  noPoiTouch: 0,
  volumeInvalid: 0,
  noReaction: 0,
  insufficientAsymmetry: 0,
  tpInvalid: 0,
  triggered: 0,
} as const;

type S13RejectionKey = Exclude<
  keyof typeof EMPTY_REJECTION_STATS,
  'totalEvals' | 'triggered'
>;

/** A POI that passed the volume-exhaustion gate and is ready for execution. */
interface PrimedPoi {
  readonly poi: Zone;
  readonly zoneTop: Decimal;
  readonly zoneBottom: Decimal;
  readonly primedTouchIndex: number;
}

/**
 * Setup produced by the 1m Sniper trigger. Gate 5 (structural target) and
 * Gate 6 (mitigation tagging) consume this shape, so the trigger, asymmetry and
 * burn-anchor logic stay in a single place.
 */
interface ExecutionSetup {
  readonly idealEntry: Decimal;
  readonly reactionZone: {
    readonly top: Decimal;
    readonly bottom: Decimal;
    readonly direction: 'BULLISH' | 'BEARISH';
  };
  readonly stopAtr: Decimal;
  readonly baseLevels: TradeLevels;
  readonly triggerType: 'CHoCH' | 'BOS';
  readonly triggerTimestamp: number;
  readonly triggerPrice: Decimal;
  readonly triggerLabel: string;
}

export class Scenario13_TopDownOrderFlow extends BaseScenario {
  private static rejectionStats: Record<keyof typeof EMPTY_REJECTION_STATS, number> = {
    ...EMPTY_REJECTION_STATS,
  };

  static getRejectionStats(): Record<keyof typeof EMPTY_REJECTION_STATS, number> {
    return { ...Scenario13_TopDownOrderFlow.rejectionStats };
  }

  static resetStats(): void {
    Scenario13_TopDownOrderFlow.rejectionStats = { ...EMPTY_REJECTION_STATS };
  }

  constructor(config: BotConfig) {
    super(13, 'Top-Down Order Flow', config);
  }

  /**
   * Record a rejection in the funnel and return `false`. Every evaluation
   * increments `totalEvals` plus EXACTLY ONE rejection bucket or `triggered`, so
   * the buckets always sum to `totalEvals - triggered`.
   */
  private reject(key: S13RejectionKey, reason: string): false {
    Scenario13_TopDownOrderFlow.rejectionStats[key] += 1;
    this.logRejection(reason);
    return false;
  }

  /**
   * Rejection helper for builder methods that return a setup or null. Records
   * exactly one funnel bucket, then signals failure to the caller.
   */
  private rejectAndNull(key: S13RejectionKey, reason: string): null {
    this.reject(key, reason);
    return null;
  }

  /**
   * Maps a typed volume-exhaustion failure to its dedicated funnel bucket.
   * Keeping this mapping exhaustive prevents invalid pivot data from hiding
   * inside a generic "not exhausted" counter.
   */
  private mapVolumeFailureToRejection(
    code: VolumeExhaustionFailureCode | undefined,
  ): S13RejectionKey {
    switch (code) {
      case 'NO_PULLBACK_ORIGIN':
        return 'noPullbackOrigin';
      case 'INSUFFICIENT_PULLBACK_CANDLES':
        return 'insufficientPullbackCandles';
      case 'PULLBACK_VOLUME_HEAVY':
        return 'pullbackVolumeHeavy';
      case 'POI_VIOLATED':
        return 'poiViolated';
      case 'NO_POI_TOUCH':
        return 'noPoiTouch';
      case 'REACTION_VOLUME_WEAK':
        return 'noReaction';
      default:
        return 'volumeInvalid';
    }
  }

  protected override evaluateInternal(patternData: PatternData): boolean {
    Scenario13_TopDownOrderFlow.rejectionStats.totalEvals += 1;

    // ────────────────────── STRICT MODE PRE-CONDITION ─────────────────────
    // Scenario 13 is a 1m execution strategy. Without Sniper Mode or a usable
    // 1m feed there is no micro-CHoCH trigger, and trading the 15m POI midpoint
    // blind is explicitly forbidden (60-day test: -$268, fee-dominated).
    const sniperCandles1m = patternData.candles1m;
    if (
      this.config.enableSniperMode !== true ||
      !Array.isArray(sniperCandles1m) ||
      sniperCandles1m.length < MIN_REACTION_CANDLES
    ) {
      return this.reject(
        'disabled',
        'Scenario 13 strictly requires Sniper Mode (1m feed)',
      );
    }

    // ───────────────────────── GATE 1: 4H ROADMAP ─────────────────────────
    const candles4h = patternData.candles4h;
    const candles15m = patternData.candles15m;
    if (!Array.isArray(candles4h) || candles4h.length < 2) {
      return this.reject('noHtfRoadmap', `Insufficient 4H candles (${candles4h?.length ?? 0})`);
    }
    if (!Array.isArray(candles15m) || candles15m.length < MIN_CANDLES_15M) {
      return this.reject('noPoi', `Insufficient 15m candles (${candles15m?.length ?? 0})`);
    }

    const roadmap = buildHtfRoadmap({
      candles4h,
      structures4h: (patternData.structures ?? []).filter((s) => s.timeframe === '240'),
      zones4h: (patternData.zones ?? []).filter((z) => z.timeframe === '240'),
      macroContext: patternData.macroContext,
    });

    // Neutral is checked BEFORE isValid so the distinct "no trend" rejection is
    // measurable — `buildHtfRoadmap` marks NEUTRAL as invalid as well.
    if (roadmap.bias === 'NEUTRAL') {
      return this.reject(
        'htfNeutral',
        `4H roadmap neutral: ${roadmap.reason ?? 'conflicting or absent 4H structure'}`,
      );
    }
    if (!roadmap.isValid || !roadmap.primaryTarget) {
      return this.reject(
        'noHtfRoadmap',
        `4H roadmap invalid: ${roadmap.reason ?? 'no valid dealing range / primary target'}`,
      );
    }

    const direction = roadmap.bias;

    // ─────────────────────── GATE 2: 15m POI SELECTION ────────────────────
    // Freshest is NOT the same as nearest. Selecting only the newest zone let a
    // freshly-formed, far-away POI permanently shadow the older zone price was
    // actually testing — 77% of all gate-3 rejections. Candidates are now
    // bounded by proximity to the last closed 15m price and ranked
    // NEAREST-FIRST, still filtered to the correct half of the dealing range:
    // DISCOUNT for longs, PREMIUM for shorts.
    const atr15m = patternData.atr15m;
    if (!(atr15m instanceof Decimal) || !atr15m.isFinite() || atr15m.lte(0)) {
      return this.reject('volumeInvalid', 'Invalid 15m ATR for POI invalidation');
    }

    const lastClosed15m = candles15m[candles15m.length - 1];
    const referencePrice = new Decimal(lastClosed15m.close);
    if (!referencePrice.isFinite() || referencePrice.lte(0)) {
      return this.reject('noPoi', `Invalid 15m reference price (${lastClosed15m.close})`);
    }
    const maxPoiDistance = atr15m.mul(POI_PROXIMITY_ATR_MULTIPLIER);

    const equilibrium = roadmap.dealingRange.equilibrium;
    const candidates = (patternData.zones ?? [])
      .filter(
        (zone): zone is Zone =>
          !!zone &&
          zone.timeframe === '15' &&
          !zone.mitigated &&
          (zone.type === 'OB' || zone.type === 'FVG') &&
          zone.direction === direction,
      )
      .map((zone) => {
        const top = Decimal.max(zone.top, zone.bottom);
        const bottom = Decimal.min(zone.top, zone.bottom);
        const midpoint = top.plus(bottom).div(2);
        return {
          zone,
          top,
          bottom,
          midpoint,
          distance: midpoint.minus(referencePrice).abs(),
        };
      })
      .filter((candidate) => {
        const inCorrectHalf =
          direction === 'BULLISH'
            ? candidate.midpoint.lt(equilibrium)
            : candidate.midpoint.gt(equilibrium);
        return inCorrectHalf && candidate.distance.lte(maxPoiDistance);
      })
      .sort((a, b) => {
        const byDistance = a.distance.comparedTo(b.distance);
        if (byDistance !== 0) return byDistance;
        // Freshest wins only on an exact distance tie.
        return b.zone.timestamp - a.zone.timestamp;
      });

    if (candidates.length === 0) {
      return this.reject(
        'noPoi',
        `No unmitigated 15m ${direction} OB/FVG in ${direction === 'BULLISH' ? 'discount' : 'premium'} within ${maxPoiDistance.toFixed(4)} of ${referencePrice.toFixed(4)}`,
      );
    }

    // ───────────────────── GATE 3: VOLUME EXHAUSTION ──────────────────────
    // A POI touch is PRIMED for two closed 15m candles. During that window the
    // 1m trigger is allowed to develop; it does not need to fire inside the same
    // 15m candle that touched the zone. Each proximity-ranked candidate is
    // evaluated until one passes: the trigger keeps iterating instead of betting
    // the entire evaluation on a single zone.
    const touchStartIndex = Math.max(
      0,
      candles15m.length - REACTION_WINDOW_CANDLES,
    );

    let primed: PrimedPoi | null = null;
    let reportedFailure: VolumeExhaustionResult | null = null;
    let reportedFailureKey: S13RejectionKey | null = null;
    let reportedFailureIndex = -1;

    for (const candidate of candidates) {
      let failure: VolumeExhaustionResult | null = null;
      let failureIndex = -1;

      for (let i = candles15m.length - 1; i >= touchStartIndex; i -= 1) {
        const result = analyzeVolumeExhaustion({
          candles15m,
          direction,
          poiZone: {
            top: candidate.top,
            bottom: candidate.bottom,
            timestamp: candidate.zone.timestamp,
          },
          atr15m,
          touchCandleTimestamp: candles15m[i].timestamp,
        });

        if (
          result.isValid &&
          result.isExhausted &&
          result.isReactionConfirmed
        ) {
          primed = {
            poi: candidate.zone,
            zoneTop: candidate.top,
            zoneBottom: candidate.bottom,
            primedTouchIndex: i,
          };
          break;
        }

        // A decisive break on the newest closed candle kills this POI. Move to
        // the next candidate — an older, still-valid zone may be the one price
        // is actually respecting.
        if (
          i === candles15m.length - 1 &&
          result.failureCode === 'POI_VIOLATED'
        ) {
          failure = result;
          failureIndex = i;
          break;
        }

        // Report the newest failure, but prefer a real touch failure over the
        // trivial "this candle did not reach the POI" of an unrelated candle.
        const shouldReplace =
          failure === null ||
          (failure.failureCode === 'NO_POI_TOUCH' &&
            result.failureCode !== 'NO_POI_TOUCH');
        if (shouldReplace) {
          failure = result;
          failureIndex = i;
        }
      }

      if (primed) break;

      // The funnel reports the NEAREST candidate's failure: it is the zone price
      // is actually testing, so its rejection is the diagnostically meaningful
      // one (a farther zone's failure would mask the real obstacle).
      if (failure && reportedFailure === null) {
        reportedFailure = failure;
        reportedFailureKey = this.mapVolumeFailureToRejection(
          failure.failureCode,
        );
        reportedFailureIndex = failureIndex;
      }
    }

    if (!primed) {
      const key = reportedFailureKey ?? 'noPoiTouch';
      const touchDetail =
        reportedFailureIndex >= 0
          ? ` (touch ${new Date(candles15m[reportedFailureIndex].timestamp).toISOString()})`
          : '';
      return this.reject(
        key,
        `Primed POI unavailable across ${candidates.length} proximity candidate(s)${touchDetail}: ${reportedFailure?.reason ?? 'unknown'}`,
      );
    }

    const { poi, zoneTop, zoneBottom } = primed;

    // ────────── GATE 4: 1m MICRO TRIGGER + PRECISION STOP LAYOUT ──────────
    // The primed 15m POI reaction MUST be confirmed by a 1m displacement
    // structure in the trade direction. The entry is the trigger candle close
    // (R4) and the stop sits beyond the full reaction window, INCLUDING the
    // minute that first touched the POI, so a normal mitigation wick cannot
    // clip it prematurely.
    //
    // `rr = 1` in the builder is a placeholder: that call is consumed for the
    // STOP only. The target is resolved from structure in Gate 5.
    // `calculateLevels` supplies the inverted-zone defense and the 0.1% minimum
    // offset floor.
    const offsetMultiplier = this.config.smcSlAtrOffset
      ? new Decimal(this.config.smcSlAtrOffset)
      : new Decimal('0.5');

    const setup = this.buildMicroSetup(
      patternData,
      primed,
      direction,
      offsetMultiplier,
    );

    if (!setup) return false;

    const {
      reactionZone,
      stopAtr,
      baseLevels,
      triggerType,
      triggerTimestamp,
      triggerPrice,
      triggerLabel,
    } = setup;

    const risk = baseLevels.entry.minus(baseLevels.stopLoss).abs();
    if (risk.lte(0)) {
      return this.reject('tpInvalid', 'Risk distance collapsed to zero');
    }

    // ──────────── GATE 5: ASYMMETRIC MACRO TARGET RESOLUTION ─────────────
    // The roadmap's primary target is injected into the resolver's candidate set
    // so the macro draw is a concrete, rankable level — not a hope. Resolution is
    // forced dynamic here: a fixed `k * R` target contradicts this scenario's
    // entire premise (macro target or no trade), regardless of the global switch.
    const target = roadmap.primaryTarget.price;
    const targetBeyondEntry =
      direction === 'BULLISH' ? target.gt(baseLevels.entry) : target.lt(baseLevels.entry);

    if (!targetBeyondEntry) {
      return this.reject(
        'tpInvalid',
        `Roadmap target ${target.toString()} is not beyond entry ${baseLevels.entry.toString()}`,
      );
    }

    // Both execution paths are anchored to the same 15m POI touch candle: the
    // synthetic target pool is stamped with it so the resolver can order the
    // macro draw against everything that formed after the touch.
    const reactionCandle = candles15m[primed.primedTouchIndex];

    const anchorPool: LiquidityPool = {
      type: direction === 'BULLISH' ? 'BSL' : 'SSL',
      priceLevel: target,
      points: [],
      isTaken: false,
      timestamp: reactionCandle.timestamp,
    };

    const asymmetryFloor = this.config.dynamicTpMinRr;
    const maxRr = this.config.dynamicTpMaxRr.gt(0)
      ? this.config.dynamicTpMaxRr
      : new Decimal(6);
    const fixedRr = this.config.fixedTpRr.gt(0) ? this.config.fixedTpRr : new Decimal(3);

    let resolution;
    try {
      resolution = resolveTakeProfit({
        direction,
        entry: baseLevels.entry,
        stopLoss: baseLevels.stopLoss,
        zones: patternData.zones ?? [],
        liquidityPools: [...(patternData.liquidityPools ?? []), anchorPool],
        tradingRange: patternData.tradingRange,
        macroContext: patternData.macroContext,
        sessionRanges: patternData.sessionRanges ?? [],
        minRr: asymmetryFloor,
        maxRr,
        fixedRr,
        enableDynamicTp: true,
        requireTarget: true,
        // R3: the macro draw is the only genuine wall. Internal 4H swing pools,
        // 15m zones and range equilibrium closer than the floor are stepped
        // over instead of rejecting 87.8% of otherwise valid setups.
        skipMinorObstacles: true,
        majorTargets: [target],
      });
    } catch (error) {
      return this.reject(
        'tpInvalid',
        `Take-profit resolution threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!resolution.ok) {
      // The wall filter ("Insufficient room") is the only rejection driven by the
      // asymmetry floor. It gets its own bucket so calibration is measurable.
      const key: S13RejectionKey = resolution.reason.startsWith('Insufficient room')
        ? 'insufficientAsymmetry'
        : 'tpInvalid';
      return this.reject(key, `Take-profit rejected: ${resolution.reason}`);
    }

    if (resolution.source === 'FIXED_FALLBACK') {
      return this.reject(
        'tpInvalid',
        'Macro target was not resolved structurally (fixed fallback)',
      );
    }

    // calculatedRr is measured on the FINAL resolved target, not on a nominal
    // roadmap distance: if the resolver clamped to DYNAMIC_TP_MAX_RR the real
    // asymmetry is the clamped one.
    const calculatedRr = resolution.takeProfit.minus(baseLevels.entry).abs().div(risk);
    if (calculatedRr.lt(asymmetryFloor)) {
      return this.reject(
        'insufficientAsymmetry',
        `Asymmetry ${calculatedRr.toFixed(2)}R < ${asymmetryFloor.toString()}R floor`,
      );
    }

    let levels;
    try {
      levels = this.calculateLevelsWithTarget(
        baseLevels.entry,
        reactionZone,
        direction,
        stopAtr,
        resolution.takeProfit,
        offsetMultiplier,
      );
    } catch (error) {
      return this.reject(
        'tpInvalid',
        `Level finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // SAFETY NET: never let invalid geometry reach the exchange.
    const geometryValid =
      direction === 'BULLISH'
        ? levels.stopLoss.lt(levels.entry) && levels.takeProfit.gt(levels.entry)
        : levels.stopLoss.gt(levels.entry) && levels.takeProfit.lt(levels.entry);

    if (!geometryValid) {
      return this.reject(
        'tpInvalid',
        `Invalid ${direction} geometry: entry=${levels.entry} SL=${levels.stopLoss} TP=${levels.takeProfit}`,
      );
    }

    // ─────────────────────── GATE 6: MITIGATION TAGGING ───────────────────
    // Zone = the 15m POI, structure = the execution trigger (1m CHoCH/BOS in
    // Sniper Mode, a validated 15m structure or the touch-candle burn anchor in
    // Classic Mode). Both are required by `burnSetup()` and engine
    // `mitigatedStructures` tracking (Invariants 21, 25, 39) so a consumed
    // POI/trigger can never produce a ghost re-entry.
    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    this.setZoneDetails({
      type: poi.type,
      top: zoneTop,
      bottom: zoneBottom,
      timeframe: '15',
      direction,
      timestamp: poi.timestamp,
    });

    this.setStructureDetails({
      type: triggerType,
      timestamp: triggerTimestamp,
      price: triggerPrice,
      direction,
    });

    this.setReason(
      `Top-Down ${direction}: 4H ${roadmap.primaryTarget.label} target @ ${target.toFixed(4)}, ` +
      `15m POI ${zoneBottom.toFixed(4)}-${zoneTop.toFixed(4)}, ` +
      `entry @ ${levels.entry.toFixed(4)} (${triggerLabel}), ${calculatedRr.toFixed(2)}R`,
    );

    Scenario13_TopDownOrderFlow.rejectionStats.triggered += 1;
    return true;
  }

  /**
   * Sniper Mode execution setup: 1m displacement trigger inside the 30-minute
   * window primed by the 15m POI touch.
   *
   * The entry is the trigger candle close (R4) — the price the reaction actually
   * printed at. The stop is anchored to the FULL reaction window, INCLUDING the
   * minute that first touched the POI (D5 revert): excluding the touch candle
   * placed the stop inside the real invalidation, where a normal mitigation wick
   * could clip it.
   */
  private buildMicroSetup(
    patternData: PatternData,
    primed: PrimedPoi,
    direction: 'BULLISH' | 'BEARISH',
    offsetMultiplier: Decimal,
  ): ExecutionSetup | null {
    const candles15m = patternData.candles15m;
    const candles1m = patternData.candles1m;
    if (!Array.isArray(candles1m) || candles1m.length < MIN_REACTION_CANDLES) {
      return this.rejectAndNull(
        'noReaction',
        `Insufficient 1m candles (${candles1m?.length ?? 0}) — Scenario 13 needs the Sniper 1m feed`,
      );
    }

    const { zoneTop, zoneBottom, primedTouchIndex } = primed;
    const reactionCandle = candles15m[primedTouchIndex];
    const touchCandleEnd = reactionCandle.timestamp + REACTION_CANDLE_MS;

    // R2 — the reaction window starts at the exact 1m minute that first traded
    // into the POI, not at the 15m candle open. Anchoring to the open wasted up
    // to 15 minutes of the window before the touch existed and admitted CHoCHs
    // that printed BEFORE the touch (causality inversion).
    const touchMinute = candles1m.find((candle) => {
      if (
        candle.timestamp < reactionCandle.timestamp ||
        candle.timestamp >= touchCandleEnd
      ) {
        return false;
      }
      return (
        new Decimal(candle.high).gte(zoneBottom) &&
        new Decimal(candle.low).lte(zoneTop)
      );
    });

    const windowStart = touchMinute?.timestamp ?? reactionCandle.timestamp;
    const windowEnd = windowStart + REACTION_WINDOW_MS;
    const reaction = candles1m
      .filter((c) => c.timestamp >= windowStart && c.timestamp < windowEnd)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (reaction.length < MIN_REACTION_CANDLES) {
      return this.rejectAndNull(
        'noReaction',
        `Reaction window ${new Date(windowStart).toISOString()} has only ${reaction.length} 1m candles (need ${MIN_REACTION_CANDLES})`,
      );
    }

    const atr1m = this.calculateATR(reaction, 14);
    if (atr1m.lte(0)) {
      return this.rejectAndNull('noReaction', 'Invalid 1m ATR inside the reaction window');
    }

    const microStructures = this.detectStructureBreaks(reaction, atr1m);
    // Ghost protection (Invariant 25): the engine/router burns consumed trigger
    // timestamps, but these 1m structures are detected LOCALLY inside the
    // reaction window and never pass through `filterMitigatedStructures()`. The
    // timestamp check keeps a burned CHoCH from re-arming against a different
    // 15m POI after a fast stop-out.
    const mitigatedStructures = patternData.mitigatedStructures;
    const isMitigated = (structure: Structure): boolean =>
      (mitigatedStructures ?? []).some(
        (entry) => entry.timestamp === structure.timestamp,
      );

    const trigger = [...microStructures]
      .reverse()
      .find(
        (s) =>
          s.direction === direction &&
          s.isValidated &&
          s.timestamp > windowStart &&
          !isMitigated(s),
      );

    if (!trigger) {
      return this.rejectAndNull(
        'noReaction',
        `No validated 1m ${direction} displacement structure after the POI touch ${new Date(windowStart).toISOString()}`,
      );
    }

    // R4 — the stale 15m POI midpoint is behind the market once a 1m
    // displacement has printed. Anchor the entry to the TRIGGER CANDLE CLOSE:
    // the price the reaction actually printed at.
    //
    // A tighter "micro-order-block origin" anchor is deliberately NOT used. It
    // sits behind the displacement, so Hybrid Smart Entry would classify the
    // small premium as within the 0.15% band and fill at MARKET — at a worse
    // price than the anchor the R:R was validated against. Measured on SOLUSDT
    // and BTCUSDT, that silently turned planned 1.50R setups into realized
    // 0.89R/1.21R trades. The entry must be the price that will actually be
    // paid, or the asymmetry floor is fiction.
    const triggerCandle =
      reaction.find((candle) => candle.timestamp === trigger.timestamp) ?? null;
    if (!triggerCandle) {
      return this.rejectAndNull(
        'noReaction',
        'Trigger timestamp is not inside the reaction window',
      );
    }

    const triggerClose = new Decimal(triggerCandle.close);
    if (!triggerClose.isFinite() || triggerClose.lte(0)) {
      return this.rejectAndNull(
        'noReaction',
        `Invalid trigger close price (${triggerCandle.close})`,
      );
    }

    const idealEntry = triggerClose;

    // D5 REVERT — the stop reference is the ENTIRE reaction window, including
    // the minute that first touched the POI. The touch minute is not noise: its
    // wick is part of the structure that must be violated before the reaction is
    // invalid. Excluding it (the D5 slice) pulled the stop inside the real
    // invalidation and let a normal mitigation wick clip it. The 0.1% floor in
    // `calculateLevels` remains the final defense against a zero offset.
    const microExtreme = reaction.reduce(
      (extreme, candle) => {
        const value = direction === 'BULLISH'
          ? new Decimal(candle.low)
          : new Decimal(candle.high);
        if (extreme === null) return value;
        return direction === 'BULLISH' ? Decimal.min(extreme, value) : Decimal.max(extreme, value);
      },
      null as Decimal | null,
    );

    if (!microExtreme || !microExtreme.isFinite() || microExtreme.lte(0)) {
      return this.rejectAndNull('noReaction', 'Micro-invalidation extreme is invalid');
    }

    // A long must anchor the stop below the reaction low, a short above the high.
    if (
      (direction === 'BULLISH' && microExtreme.gte(idealEntry)) ||
      (direction === 'BEARISH' && microExtreme.lte(idealEntry))
    ) {
      return this.rejectAndNull(
        'noReaction',
        `Micro extreme ${microExtreme.toString()} is on the wrong side of entry ${idealEntry.toString()}`,
      );
    }

    const reactionZone = { top: microExtreme, bottom: microExtreme, direction };

    let baseLevels: TradeLevels;
    try {
      baseLevels = this.calculateLevels(
        idealEntry,
        reactionZone,
        direction,
        atr1m,
        new Decimal(1),
        offsetMultiplier,
      );
    } catch (error) {
      return this.rejectAndNull(
        'noReaction',
        `Stop geometry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      idealEntry,
      reactionZone,
      stopAtr: atr1m,
      baseLevels,
      triggerType: trigger.type === 'CHOCH' ? 'CHoCH' : 'BOS',
      triggerTimestamp: trigger.timestamp,
      triggerPrice: trigger.price,
      triggerLabel: `1m ${trigger.type} @ ${trigger.price.toFixed(4)}`,
    };
  }

  /**
   * Detect BOS/CHoCH on the reaction window with last-valid-swing semantics.
   *
   * Mirrors `PatternRecognizer.detectStructureBreaks` (and Scenario 12's local
   * copy): only the most recent confirmed, unbroken swing can be broken, the
   * broken swing is consumed, and `isValidated` is derived from a BODY close
   * beyond the swing — a wick that merely pierces is not a change of character.
   */
  private detectStructureBreaks(candles: any[], atr: Decimal): Structure[] {
    const structures: Structure[] = [];
    const swingLookback = 3;
    const minBody = atr.mul(this.resolveDisplacementMultiplier());

    const swings: { type: 'HIGH' | 'LOW'; price: Decimal; index: number }[] = [];
    for (let i = swingLookback; i < candles.length - swingLookback; i++) {
      const high = new Decimal(candles[i].high);
      const low = new Decimal(candles[i].low);
      let isHigh = true;
      let isLow = true;

      for (let j = 1; j <= swingLookback; j++) {
        if (
          new Decimal(candles[i - j].high).gte(high) ||
          new Decimal(candles[i + j].high).gte(high)
        ) {
          isHigh = false;
        }
        if (
          new Decimal(candles[i - j].low).lte(low) ||
          new Decimal(candles[i + j].low).lte(low)
        ) {
          isLow = false;
        }
      }

      if (isHigh) swings.push({ type: 'HIGH', price: high, index: i });
      if (isLow) swings.push({ type: 'LOW', price: low, index: i });
    }

    let lastHigh: { price: Decimal; index: number } | null = null;
    let lastLow: { price: Decimal; index: number } | null = null;
    let trend: 'BULLISH' | 'BEARISH' | null = null;
    let swingPtr = 0;

    for (let i = 0; i < candles.length; i++) {
      while (
        swingPtr < swings.length &&
        swings[swingPtr].index <= i - swingLookback
      ) {
        const swing = swings[swingPtr];
        if (swing.type === 'HIGH') lastHigh = swing;
        else lastLow = swing;
        swingPtr++;
      }

      const candle = candles[i];
      const open = new Decimal(candle.open);
      const close = new Decimal(candle.close);
      const body = close.minus(open).abs();

      if (body.lt(minBody)) continue;

      let breakDirection: 'BULLISH' | 'BEARISH' | null = null;
      let brokenSwing: { price: Decimal; index: number } | null = null;

      if (lastHigh && close.gt(lastHigh.price)) {
        breakDirection = 'BULLISH';
        brokenSwing = lastHigh;
        lastHigh = null;
      } else if (lastLow && close.lt(lastLow.price)) {
        breakDirection = 'BEARISH';
        brokenSwing = lastLow;
        lastLow = null;
      }

      if (!breakDirection || !brokenSwing) continue;

      const bodyCloseBeyond =
        breakDirection === 'BULLISH'
          ? close.gt(brokenSwing.price)
          : close.lt(brokenSwing.price);

      const type: 'BOS' | 'CHOCH' =
        trend !== null && trend === breakDirection ? 'BOS' : 'CHOCH';

      trend = breakDirection;
      structures.push({
        type,
        direction: breakDirection,
        timestamp: candle.timestamp,
        price: close,
        isValidated: bodyCloseBeyond,
        timeframe: '1',
        impulseFactor: atr.gt(0) ? body.div(atr) : new Decimal(0),
      });
    }

    return structures;
  }

  /** 1m displacement multiplier — never silently degrades below the documented 1.5. */
  private resolveDisplacementMultiplier(): Decimal {
    const configured = this.config.sniperDisplacementMultiplier;
    if (configured === undefined || configured === null || String(configured).trim() === '') {
      return new Decimal(DEFAULT_SNIPER_DISPLACEMENT);
    }
    return new Decimal(configured);
  }

  /** ATR over the reaction window (Wilder-style simple average of true ranges). */
  private calculateATR(candles: any[], period: number = 14): Decimal {
    if (candles.length < period + 1) return new Decimal(0);
    let trSum = new Decimal(0);
    for (let i = candles.length - period; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const high = new Decimal(current.high);
      const low = new Decimal(current.low);
      const prevClose = new Decimal(prev.close);
      const tr = Decimal.max(
        high.minus(low),
        high.minus(prevClose).abs(),
        low.minus(prevClose).abs(),
      );
      trSum = trSum.plus(tr);
    }
    return trSum.dividedBy(period);
  }
}
