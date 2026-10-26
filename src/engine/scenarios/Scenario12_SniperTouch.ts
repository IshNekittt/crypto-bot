import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { ROUND_TRIP_TAKER_FEE } from '../../config/fees';
import { PatternData, MacroContext, Structure } from '../../smc/patternRecognizer';
import { resolveTakeProfit } from '../tpResolver';
import { logger } from '../../utils/logger';

/**
 * Asset admission floor: the 1m ATR must clear the round-trip taker cost by this
 * multiple. 0.110% × 1.5 = 0.165%. Below it the tape is quieter than the fee it
 * pays, and the win rate required to break even becomes unattainable.
 */
/**
 * Minimum fee-inclusive reward:risk:
 *
 *   netRr = (targetDistance − roundTripFee) / (stopDistance + roundTripFee)
 *
 * A nominal 1.5R target with a stop smaller than the fee is a net loser even
 * when it hits. This floor is measured in price units on the SAME entry the
 * trade will be booked against, so it cannot be gamed by a favourable fill.
 */

/** CHoCH / OB must sit within 0.3% of the swept level (or the source's ATR band, whichever is wider). */
const MIN_PROXIMITY_PCT = new Decimal('0.003');
/** Macro liquidity keeps the full 1 ATR(15m) proximity band. */
const MACRO_PROXIMITY_ATR = new Decimal(1);
/** Intraday sources (session extremes, EQH/EQL) use a tighter half-ATR band. */
const INTRADAY_PROXIMITY_ATR = new Decimal('0.5');
/** 1m lookback used to find the most recent sweep of each level (50 minutes). */
const SWEEP_LOOKBACK_1M = 50;
/** 15m candles used to derive the dealing range when `tradingRange` is absent. */
const DEALING_RANGE_LOOKBACK = 50;
/** Higher-timeframe tags produced by `buildPatternData`. */
const HTF_TIMEFRAMES = new Set<string>(['240', '360', '720', 'D', 'W', 'M']);
/** 4H SMA period for Scenario 12's persistent trend gate. */
const HTF_TREND_SMA_PERIOD = 50;
/**
 * Minimum closed 4H candles required to evaluate the trend gate. Below this the
 * filter fails closed: an undefined trend must never silently admit a
 * counter-trend reversal (the exact fail-open hole the SMA gate closes).
 */
const HTF_TREND_MIN_CANDLES = 20;
/** 0.2% band around the 4H SMA50 so a flat market is not classified as a trend. */
const HTF_TREND_TOLERANCE_PCT = new Decimal('0.002');
/** Default 1m displacement multiplier (AGENTS.md §7.2) used when config omits it. */
const DEFAULT_SNIPER_DISPLACEMENT = '1.5';

/**
 * Where a sweepable level comes from. The ranking is also the price-dedupe
 * priority: when a macro level, a session extreme and an EQH/EQL print the same
 * price, the macro level owns it (PDH > Session > EQH/EQL).
 */
type SweepSourceKind = 'MACRO' | 'SESSION' | 'EQH_EQL';

const SWEEP_SOURCE_PRIORITY: Record<SweepSourceKind, number> = {
  MACRO: 0,
  SESSION: 1,
  EQH_EQL: 2,
};

interface SweepLevel {
  readonly price: Decimal;
  readonly name: string;
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly kind: SweepSourceKind;
}

interface SweptLevel extends SweepLevel {
  /** Timestamp of this level's most recent SFP. Causality anchor for pairing. */
  readonly sweptAt: number;
}

interface ChochSweepPairing {
  readonly choch: Structure;
  readonly swept: SweptLevel;
}

/** A fully-resolved pairing: CHoCH + its sweep anchor + the entry Order Block. */
interface SniperCandidate {
  readonly pairing: ChochSweepPairing;
  readonly ob: { top: Decimal; bottom: Decimal };
  readonly obMidpoint: Decimal;
  readonly obDistance: Decimal;
  readonly tolerance: Decimal;
}

/**
 * Rejection funnel counters for Scenario 12.
 *
 * Static (class-level) because the reporter reads them without an instance,
 * mirroring Scenario 2/4/5/7/8/9/10/11. Every evaluation increments `totalEvals`
 * and then EXACTLY ONE rejection bucket (or `triggered`), so the buckets always
 * sum to `totalEvals - triggered` — the funnel is auditable rather than a pile of
 * independent counters.
 *
 * `sweepFound` and `levelTouched` are informational and deliberately NOT part of
 * that partition: they measure how much of the funnel survives the pre-sweep
 * stage, which is what makes the post-sweep gates comparable to each other.
 */
const EMPTY_REJECTION_STATS = {
  totalEvals: 0,
  triggered: 0,
  // --- pre-sweep ---
  insufficientCandles: 0,
  disabled: 0,
  killzone: 0,
  noMacroLevels: 0,
  noSweep: 0,
  weakWick: 0,
  // --- post-sweep ---
  htfContradiction: 0,
  invalidAtr: 0,
  insufficientVolatility: 0,
  noChoch: 0,
  bodyClose: 0,
  noOb: 0,
  proximity: 0,
  premiumDiscount: 0,
  geometry: 0,
  insufficientNetR: 0,
  insufficientRoom: 0,
  tpInvalid: 0,
  // --- informational (not part of the exclusive partition) ---
  levelTouched: 0,
  sweepFound: 0,
};

/** Rejection buckets only — `totalEvals`/`triggered`/informational keys excluded. */
type S12RejectionKey = Exclude<
  keyof typeof EMPTY_REJECTION_STATS,
  'totalEvals' | 'triggered' | 'levelTouched' | 'sweepFound'
