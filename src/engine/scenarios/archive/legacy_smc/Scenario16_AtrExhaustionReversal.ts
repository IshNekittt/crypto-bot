import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { PatternData } from '../../../../smc/patternRecognizer';
import { BaseScenario } from '../../../baseScenario';
import { calculateVolatilitySqueeze } from '../../../quant/volatilitySqueeze';
import { resolveTakeProfit } from '../../../tpResolver';

export interface Scenario16RejectionStats {
  totalEvals: number;
  wrongMode: number;
  insufficientCandles: number;
  noExhaustion: number;
  noSqueeze: number;
  lowVolume: number;
  ambiguousDirection: number;
  invalidGeometry: number;
  tpInvalid: number;
  triggered: number;
}

const EMPTY_STATS: Scenario16RejectionStats = {
  totalEvals: 0,
  wrongMode: 0,
  insufficientCandles: 0,
  noExhaustion: 0,
  noSqueeze: 0,
  lowVolume: 0,
  ambiguousDirection: 0,
  invalidGeometry: 0,
  tpInvalid: 0,
  triggered: 0,
};

/**
 * Canonical id of the archived scenario.
 *
 * Deliberately a plain literal: id 16 was removed from the live `ScenarioId`
 * union when the scenario was archived, and the archive must keep compiling
 * without re-opening the registry.
 */
const SCENARIO_ID = 16;

/** Swing window whose high/low define the impulse distance. */
const EXHAUSTION_LOOKBACK = 20;
/**
 * The 20-candle swing must span at least this many 4H ATRs.
 *
 * ATR4H is the macro volatility unit: comparing a 5-hour 15m swing against it
 * asks "did this move travel a full 4H bar's average range?", which is the
 * exhaustion premise. Calibrated from 1.5 to 1.0 after the 60-day screen showed
 * 1.5 rejecting 76-81% of evaluations while the squeeze gate immediately after
 * demanded compression — the two gates fought each other.
 */
const EXHAUSTION_ATR_MULTIPLE = new Decimal('1.0');

/** SMA window for the breakout volume baseline (Invariant 56: excludes the trigger). */
const VOLUME_SMA_CANDLES = 20;

/** Bollinger/Keltner parameters — identical to Scenario 15 so both agree on "squeeze". */
const SQUEEZE_PERIOD = 20;
const SQUEEZE_BB_MULTIPLIER = new Decimal(2);
const SQUEEZE_ATR_MULTIPLIER = new Decimal('1.5');
/**
 * Compressed candles required immediately before the expansion.
 *
 * The original 3-5 candle floor was the second half of a geometric paradox: the
 * exhaustion gate demanded an impulse, then the squeeze gate demanded that the
 * market had been dead for most of an hour. Calibrated to 1 — the candle
 * immediately before the trigger must be compressed — which still requires a
 * genuine volatility transition without starving the scenario.
 */
const MIN_PRIOR_SQUEEZE_CANDLES = 1;

/** Candles forming the squeeze base used as the synthetic stop zone. */
const SQUEEZE_BASE_CANDLES = 5;

/** Swing window + volume baseline + the trigger candle itself. */
const MIN_CANDLES = EXHAUSTION_LOOKBACK + VOLUME_SMA_CANDLES + 1;

/**
 * Scenario 16 — ATR Exhaustion Reversal (15m Classic).
 *
 * Premise: a move that has already travelled at least one 4H ATR is
 * over-extended, and when it happens out of a volatility compression the first
 * expansion is more often a terminal thrust than the start of a new leg. The
 * trade fades the extreme side of the 20-candle swing.
 *
 * Funnel: exhaustion (ATR4H) → direction (which extreme price sits closer to) →
 * squeeze expansion (BB/KC) → volume expansion (SMA-20 baseline) → geometry →
 * structural take-profit.
 */
export class Scenario16_AtrExhaustionReversal extends BaseScenario {
  private static stats: Scenario16RejectionStats = { ...EMPTY_STATS };

  constructor(config: BotConfig) {
    super(SCENARIO_ID, 'ATR Exhaustion Reversal (BB/KC)', config);
  }

  static getRejectionStats(): Readonly<Scenario16RejectionStats> {
    return { ...Scenario16_AtrExhaustionReversal.stats };
  }

  static resetStats(): void {
    Scenario16_AtrExhaustionReversal.stats = { ...EMPTY_STATS };
  }