>;

export class Scenario12_SniperTouch extends BaseScenario {
  private static rejectionStats: Record<keyof typeof EMPTY_REJECTION_STATS, number> = {
    ...EMPTY_REJECTION_STATS,
  };

  static getRejectionStats(): Record<keyof typeof EMPTY_REJECTION_STATS, number> {
    return { ...Scenario12_SniperTouch.rejectionStats };
  }

  static resetStats(): void {
    Scenario12_SniperTouch.rejectionStats = { ...EMPTY_REJECTION_STATS };
  }

  constructor(config: BotConfig) {
    super(12, 'Sniper Touch (1m Macro)', config);
  }

  /**
   * Record a rejection in the funnel and return `false`, so call sites read as
   * `return this.reject('weakWick', '...')` and no gate can bypass the counters.
   */
  private reject(key: S12RejectionKey, reason: string): false {
    Scenario12_SniperTouch.rejectionStats[key] += 1;
    this.logRejection(reason);
    return false;
  }

  // Override evaluate to accept 1m candles
  protected override evaluateInternal(patternData: PatternData & { candles1m?: any[] }): boolean {
    Scenario12_SniperTouch.rejectionStats.totalEvals += 1;

    const candles1m = patternData.candles1m;
    if (!candles1m || candles1m.length < 50) {
      return this.reject('insufficientCandles', 'Insufficient 1m candles (need 50+)');
    }

    // Check if Sniper Mode is enabled in config
    if (!patternData.macroContext || !this.config.enableSniperMode) {
      return this.reject('disabled', 'Sniper Mode disabled or no macro context');
    }

    // === FILTER 1: KILLZONE CHECK ===
    // Sniper only trades during London or NY killzones (bypassable via ENFORCE_KILLZONES=false)
    const currentKillzone = patternData.currentKillzone;
    if (this.config.enforceKillzones !== false && currentKillzone !== 'LONDON' && currentKillzone !== 'NY') {
      return this.reject('killzone', `Outside killzone: ${currentKillzone}`);
    }

    // === FILTER 2A: SWEEP SOURCES ===
    // Macro liquidity (PDH/PDL/PWH/PWL) is always armed. Session extremes and
    // EQH/EQL are opt-in (S12_SESSION_SWEEPS / S12_EQH_EQL_SWEEPS) because they
    // widen the trigger set and must be measured independently before defaulting on.
    const macro = patternData.macroContext as MacroContext & { dailyLevels: any; weeklyLevels: any };
    const sweepLevels = this.buildSweepLevels(patternData, macro);

    if (sweepLevels.length === 0) {
      return this.reject('noMacroLevels', 'No valid sweep levels');
    }

    // === FILTER 2B: SWEEP VALIDATION (SFP - Swing Failure Pattern) ===
    // Sweep = wick pierces level, body closes back inside.
    //
    // Each level keeps its OWN `sweptAt`. A single global "latest sweep" would let a
    // later sweep of an unrelated level invalidate a CHoCH that the earlier sweep had
    // already justified — the sweep that actually caused the reversal is the only
    // valid causality anchor for that reversal.
    const lookbackCandles = candles1m.slice(-SWEEP_LOOKBACK_1M); // Last 50 minutes
    const { swept, weakSweeps } = this.detectLevelSweeps(lookbackCandles, sweepLevels);

    if (swept.length === 0) {
      return weakSweeps.length > 0
        ? this.reject(
            'weakWick',
            `Sweep rejected: insufficient rejection wick (${weakSweeps.join('; ')})`
          )
        : this.reject('noSweep', `No valid sweep of any level in last ${SWEEP_LOOKBACK_1M} min`);
    }

    Scenario12_SniperTouch.rejectionStats.sweepFound += 1;

    // === FILTER 3: VALID CHoCH + ORDER BLOCK ENTRY ===
    // Calculate ATR for 1m candles
    const atr1m = this.calculateATR(candles1m, 14);
    if (atr1m.lte(0)) {
      return this.reject('invalidAtr', 'Invalid ATR');
    }

    // === FILTER 3A: ASSET ADMISSION (VIABILITY RATIO) ===
    // The 1m ATR is the tape's natural unit of risk; the round-trip fee is the
    // exchange's fixed unit of cost. When ATR is comparable to (or smaller than)
    // the fee, the stop is noise-wide relative to the cost of placing it and the
    // trade is fee-dominated regardless of win rate. Linked at 1.5x so the fee
    // can never consume more than two thirds of one ATR of movement.
    const atrReferencePrice = new Decimal(candles1m[candles1m.length - 1].close);
    if (atrReferencePrice.lte(0)) {
      return this.reject('invalidAtr', 'Invalid reference price for ATR viability');
    }
    const atr1mPct = atr1m.div(atrReferencePrice);
    const minViableAtrPct = ROUND_TRIP_TAKER_FEE.mul(this.config.minVolatilityFeeRatio);
    if (atr1mPct.lt(minViableAtrPct)) {
      return this.reject(
        'insufficientVolatility',
        `1m ATR ${atr1mPct.mul(100).toFixed(3)}% < viability floor ${minViableAtrPct
          .mul(100)
          .toFixed(3)}% (${this.config.minVolatilityFeeRatio.toString()}x round-trip fee ${ROUND_TRIP_TAKER_FEE.mul(
          100
        ).toFixed(3)}%)`
      );
    }

    // Detect structure breaks on 1m candles
    const structures = this.detectStructureBreaks(candles1m, atr1m);

    // Filter out already mitigated structures (ghost signal prevention).
    // Timestamp is the identity — direction/type may be lost in transit (Invariant 25).
    const mitigatedStructures = (patternData as any).mitigatedStructures || [];
    const isMitigated = (s: Structure) =>
      mitigatedStructures.some((ms: any) => ms.timestamp === s.timestamp);

    const freshnessFloor = candles1m[candles1m.length - 30]?.timestamp ?? 0;
    const freshChochs = structures.filter(
      (s) => s.type === 'CHOCH' && s.timestamp >= freshnessFloor && !isMitigated(s)
    );

    if (freshChochs.length === 0) {
      return this.reject('noChoch', 'No fresh CHoCH in the last 30 1m candles');
    }

    // === FILTER 3.1: SWEEP → CHoCH CAUSALITY (per-CHoCH pairing) ===
    // A CHoCH is justified by a sweep that happened BEFORE it. Every such pair is a
    // candidate; the winning pair is chosen after geometry, never by discarding the
    // newer CHoCH just because a different level was swept later.
    let pairings = this.pairChochsWithSweeps(freshChochs, swept);

    if (pairings.length === 0) {
      return this.reject(
        'noChoch',
        `No CHoCH after sweep of ${swept.map((s) => s.name).join(', ')}`
      );
    }

    // === FILTER 3.2: HTF (4H) BIAS ===
    // A 1m reversal against an expanding 4H trend is trading into the dominant
    // flow. Counter-HTF entries are allowed ONLY at the unmitigated opposing 4H
    // POI — the structural place where the HTF move would actually exhaust.
    // Evaluated per direction: the cache prevents recomputing the same filter for
    // every pairing (a zone scan is not free).
    const currentPrice = new Decimal(candles1m[candles1m.length - 1].close);
    const htfBiasCache = new Map<'BULLISH' | 'BEARISH', boolean>();
    const passesHtf = (dir: 'BULLISH' | 'BEARISH'): boolean => {
      const cached = htfBiasCache.get(dir);
      if (cached !== undefined) return cached;
      const pass = this.passesHtfBiasFilter(patternData, dir, currentPrice);
      htfBiasCache.set(dir, pass);
      return pass;
    };

    pairings = pairings.filter((p) => passesHtf(p.choch.direction));
    if (pairings.length === 0) {
      return this.reject('htfContradiction', 'HTF trend contradicts reversal direction');
    }

    // TRUE BODY-CLOSE VALIDATION (V8): the detector derives `isValidated` from
    // candle geometry, so this gate can actually fail. A wick that merely pierces
    // a swing is not a change of character.
    pairings = pairings.filter((p) => this.isValidBodyClose(p.choch));
    if (pairings.length === 0) {
      return this.reject(
        'bodyClose',
        'CHoCH not validated by a body close beyond the swing level'
      );
    }

    // === FILTER 3.3: ORDER BLOCK + SOURCE-AWARE PROXIMITY ===
    // The entry OB is the actual POI, so its MIDPOINT (the real entry price) must sit
    // near the liquidity that was just swept. Nearest-edge distance is misleading for
    // wide blocks: an OB can straddle the level while its midpoint is far away.
    // Tolerance = max(source band, 0.3% floor): 1 ATR(15m) for macro liquidity,
    // 0.5 ATR(15m) for intraday sources (session extremes, EQH/EQL).
    const atr15m = this.resolveAtr15m(patternData);
    const indexByTimestamp = new Map<number, number>();
    candles1m.forEach((c: any, i: number) => indexByTimestamp.set(c.timestamp, i));

    const obCache = new Map<number, { top: Decimal; bottom: Decimal } | null>();
    const candidates: SniperCandidate[] = [];
    let missingOb = 0;
    let tooFar = 0;
    let smallestGap: Decimal | null = null;
    let proximityDetail = '';

    for (const pairing of pairings) {
      const choch = pairing.choch;

      let ob = obCache.get(choch.timestamp);
      if (ob === undefined) {
        const chochIndex = indexByTimestamp.get(choch.timestamp) ?? -1;
        ob = this.findOrderBlock(candles1m, chochIndex, choch.direction);
        obCache.set(choch.timestamp, ob);
      }

      // NO SYNTHETIC FALLBACK (V5/V6).
      // Without a real opposite-colour candle at the CHoCH origin there is no order
      // block: no displacement origin, no imbalance, no mitigation state. Inventing
      // a 0.1% band at a local extreme fabricates both the entry and the stop, and
      // it makes the midpoint proximity test structurally unfalsifiable.
      if (!ob) {
        missingOb += 1;
        continue;
      }

      const obMidpoint = ob.top.plus(ob.bottom).div(2);
      const tolerance = this.resolveProximityTolerance(atr15m, pairing.swept);
      const obDistance = obMidpoint.minus(pairing.swept.price).abs();

      if (obDistance.gt(tolerance)) {
        tooFar += 1;
        // Keep the tightest miss as the rejection detail — it is the setup that was
        // closest to qualifying and therefore the most useful for calibration.
        const gap = obDistance.minus(tolerance);
        if (smallestGap === null || gap.lt(smallestGap)) {
          smallestGap = gap;
          proximityDetail =
            `Entry too far from swept ${pairing.swept.name} (${pairing.swept.price.toFixed(4)}): ` +
            `CHoCH=${choch.price.minus(pairing.swept.price).abs().toFixed(4)}, ` +
            `OB_MID=${obDistance.toFixed(4)}, tolerance=${tolerance.toFixed(4)} ` +
            `(${pairing.swept.kind === 'MACRO' ? '1xATR15m' : '0.5xATR15m'} / 0.3%)`;
        }
        continue;
      }

      candidates.push({ pairing, ob, obMidpoint, obDistance, tolerance });
    }

    if (candidates.length === 0) {
      if (tooFar > 0) return this.reject('proximity', proximityDetail);
      if (missingOb > 0) return this.reject('noOb', 'No valid Order Block at CHoCH origin');
      // Unreachable: every pairing either produced a candidate or one of the misses
      // above. Fail closed rather than trading an unexplained path.
      return this.reject('noChoch', 'No CHoCH survived pairing');
    }

    // Deterministic winner: newest CHoCH, then closest OB, then most recent sweep.
    candidates.sort((a, b) => {
      const chochDelta = b.pairing.choch.timestamp - a.pairing.choch.timestamp;
      if (chochDelta !== 0) return chochDelta;
      const distanceDelta = a.obDistance.comparedTo(b.obDistance);
      if (distanceDelta !== 0) return distanceDelta;
      return b.pairing.swept.sweptAt - a.pairing.swept.sweptAt;
    });

    const winner = candidates[0];
    const choch = winner.pairing.choch;
    const sweptLevel = winner.pairing.swept;
    const entryOB = winner.ob;
    const direction: 'BULLISH' | 'BEARISH' = choch.direction;
    const chochPrice = choch.price;
    const obMidpoint = winner.obMidpoint;

    // === FILTER 3.4: PREMIUM / DISCOUNT ===
    // A reversal long must be bought in discount and a reversal short sold in
    // premium, measured against the dealing range. Entering a PDL sweep at the
    // top of the range is chasing price, not SMC.
    if (!this.passesPremiumDiscountFilter(patternData, direction, obMidpoint)) {
      return this.reject('premiumDiscount', 'Entry violates Premium/Discount equilibrium');
    }

    // idealEntry = 0.5 of the Order Block (midpoint)
    const idealEntry = entryOB.top.plus(entryOB.bottom).div(2);

    // Create OB zone for calculateLevels
    const obZone = {
      top: entryOB.top,
      bottom: entryOB.bottom,
      direction: direction,
    };

    // Safety check: entry must be on correct side of zone extreme
    const localExtreme = direction === 'BULLISH' ? entryOB.bottom : entryOB.top;
    if (direction === 'BULLISH' && idealEntry.lte(localExtreme)) {
      return this.reject('geometry', 'Invalid SL for long');
    }
    if (direction === 'BEARISH' && idealEntry.gte(localExtreme)) {
      return this.reject('geometry', 'Invalid SL for short');
    }

    // === STOP GEOMETRY (single source of truth) ===
    // `rr = 1` is only a placeholder: this call is consumed for the STOP. The
    // target is resolved from market structure below.
    const offsetMultiplier = this.config.smcSlAtrOffset
      ? new Decimal(this.config.smcSlAtrOffset)
      : new Decimal('0.5');

    const baseLevels = this.calculateLevels(
      idealEntry,
      obZone,
      direction,
      atr1m,
      new Decimal(1),
      offsetMultiplier
    );

    // === TAKE-PROFIT (structural, not a constant multiple) ===
    // A blind 3R target is algebraically the stop distance restated: it carries
    // no information about where price can actually go. Fees in R units are
    // `f = c / s`, so a tight stop turns a nominal 3R win into a net loss.
    // See `src/engine/tpResolver.ts` for the derivation and the wall filter.
    const resolution = resolveTakeProfit({
      direction,
      entry: baseLevels.entry,
      stopLoss: baseLevels.stopLoss,
      zones: patternData.zones ?? [],
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange,
      macroContext: patternData.macroContext,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
    });

    if (!resolution.ok) {
      // The wall filter ("Insufficient room") is the only rejection that depends on
      // DYNAMIC_TP_MIN_RR. It gets its own bucket so calibration can be measured
      // instead of guessed at.
      const key: S12RejectionKey = resolution.reason.startsWith('Insufficient room')
        ? 'insufficientRoom'
        : 'tpInvalid';
      return this.reject(key, `Take-profit rejected: ${resolution.reason}`);
    }

    // === FILTER 4A: FEE-INCLUSIVE NET R:R FLOOR ===
    // Nominal R:R is a lie once the exchange is paid. Both legs of the trade are
    // charged, so the fee is subtracted from the reward AND added to the risk:
    //
    //   netRr = (targetDistance − roundTripFee) / (stopDistance + roundTripFee)
    //
    // This is the deterministic kill switch for the sub-1.0 Net-RR trades: a
    // target that is nominally 1.5R but sits inside the fee envelope is rejected
    // here instead of being discovered as a loss on the exchange.
    const stopDistance = baseLevels.entry.minus(baseLevels.stopLoss).abs();
    if (stopDistance.lte(0)) {
      return this.reject('geometry', 'Zero stop distance — Net-R undefined');
    }
    const targetDistance = resolution.takeProfit.minus(baseLevels.entry).abs();
    const roundTripFeeInPrice = baseLevels.entry.mul(ROUND_TRIP_TAKER_FEE);
    const netRr = targetDistance.minus(roundTripFeeInPrice).div(stopDistance.plus(roundTripFeeInPrice));

    if (netRr.lt(this.config.minNetRr)) {
      return this.reject(
        'insufficientNetR',
        `Net R:R ${netRr.toFixed(3)} < ${this.config.minNetRr.toString()} (target ${targetDistance
          .div(baseLevels.entry)
          .mul(100)
          .toFixed(3)}% | stop ${stopDistance.div(baseLevels.entry).mul(100).toFixed(3)}% | fee ${ROUND_TRIP_TAKER_FEE.mul(
          100
        ).toFixed(3)}%)`
      );
    }

    // === FILTER 4B: FEE-AWARE TARGET DISTANCE FLOOR ===
    // Bybit charges ~0.11% round-trip taker fees. A target closer than
    // `minTpDistancePct` (default 0.35%) hands 30-45% of the gross move to the
    // exchange, so the trade is fee-dominated even when it reaches TP. This is a
    // hard floor on the RESOLVED target, so it covers structural and fixed-R alike.
    const targetDistancePct = resolution.takeProfit.minus(idealEntry).abs().div(idealEntry);
    if (targetDistancePct.lt(this.config.minTpDistancePct)) {
      return this.reject(
        'insufficientRoom',
        `Target distance ${targetDistancePct.mul(100).toFixed(3)}% < fee threshold ${this.config.minTpDistancePct.mul(100).toFixed(2)}%`
      );
    }

    const levels = this.calculateLevelsWithTarget(
      idealEntry,
      obZone,
      direction,
      atr1m,
      resolution.takeProfit,
      offsetMultiplier
    );

    // SAFETY NET: Hard mathematical check to prevent invalid SL levels reaching the exchange
    if (direction === 'BULLISH' && levels.stopLoss.gte(levels.entry)) {
      return this.reject(
        'geometry',
        `Math Error: BULLISH SL (${levels.stopLoss}) >= Entry (${levels.entry})`
      );
    }
    if (direction === 'BEARISH' && levels.stopLoss.lte(levels.entry)) {
      return this.reject(
        'geometry',
        `Math Error: BEARISH SL (${levels.stopLoss}) <= Entry (${levels.entry})`
      );
    }

    // Set levels and details.
    // NOTE: Scenario 12 intentionally emits ONLY structureDetails (the 1m CHoCH).
    // Emitting a synthetic zone at the macro level would let burnSetup() add the
    // macro pool to mitigatedZones, violating Invariant 21 (macro pools are never burned).
    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    this.setReason(
      `Sniper: ${direction} CHoCH at ${chochPrice.toFixed(4)} after ${sweptLevel.name} sweep ` +
      `(${sweptLevel.kind}), entry from 1m OB midpoint`
    );

    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction: choch.direction,
    });

    Scenario12_SniperTouch.rejectionStats.triggered += 1;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Sweep sources, per-level causality, and OB geometry
  // ---------------------------------------------------------------------------

  /**
   * Build the ordered set of sweepable levels.
   *
   * Macro liquidity is always armed. Session extremes and EQH/EQL are opt-in via
   * `S12_SESSION_SWEEPS` / `S12_EQH_EQL_SWEEPS`; when disabled the trigger set is
   * exactly the legacy macro-only set.
   *
   * Only the most recent ASIAN range is used: older Asian sessions are days-old
   * context and their extremes have usually been consumed already.
   */
  private buildSweepLevels(
    patternData: PatternData,
    macro: MacroContext & { dailyLevels: any; weeklyLevels: any }
  ): SweepLevel[] {
    const levels: SweepLevel[] = [];

    const push = (
      price: unknown,
      name: string,
      direction: 'BULLISH' | 'BEARISH',
      kind: SweepSourceKind
    ) => {
      if (!(price instanceof Decimal) || !price.gt(0)) return;
      levels.push({ price, name, direction, kind });
    };

    // --- Macro liquidity (always armed) ---
    push(macro.dailyLevels?.pdh, 'PDH', 'BEARISH', 'MACRO');
    push(macro.dailyLevels?.pdl, 'PDL', 'BULLISH', 'MACRO');
    push(macro.weeklyLevels?.pwh, 'PWH', 'BEARISH', 'MACRO');
    push(macro.weeklyLevels?.pwl, 'PWL', 'BULLISH', 'MACRO');

    // --- Session extremes (opt-in): newest ASIAN high/low ---
    if (this.config.s12SessionSweeps === true) {
      const sessionRanges = patternData.sessionRanges ?? [];
      for (let i = sessionRanges.length - 1; i >= 0; i--) {
        const range = sessionRanges[i];
        if (range.name !== 'ASIAN') continue;
        push(range.high, 'ASIAN HIGH', 'BEARISH', 'SESSION');
        push(range.low, 'ASIAN LOW', 'BULLISH', 'SESSION');
        break;
      }
    }

    // --- Equal highs / equal lows (opt-in) ---
    if (this.config.s12EqhEqlSweeps === true) {
      for (const pool of patternData.liquidityPools ?? []) {
        if (pool.type === 'EQH') {
          push(pool.priceLevel, 'EQH', 'BEARISH', 'EQH_EQL');
        } else if (pool.type === 'EQL') {
          push(pool.priceLevel, 'EQL', 'BULLISH', 'EQH_EQL');
        }
      }
    }

    return this.dedupeSweepLevels(levels);
  }

  /**
   * Price-dedupe with source priority: when two sources print the same price the
   * higher-priority one owns it (PDH > Session > EQH/EQL). Duplicate levels would
   * otherwise produce two identical pairings and inflate the funnel.
   *
   * The sort is stable, so ordering within a source kind stays deterministic
   * (PDH before PDL before PWH before PWL, as built).
   */
  private dedupeSweepLevels(levels: SweepLevel[]): SweepLevel[] {
    const ordered = [...levels].sort(
      (a, b) => SWEEP_SOURCE_PRIORITY[a.kind] - SWEEP_SOURCE_PRIORITY[b.kind]
    );

    const kept: SweepLevel[] = [];
    for (const level of ordered) {
      if (kept.some((existing) => existing.price.eq(level.price))) continue;
      kept.push(level);
    }
    return kept;
  }

  /**
   * Find each level's most recent SFP inside the lookback window.
   *
   * Scanning newest -> oldest means the first hit is that level's newest sweep;
   * older touches are history and cannot justify a fresh reversal. A touch that
   * fails the rejection-wick quality gate terminates the scan for that level —
   * a one-tick poke followed by a full-body close is liquidity consumption, not
   * absorption, so there is no defended sweep to trade.
   */
  private detectLevelSweeps(
    lookbackCandles: any[],
    levels: SweepLevel[]
  ): { swept: SweptLevel[]; weakSweeps: string[] } {
    const swept: SweptLevel[] = [];
    const weakSweeps: string[] = [];
    const minWickRatio = this.config.smcSweepMinWickRatio;

    for (const level of levels) {
      const isResistance = level.direction === 'BEARISH';
      const levelPrice = level.price;

      for (let i = lookbackCandles.length - 1; i >= 0; i--) {
        const candle = lookbackCandles[i];
        const high = new Decimal(candle.high);
        const low = new Decimal(candle.low);
        const open = new Decimal(candle.open);
        const close = new Decimal(candle.close);

        const isSweep = isResistance
          ? high.gt(levelPrice) && close.lt(levelPrice)
          : low.lt(levelPrice) && close.gt(levelPrice);

        if (!isSweep) continue;

        Scenario12_SniperTouch.rejectionStats.levelTouched += 1;

        const range = high.minus(low);
        const wick = isResistance
          ? high.minus(Decimal.max(open, close))
          : Decimal.min(open, close).minus(low);
        const wickRatio = range.gt(0) ? wick.div(range) : new Decimal(0);

        if (wickRatio.lt(minWickRatio)) {
          weakSweeps.push(
            `${level.name} wick ${wickRatio.mul(100).toFixed(1)}% < ${minWickRatio.mul(100).toString()}%`
          );
          break;
        }

        swept.push({ ...level, sweptAt: candle.timestamp });
        break;
      }
    }

    return { swept, weakSweeps };
  }

  /**
   * Pair every fresh CHoCH with every direction-matched sweep that PRECEDES it.
   *
   * Causality is strictly `sweptAt < choch.timestamp`: a CHoCH on the sweep candle
   * itself is ambiguous (the break may be the sweep's own wick) and is rejected.
   * A later sweep of a different level never invalidates an earlier valid pair.
   */
  private pairChochsWithSweeps(
    chochs: Structure[],
    swept: SweptLevel[]
  ): ChochSweepPairing[] {
    const pairings: ChochSweepPairing[] = [];

    for (const choch of chochs) {
      for (const level of swept) {
        if (level.direction !== choch.direction) continue;
        if (level.sweptAt >= choch.timestamp) continue;
        pairings.push({ choch, swept: level });
      }
    }

    return pairings;
  }

  /**
   * Source-aware proximity band.
   *
   * Macro level:   max(1.0 x ATR15m, 0.3% of level)
   * Intraday level: max(0.5 x ATR15m, 0.3% of level)
   *
   * The 0.3% floor keeps the gate meaningful in dead volatility, where ATR-based
   * bands collapse to zero.
   */
  private resolveProximityTolerance(atr15m: Decimal, level: SweptLevel): Decimal {
    const atrBand =
      level.kind === 'MACRO'
        ? atr15m.mul(MACRO_PROXIMITY_ATR)
        : atr15m.mul(INTRADAY_PROXIMITY_ATR);

    return Decimal.max(atrBand, level.price.mul(MIN_PROXIMITY_PCT));
  }

  /**
   * The Order Block that produced the CHoCH: the last opposite-colour candle in
   * the 5 candles before the break. Returns null when there is none — never a
   * synthetic band (see the rejection rationale in `evaluateInternal`).
   */
  private findOrderBlock(
    candles: any[],
    chochIndex: number,
    direction: 'BULLISH' | 'BEARISH'
  ): { top: Decimal; bottom: Decimal } | null {
    if (chochIndex <= 0) return null;

    for (let i = chochIndex - 1; i >= Math.max(0, chochIndex - 5); i--) {
      const c = candles[i];
      const isBullishCandle = new Decimal(c.close).gt(c.open);
      const isOB = direction === 'BULLISH' ? !isBullishCandle : isBullishCandle;

      if (!isOB) continue;

      return { top: new Decimal(c.high), bottom: new Decimal(c.low) };
    }

    return null;
  }

  /**
   * Resolve the 15m ATR used for the proximity tolerance.
   *
   * patternData.atr15m is the canonical, router-computed value and MUST be preferred.
   * A local ATR(14) recomputation is only a defensive fallback — it is explicitly
   * logged as such so a missing ATR never silently masquerades as the canonical one.
   */
  private resolveAtr15m(patternData: PatternData): Decimal {
    const provided = patternData.atr15m;
    if (provided instanceof Decimal && provided.gt(0)) {
      return provided;
    }

    logger.warn(
      `[Scenario 12] patternData.atr15m is missing or invalid (${String(provided)}) — ` +
      `FALLBACK ATR will be computed from candles15m. Proximity tolerance may differ from the canonical ATR.`,
    );

    const candles15m = patternData.candles15m;
    if (Array.isArray(candles15m) && candles15m.length >= 15) {
      const atr = this.calculateATR(candles15m, 14);
      if (atr.gt(0)) {
        logger.warn(`[Scenario 12] FALLBACK LTF ATR(14) = ${atr.toString()} used for proximity tolerance.`);
        return atr;
      }
      logger.error(
        `[Scenario 12] FALLBACK ATR(14) computed to ${atr.toString()} from ${candles15m.length} candles — unusable.`,
      );
    } else {
      logger.error(
        `[Scenario 12] FALLBACK ATR unavailable: candles15m has ${Array.isArray(candles15m) ? candles15m.length : 0} candles (need >= 15).`,
      );
    }

    logger.error(
      '[Scenario 12] No usable ATR — proximity tolerance collapses to the 0.3% percentage floor only.',
    );
    return new Decimal(0);
  }

  // Helper: Calculate ATR
  private calculateATR(candles: any[], period: number = 14): Decimal {
    if (candles.length < period + 1) return new Decimal(0);
    let trSum = new Decimal(0);
    for (let i = candles.length - period; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const high = new Decimal(current.high);
      const low = new Decimal(current.low);
      const prevClose = new Decimal(prev.close);
      const tr = Decimal.max(high.minus(low), high.minus(prevClose).abs(), low.minus(prevClose).abs());
      trSum = trSum.plus(tr);
    }
    return trSum.dividedBy(period);
  }

  // ---------------------------------------------------------------------------
  // Phase 4 filters
  // ---------------------------------------------------------------------------

  /**
   * HTF (4H) bias filter.
   *
   * Two independent gates, both causal:
   *
   * 1. **Persistent trend (SMA50)** — 4H BOS/CHoCH prints are sparse (4-9 per
   *    1,000 candles), so a structure-only gate fell through to "neutral" most of
   *    the time and admitted counter-trend reversals into an expanding market. A
   *    causal SMA of the last 50 closed 4H closes is always defined once history
   *    exists, so the absence of a break can no longer masquerade as neutrality.
   *    Shorts require the 4H close at/below SMA50 (+0.2% tolerance), longs require
   *    it at/above SMA50 (-0.2%), unless price sits at the unmitigated opposing
   *    4H POI — the structural place where the HTF move would actually exhaust.
   *    With fewer than 20 closed 4H candles the filter fails closed.
   *
   * 2. **Structure confirmation** — when a 4H BOS/CHoCH exists, its direction must
   *    agree with the reversal (or the POI exception applies).
   *
   * "Exhaustion" is therefore expressed structurally (price at the POI), never as
   * a time heuristic, so the rule stays causal and testable.
   */
  private passesHtfBiasFilter(
    patternData: PatternData,
    direction: 'BULLISH' | 'BEARISH',
    currentPrice: Decimal
  ): boolean {
    // === GATE 1: PERSISTENT 4H TREND (SMA50) ===
    const htfCandles = patternData.candles4h ?? [];
    if (htfCandles.length < HTF_TREND_MIN_CANDLES) return false;

    let sma50: Decimal;
    let lastClose: Decimal;
    try {
      // `candles4h` is closed-candle history (live feed and backtester both slice
      // causally), so the newest entry is the last confirmed 4H close.
      const window = htfCandles.slice(-HTF_TREND_SMA_PERIOD);
      sma50 = window
        .reduce((acc, c) => acc.plus(new Decimal(c.close)), new Decimal(0))
        .div(window.length);
      lastClose = new Decimal(htfCandles[htfCandles.length - 1].close);
    } catch {
      // Malformed history cannot prove trend alignment -> fail closed.
      return false;
    }

    const tolerance = sma50.mul(HTF_TREND_TOLERANCE_PCT);
    const atOpposingPoi = this.isAtOpposingHtfZone(patternData, direction, currentPrice);

    if (direction === 'BEARISH' && lastClose.gt(sma50.plus(tolerance)) && !atOpposingPoi) {
      return false;
    }
    if (direction === 'BULLISH' && lastClose.lt(sma50.minus(tolerance)) && !atOpposingPoi) {
      return false;
    }

    // === GATE 2: STRUCTURE CONFIRMATION ===
    const htfStructures = (patternData.structures ?? []).filter(
      (s) =>
        HTF_TIMEFRAMES.has(String(s.timeframe)) &&
        (s.type === 'BOS' || s.type === 'CHOCH')
    );

    if (htfStructures.length === 0) return true;

    // `structures` are timestamp-ascending (buildPatternData sorts them), so the
    // last entry is the newest 4H break.
    const latest = htfStructures[htfStructures.length - 1];
    if (latest.direction === direction) return true;

    return atOpposingPoi;
  }

  /**
   * True when `price` sits inside (or within 0.1% of) an unmitigated HTF zone
   * matching the trade direction: 4H supply for a short reversal, 4H demand for
   * a long reversal.
   */
  private isAtOpposingHtfZone(
    patternData: PatternData,
    direction: 'BULLISH' | 'BEARISH',
    price: Decimal
  ): boolean {
    const tolerance = price.mul(new Decimal('0.001'));

    return (patternData.zones ?? []).some((zone) => {
      if (!HTF_TIMEFRAMES.has(String(zone.timeframe))) return false;
      if (zone.mitigated) return false;
      if (zone.direction !== direction) return false;

      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const top = Decimal.max(zone.top, zone.bottom);
      const bottom = Decimal.min(zone.top, zone.bottom);

      return price.gte(bottom.minus(tolerance)) && price.lte(top.plus(tolerance));
    });
  }

  /**
   * Premium/Discount filter.
   *
   * Longs are only permitted at or below the dealing-range equilibrium (discount);
   * shorts only at or above it (premium). An entry exactly at equilibrium is
   * allowed for both — it is the boundary, not a violation.
   */
  private passesPremiumDiscountFilter(
    patternData: PatternData,
    direction: 'BULLISH' | 'BEARISH',
    price: Decimal
  ): boolean {
    const dealingRange = this.resolveDealingRange(patternData);
    if (!dealingRange) return true; // no range -> filter is neutral, not fail-closed

    const zone = this.classifyPremiumDiscount(
      patternData,
      price,
      dealingRange.high,
      dealingRange.low
    );

    return direction === 'BULLISH' ? zone !== 'PREMIUM' : zone !== 'DISCOUNT';
  }

  /**
   * Dealing range: the router-computed `tradingRange` when available, otherwise
   * the high/low of the trailing 15m window.
   */
  private resolveDealingRange(
    patternData: PatternData
  ): { high: Decimal; low: Decimal; equilibrium: Decimal } | null {
    const range = patternData.tradingRange;
    if (
      range &&
      range.high.gt(0) &&
      range.low.gt(0) &&
      range.high.gt(range.low)
    ) {
      return {
        high: range.high,
        low: range.low,
        equilibrium: range.high.plus(range.low).div(2),
      };
    }

    const candles15m = patternData.candles15m;
    if (Array.isArray(candles15m) && candles15m.length >= 10) {
      const window = candles15m.slice(-DEALING_RANGE_LOOKBACK);
      const high = Decimal.max(...window.map((c) => new Decimal(c.high)));
      const low = Decimal.min(...window.map((c) => new Decimal(c.low)));

      if (high.gt(low)) {
        return { high, low, equilibrium: high.plus(low).div(2) };
      }
    }

    return null;
  }

  /**
   * Prefer the canonical `PatternRecognizer.getPremiumDiscount()` when a real
   * recognizer instance is attached. `PatternData.patternRecognizer` is typed as
   * a string literal, so backtest stubs and unit fixtures carry a placeholder —
   * the fallback below reproduces the exact same arithmetic.
   */
  private classifyPremiumDiscount(
    patternData: PatternData,
    price: Decimal,
    high: Decimal,
    low: Decimal
  ): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' {
    const recognizer = (patternData as any).patternRecognizer;
    if (recognizer && typeof recognizer.getPremiumDiscount === 'function') {
      return recognizer.getPremiumDiscount(price, high, low).zone;
    }

    const equilibrium = high.plus(low).div(2);
    if (price.gt(equilibrium)) return 'PREMIUM';
    if (price.lt(equilibrium)) return 'DISCOUNT';
    return 'EQUILIBRIUM';
  }

  /**
   * 1m displacement multiplier.
   *
   * Previously this silently degraded to `0.5` when the config value was absent,
   * which lowers the displacement gate by 3x and lets ordinary noise register as
   * a structure break. The documented default (1.5, AGENTS.md §7.2) is used
   * instead — never a weaker one.
   */
  private resolveDisplacementMultiplier(): Decimal {
    const configured = this.config.sniperDisplacementMultiplier;
    if (
      configured === undefined ||
      configured === null ||
      String(configured).trim() === ''
    ) {
      return new Decimal(DEFAULT_SNIPER_DISPLACEMENT);
    }
    return new Decimal(configured);
  }

  /**
   * Detect BOS/CHoCH on 1m candles with true last-valid-swing semantics.
   *
   * Two defects in the previous implementation are fixed here:
   *
   *  1. FRESHNESS — it compared every candle against EVERY swing, including ones
   *     already broken. A days-old level could be re-labelled as a fresh CHoCH.
   *     Now only the most recent confirmed, unbroken swing can be broken, and the
   *     broken swing is consumed.
   *  2. VALIDATION — `isValidated` was hard-coded `true`, making
   *     `isValidBodyClose()` a tautology. It is now derived from candle geometry:
   *     the CLOSE (body edge) must be beyond the swing, never just the wick.
   *
   * This mirrors `PatternRecognizer.detectStructureBreaks`, duplicated locally
   * because the canonical recognizer instance is not guaranteed to be present on
   * a bare `PatternData` (backtest stubs, unit fixtures).
   */
  private detectStructureBreaks(candles: any[], atr: Decimal): Structure[] {
    const structures: Structure[] = [];
    const swingLookback = 3;
    const minBody = atr.mul(this.resolveDisplacementMultiplier());

    // 1. Pre-compute confirmed swings — linear scan, no nested candle loops.
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

    // 2. Walk forward, registering swings once they are confirmed (3 candles old)
    //    and breaking only the most recent unbroken swing on each side.
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

      // Displacement is a hard gate: a break without expansion is noise.
      if (body.lt(minBody)) continue;

      let breakDirection: 'BULLISH' | 'BEARISH' | null = null;
      let brokenSwing: { price: Decimal; index: number } | null = null;

      // BODY CLOSE beyond the swing — `close`, never `high`/`low`.
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
        price: close,
        timestamp: candle.timestamp,
        isValidated: bodyCloseBeyond && body.gte(minBody),
        impulseFactor: body.div(atr),
      });
    }

    return structures;
  }
}