  protected override evaluateInternal(patternData: PatternData): boolean {
    const stats = Scenario16_AtrExhaustionReversal.stats;
    stats.totalEvals++;

    // Mode guard: this is a 15m Classic reversal. In Sniper Mode the engine
    // closes on 1m candles, so the same 15m candle would be re-scanned on every
    // tick (up to 15x) and could fill from a close up to 14 minutes stale.
    if (this.config.enableSniperMode || this.config.ltfTimeframe !== '15') {
      return this.reject('wrongMode', 'Scenario 16 is Classic 15m-only');
    }

    const candles15m = patternData.candles15m ?? [];
    const candles4h = patternData.candles4h ?? [];

    if (candles15m.length < MIN_CANDLES || candles4h.length === 0) {
      return this.reject(
        'insufficientCandles',
        `Requires at least ${MIN_CANDLES} confirmed 15m and 1 closed 4H candle`,
      );
    }

    // The trigger is the LAST CLOSED 15m candle; the mirror of the live
    // CandleFeed contract (no forming candle is ever visible).
    const current = candles15m[candles15m.length - 1];
    // Last CLOSED 4H candle — the macro anchor for the exhaustion reference.
    const last4h = candles4h[candles4h.length - 1];

    const entry = new Decimal(current.close);
    const atr15m = patternData.atr15m;
    const atr4h = patternData.atr4h;

    if (
      !entry.isFinite() ||
      entry.lte(0) ||
      !atr15m ||
      !atr15m.isFinite() ||
      atr15m.lte(0) ||
      !atr4h ||
      !atr4h.isFinite() ||
      atr4h.lte(0)
    ) {
      return this.reject('insufficientCandles', 'Entry, ATR15m or ATR4H is unavailable');
    }

    const last4hHigh = new Decimal(last4h.high);
    const last4hLow = new Decimal(last4h.low);
    const last4hClose = new Decimal(last4h.close);
    if (
      !last4hHigh.isFinite() ||
      !last4hLow.isFinite() ||
      !last4hClose.isFinite() ||
      last4hHigh.lt(last4hLow)
    ) {
      return this.reject('insufficientCandles', 'Last closed 4H candle is malformed');
    }

    // === 1. ATR EXHAUSTION =================================================
    // Impulse distance is the full 20-candle range, measured causally: the
    // window always ends at the trigger candle, never beyond it.
    let windowHigh = new Decimal('-Infinity');
    let windowLow = new Decimal('Infinity');
    for (let index = candles15m.length - EXHAUSTION_LOOKBACK; index < candles15m.length; index++) {
      windowHigh = Decimal.max(windowHigh, new Decimal(candles15m[index].high));
      windowLow = Decimal.min(windowLow, new Decimal(candles15m[index].low));
    }

    if (!windowHigh.isFinite() || !windowLow.isFinite() || windowLow.lte(0)) {
      return this.reject('noExhaustion', 'Exhaustion window contains invalid prices');
    }

    const swingDistance = windowHigh.minus(windowLow);
    const exhaustionFloor = atr4h.mul(EXHAUSTION_ATR_MULTIPLE);
    if (swingDistance.lt(exhaustionFloor)) {
      return this.reject(
        'noExhaustion',
        `20-candle swing ${swingDistance.toSignificantDigits(6).toString()} < ${EXHAUSTION_ATR_MULTIPLE.toString()} x ATR4H ${exhaustionFloor.toSignificantDigits(6).toString()}`,
      );
    }

    // === 2. EXHAUSTED SIDE → REVERSAL DIRECTION ============================
    // Close near the window high = the impulse travelled UP, so the reversal is
    // DOWN (BEARISH). Close near the window low = the mirror case.
    const distanceToHigh = windowHigh.minus(entry);
    const distanceToLow = entry.minus(windowLow);
    if (distanceToHigh.eq(distanceToLow)) {
      return this.reject(
        'ambiguousDirection',
        'Close sits exactly at the middle of the exhaustion window',
      );
    }
    const direction: 'BULLISH' | 'BEARISH' = distanceToHigh.lt(distanceToLow)
      ? 'BEARISH'
      : 'BULLISH';

    // === 3. SQUEEZE EXPANSION ==============================================
    let snapshots;
    try {
      snapshots = calculateVolatilitySqueeze(
        candles15m,
        SQUEEZE_PERIOD,
        SQUEEZE_BB_MULTIPLIER,
        SQUEEZE_ATR_MULTIPLIER,
        MIN_PRIOR_SQUEEZE_CANDLES,
      );
    } catch (error) {
      return this.reject(
        'insufficientCandles',
        `Invalid squeeze input: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const squeeze = snapshots[snapshots.length - 1];
    if (!squeeze || squeeze.timestamp !== current.timestamp) {
      return this.reject('insufficientCandles', 'Squeeze series does not cover the trigger candle');
    }
    if (squeeze.isSqueezed || squeeze.priorSqueezeCandles < MIN_PRIOR_SQUEEZE_CANDLES) {
      return this.reject(
        'noSqueeze',
        `Trigger is not the first expansion after >= ${MIN_PRIOR_SQUEEZE_CANDLES} compressed candles (squeezed=${squeeze.isSqueezed}, prior=${squeeze.priorSqueezeCandles})`,
      );
    }

    // === 4. VOLUME EXPANSION ===============================================
    // Baseline ends strictly BEFORE the trigger candle (Invariant 56): the very
    // expansion being judged must not inflate its own reference.
    let volumeSum = new Decimal(0);
    for (
      let index = candles15m.length - 1 - VOLUME_SMA_CANDLES;
      index < candles15m.length - 1;
      index++
    ) {
      volumeSum = volumeSum.plus(new Decimal(candles15m[index].volume));
    }
    const volumeAverage = volumeSum.div(VOLUME_SMA_CANDLES);
    const triggerVolume = new Decimal(current.volume);
    const requiredVolume = volumeAverage.mul(this.config.sweepVolumeMultiplier);

    if (
      !volumeAverage.isFinite() ||
      volumeAverage.lte(0) ||
      !triggerVolume.isFinite() ||
      triggerVolume.lt(requiredVolume)
    ) {
      return this.reject(
        'lowVolume',
        `Breakout volume ${triggerVolume.toString()} < ${this.config.sweepVolumeMultiplier.toString()} x SMA20 ${volumeAverage.toSignificantDigits(6).toString()}`,
      );
    }

    // === 5. STRICT GEOMETRY ================================================
    // Synthetic zone = the squeeze base (the 5 candles preceding the trigger).
    // The trigger candle is deliberately excluded: it is the expansion, not the
    // base, so including it would push the stop past the breakout extreme.
    let baseHigh = new Decimal('-Infinity');
    let baseLow = new Decimal('Infinity');
    for (
      let index = candles15m.length - 1 - SQUEEZE_BASE_CANDLES;
      index < candles15m.length - 1;
      index++
    ) {
      baseHigh = Decimal.max(baseHigh, new Decimal(candles15m[index].high));
      baseLow = Decimal.min(baseLow, new Decimal(candles15m[index].low));
    }

    if (
      !baseHigh.isFinite() ||
      !baseLow.isFinite() ||
      baseLow.lte(0) ||
      baseHigh.lt(baseLow)
    ) {
      return this.reject('invalidGeometry', 'Squeeze base is malformed');
    }

    // rr = 1 is a placeholder: calculateLevels() owns the STOP (0.1% floor +
    // inverted-zone defense, Invariant 11) and the target is replaced by the
    // structural resolution below.
    const baseLevels = this.calculateLevels(
      entry,
      { top: baseHigh, bottom: baseLow, direction },
      direction,
      atr15m,
      new Decimal(1),
    );

    const resolution = resolveTakeProfit({
      direction,
      entry,
      stopLoss: baseLevels.stopLoss,
      zones: patternData.zones ?? [],
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      // Explicit fallback to FIXED_TP_RR: a missing opposing target must not
      // silently disarm the scenario when dynamic TP is enabled.
      requireTarget: false,
      skipMinorObstacles: true,
    });

    if (!resolution.ok) {
      return this.reject('tpInvalid', `Take-profit rejected: ${resolution.reason}`);
    }

    const targetBeyondEntry =
      direction === 'BULLISH'
        ? resolution.takeProfit.gt(entry)
        : resolution.takeProfit.lt(entry);
    const stopBeforeEntry =
      direction === 'BULLISH'
        ? baseLevels.stopLoss.lt(entry)
        : baseLevels.stopLoss.gt(entry);
    if (!targetBeyondEntry || !stopBeforeEntry) {
      return this.reject(
        'invalidGeometry',
        `Invalid SL/TP geometry: entry=${entry.toString()} SL=${baseLevels.stopLoss.toString()} TP=${resolution.takeProfit.toString()}`,
      );
    }

    this.setLevels({
      entry,
      stopLoss: baseLevels.stopLoss,
      takeProfit: resolution.takeProfit,
    });
    // Ghost-signal protection (Invariant 39): the trigger candle is burned by
    // timestamp on fill. No synthetic zone is emitted — the squeeze base is
    // stop geometry, not an SMC mitigation zone, and burning it as one would
    // remove a real order block from the router's pool.
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: current.timestamp,
      price: entry,
      direction,
    });
    this.setReason(
      `ATR exhaustion reversal ${direction}: swing=${swingDistance.toSignificantDigits(6).toString()} >= ${exhaustionFloor.toSignificantDigits(6).toString()} (1.5 x ATR4H) | priorSqueeze=${squeeze.priorSqueezeCandles} | volume=${triggerVolume.toString()} vs SMA20=${volumeAverage.toSignificantDigits(6).toString()} | 4H close=${last4hClose.toString()}`,
    );

    stats.triggered++;
    return true;
  }

  private reject(
    bucket: keyof Omit<Scenario16RejectionStats, 'totalEvals'>,
    reason: string,
  ): false {
    Scenario16_AtrExhaustionReversal.stats[bucket]++;
    this.setReason(reason);
    return false;
  }
}
