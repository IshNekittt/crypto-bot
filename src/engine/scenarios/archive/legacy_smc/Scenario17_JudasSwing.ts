import { BaseScenario } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { BotConfig } from '../../../../config/env';
import { PatternData } from '../../../../smc/patternRecognizer';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe of this scenario. */
const ENTRY_TIMEFRAME = '15';

/**
 * Volume baseline window: the 20 CONFIRMED candles immediately BEFORE the
 * sweep candle.
 *
 * The sweep candle is excluded from its own baseline (Invariant 56). Including
 * it would contaminate the reference distribution with exactly the expansion the
 * gate is trying to measure, lowering the bar the trigger candle must clear.
 */
const VOLUME_BASELINE_CANDLES = 20;

/**
 * Judas Swing volume admission: the sweep candle must print at least the average
 * volume of the preceding 20 candles (ratio 1.0).
 *
 * Deliberately NOT `SMC_SWEEP_VOLUME_MULTIPLIER`: that knob is calibrated for
 * Scenario 5's macro-pool SFP and defaults to 1.3. The session-range pierce is
 * already a strong manipulation signal on its own, so S17 starts from a plain
 * average — an expansion gate can be layered on later without silently importing
 * another scenario's calibration.
 */
const MIN_VOLUME_MULTIPLIER = new Decimal('1.0');

/** A completed Asian session older than this is stale context, not liquidity. */
const ASIAN_RANGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NEW_YORK_ZONE = 'America/New_York';

type Direction = 'BULLISH' | 'BEARISH';

export interface Scenario17RejectionStats {
  totalEvals: number;
  wrongMode: number;
  insufficientCandles: number;
  notInKillzone: number;
  noAsianRange: number;
  noSweep: number;
  lowVolume: number;
  tpInvalid: number;
  triggered: number;
}

const EMPTY_STATS: Scenario17RejectionStats = {
  totalEvals: 0,
  wrongMode: 0,
  insufficientCandles: 0,
  notInKillzone: 0,
  noAsianRange: 0,
  noSweep: 0,
  lowVolume: 0,
  tpInvalid: 0,
  triggered: 0,
};

interface AsianRange {
  readonly high: Decimal;
  readonly low: Decimal;
  readonly end: number;
}

/**
 * Canonical id of the archived scenario.
 *
 * Deliberately a plain literal: id 17 was removed from the live `ScenarioId`
 * union when the scenario was archived, and the archive must keep compiling
 * without re-opening the registry.
 */
const SCENARIO_ID = 17;

interface SessionSweep {
  readonly direction: Direction;
  /** The wick extreme that pierced the session level (high for shorts, low for longs). */
  readonly pierce: Decimal;
}

/**
 * Scenario 17 — Killzone Session Sweep (Judas Swing). **ARCHIVED v2026-11-04.**
 *
 * Archived v2026-11-04: Confirmed POSITIVE Gross Edge (directional alpha
 * exists), but killed by Taker fees due to tight wick-geometry. Needs ATR-based
 * geometry unlock (like S5) for future revival.
 *
 * Evidence from the 60-day / 11-symbol matrix (2026-09-05 → 2026-11-04,
 * `ACTIVE_SCENARIOS=17`, killzones enforced, $1,000/symbol): 229 trades,
 * 33.62% win rate, gross **+$392.89** before fees, **−$317.81** net after
 * **$710.70** in round-trip taker fees — $1.72 gross per trade against $3.10
 * of cost. Only 5 of 11 symbols were profitable and 0 cleared the alpha gate
 * (Net > 10%, DD < 10%, PF > 1.5). The pattern finds real directional movement;
 * the wick-anchored stop is simply too tight to pay for it. Do not tune it on
 * this window — revive only with a geometry change (ATR-based stop sizing and
 * macro targeting, as S5 received in §8.8.1), then re-measure on ≥180 days.
 *
 * Institutional manipulation model for a chop/stop-hunt regime:
 *
 *  1. The Asian session (20:00–24:00 NY) builds an accumulation range. Its high
 *     and low are the liquidity pools resting above/below the range.
 *  2. London (02:00–05:00 NY) or New York (07:00–10:00 NY) opens and runs one
 *     side of that range — the Judas Swing. Stops are triggered, breakout
 *     traders are trapped.
 *  3. The SAME 15m candle that pierced the level closes back inside it. The wick
 *     is the manipulation, the close is the rejection.
 *  4. The trade is entered at that close, stopped beyond the piercing wick (with
 *     the `calculateLevels()` volatility buffer) and targeted at the nearest
 *     structural draw.
 *
 * Causal contract
 * ---------------
 *  - Only the LAST CLOSED 15m candle is evaluated. There is no lookback: an
 *    older wick would enter at a price disconnected from the manipulation.
 *  - The Asian range must be COMPLETED before the trigger candle and no older
 *    than 24 hours. The still-forming session is skipped even when the trigger
 *    falls inside the 20:00–24:00 window (reachable when killzones are bypassed
 *    for backtesting).
 *  - The volume baseline ends BEFORE the sweep candle (Invariant 56).
 *  - Session liquidity is never burned (Invariant 21). The trigger is burned as
 *    a `SWEEP` structure keyed by its timestamp (Invariant 39), so the same
 *    candle cannot re-fire while the Asian high/low stay tradable.
 */
export class Scenario17_JudasSwing extends BaseScenario {
  private static rejectionStats: Scenario17RejectionStats = { ...EMPTY_STATS };

  constructor(config: BotConfig) {
    super(SCENARIO_ID, 'Killzone Session Sweep (Judas Swing)', config);
  }

  static getRejectionStats(): Readonly<Scenario17RejectionStats> {
    return { ...Scenario17_JudasSwing.rejectionStats };
  }

  static resetStats(): void {
    Scenario17_JudasSwing.rejectionStats = { ...EMPTY_STATS };
  }

  protected override evaluateInternal(patternData: PatternData): boolean {
    const stats = Scenario17_JudasSwing.rejectionStats;
    stats.totalEvals++;

    // Mode guard (audit F-03): Scenario 17 is a 15m Classic pattern. In Sniper
    // Mode the router is driven by 1m closes, so the identical stale 15m candle
    // would be re-evaluated on every tick and could fill from a close up to 14
    // minutes old. Fail closed rather than stage a stale entry.
    if (
      this.config.enableSniperMode ||
      this.config.ltfTimeframe !== ENTRY_TIMEFRAME
    ) {
      return this.reject(
        'wrongMode',
        'Scenario 17 is Classic 15m-only (Sniper Mode or non-15m LTF active)',
      );
    }

    // The manipulation must happen in London or New York — the Asian range is
    // the accumulation that the Judas Swing runs against. ASIAN is explicitly
    // excluded: sweeping a level while the session is still building it is not
    // a completed-range manipulation. Bypassable globally via
    // ENFORCE_KILLZONES=false (backtesting).
    const killzone = patternData.currentKillzone;
    if (
      this.config.enforceKillzones !== false &&
      killzone !== 'LONDON' &&
      killzone !== 'NY'
    ) {
      return this.reject(
        'notInKillzone',
        `Judas Swing requires London or NY killzone (current: ${killzone ?? 'NONE'})`,
      );
    }

    const candles15m = patternData.candles15m ?? [];

    // 20 baseline candles + 1 sweep candle. Without the full baseline the volume
    // gate cannot be evaluated and must fail closed rather than silently pass.
    if (candles15m.length < VOLUME_BASELINE_CANDLES + 1) {
      return this.reject(
        'insufficientCandles',
        `Requires ${VOLUME_BASELINE_CANDLES + 1} confirmed 15m candles (volume baseline + sweep)`,
      );
    }

    // The last element is the last CLOSED candle: the backtester drops the
    // candle still forming at the evaluation instant, and the live feed only
    // appends confirmed candles.
    const sweepCandle = candles15m[candles15m.length - 1];
    const triggerTimestamp = Number(sweepCandle.timestamp);

    if (!Number.isFinite(triggerTimestamp)) {
      return this.reject('noSweep', 'Sweep candle has no usable timestamp');
    }

    const asianRange = this.selectAsianRange(patternData, triggerTimestamp);

    if (!asianRange) {
      return this.reject(
        'noAsianRange',
        'No COMPLETED Asian session range within 24h of the trigger candle',
      );
    }

    const sweep = this.detectSessionSweep(
      sweepCandle,
      asianRange.high,
      asianRange.low,
    );

    if (!sweep) {
      return this.reject(
        'noSweep',
        `Last closed 15m candle did not sweep and reject the Asian range ` +
          `(high ${asianRange.high.toString()} / low ${asianRange.low.toString()})`,
      );
    }

    // === VOLUME CONFIRMATION ===
    // The baseline is the SMA of the 20 closed candles BEFORE the sweep candle;
    // the sweep candle must reach `MIN_VOLUME_MULTIPLIER` x that baseline.
    const baselineCandles = candles15m.slice(-(VOLUME_BASELINE_CANDLES + 1), -1);

    let baselineVolume: Decimal;
    let sweepVolume: Decimal;
    try {
      // Explicit loop, not `.reduce()`: reduce SKIPS array holes, so a sparse or
      // partially missing series would silently average fewer candles and lower
      // the bar the sweep candle has to clear. Every baseline slot is required.
      let volumeSum = new Decimal(0);
      for (const baselineCandle of baselineCandles) {
        const candleVolume = new Decimal(baselineCandle.volume);
        if (!candleVolume.isFinite() || candleVolume.lt(0)) {
          throw new Error('unusable baseline candle volume');
        }
        volumeSum = volumeSum.plus(candleVolume);
      }
      baselineVolume = volumeSum.div(VOLUME_BASELINE_CANDLES);
      sweepVolume = new Decimal(sweepCandle.volume);
    } catch {
      return this.reject(
        'lowVolume',
        'Sweep candle volume or baseline is missing/unparseable',
      );
    }

    if (
      !sweepVolume.isFinite() ||
      sweepVolume.lte(0) ||
      !baselineVolume.isFinite() ||
      baselineVolume.lte(0)
    ) {
      return this.reject(
        'lowVolume',
        `Volume baseline is unusable (baseline=${baselineVolume.toString()}, sweep=${sweepVolume.toString()})`,
      );
    }

    const requiredVolume = baselineVolume.mul(MIN_VOLUME_MULTIPLIER);
    if (sweepVolume.lt(requiredVolume)) {
      return this.reject(
        'lowVolume',
        `Sweep volume ${sweepVolume.toFixed(2)} < ${MIN_VOLUME_MULTIPLIER.toString()}x baseline ${requiredVolume.toFixed(2)}`,
      );
    }

    const direction = sweep.direction;

    // Entry = the sweep candle's close. This is the price at which the rejection
    // was confirmed; the live path decides Market vs Limit against it, but the
    // scenario never invents a better fill than the market printed.
    const entry = new Decimal(sweepCandle.close);

    if (!entry.isFinite() || entry.lte(0)) {
      return this.reject('noSweep', 'Sweep candle close is not a usable price');
    }

    // The sweep candle's own range is the invalidation. `calculateLevels()` puts
    // the stop strictly beyond the PIERCED extreme — `max(top, bottom, entry)`
    // for a short, `min(top, bottom, entry)` for a long — and enforces the 0.1%
    // floor, so an inverted or same-side zone cannot place the stop behind the
    // entry.
    const sweepZone = {
      top: new Decimal(sweepCandle.high),
      bottom: new Decimal(sweepCandle.low),
      direction,
    };

    // VOLATILITY BUFFER: the wick alone is not an invalidation, it is the edge
    // of one. A stop parked on the pierced extreme is consumed by the next 15m
    // noise candle (the classic double sweep), so `calculateLevels()` pushes it
    // a further `SMC_SL_ATR_OFFSET` x atr15m away (0.1% floor retained). A
    // missing/short ATR degrades to the floor rather than moving the stop behind
    // the entry.
    const stopAtr =
      patternData.atr15m instanceof Decimal &&
      patternData.atr15m.isFinite() &&
      patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal(0);

    // `rr = 1` is a placeholder — only the STOP is consumed from this call. The
    // target is resolved from market structure below.
    const baseLevels = this.calculateLevels(
      entry,
      sweepZone,
      direction,
      stopAtr,
      new Decimal(1),
    );

    const resolution = resolveTakeProfit({
      direction,
      entry: baseLevels.entry,
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
      requireTarget: this.config.dynamicTpRequireTarget,
      // A session sweep is a macro manipulation: the range boundary is the
      // thesis, so internal 15m swings are noise to be stepped over. A MAJOR
      // barrier inside the floor still rejects — the setup must have genuine
      // room, not manufactured room.
      skipMinorObstacles: true,
    });

    if (!resolution.ok) {
      return this.reject('tpInvalid', `Take-profit rejected: ${resolution.reason}`);
    }

    let levels;
    try {
      // Stop geometry is re-derived through the single source of truth; the
      // target is substituted only after it has been validated against the
      // entry side.
      levels = this.calculateLevelsWithTarget(
        entry,
        sweepZone,
        direction,
        stopAtr,
        resolution.takeProfit,
      );
    } catch (error) {
      return this.reject(
        'tpInvalid',
        `Resolved target rejected by geometry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // No `zoneDetails`: session liquidity must never be burned (Invariant 21).
    // The trigger is a candle event, so it is burned as a STRUCTURE — its
    // timestamp is the identity that stops the same candle from firing twice
    // (Invariant 39).
    this.setStructureDetails({
      type: 'SWEEP',
      timestamp: triggerTimestamp,
      price: sweep.pierce,
      direction,
    });

    stats.triggered++;
    this.setReason(
      `Judas Swing: Asian range high ${asianRange.high.toString()} / low ${asianRange.low.toString()} ` +
        `(ended ${new Date(asianRange.end).toISOString()}) swept by 15m close ${entry.toString()} ` +
        `(high ${sweepCandle.high} / low ${sweepCandle.low}, volume ${sweepVolume
          .div(baselineVolume)
          .toFixed(2)}x baseline) → ${direction}`,
    );
    return true;
  }

  /**
   * Newest COMPLETED Asian session that is still fresh at the trigger instant.
   *
   * `detectSessionRanges()` groups candles by their New York calendar date, so a
   * still-forming session (20:00–24:00 NY) shares the trigger's NY date. Such a
   * range is skipped even if its last candle precedes the trigger: it is partial
   * context, not a finished accumulation range. Ranges older than 24 hours are
   * skipped as stale.
   */
  private selectAsianRange(
    patternData: PatternData,
    triggerTimestamp: number,
  ): AsianRange | null {
    const ranges: any[] = Array.isArray(patternData.sessionRanges)
      ? patternData.sessionRanges
      : [];

    const triggerNyDate = DateTime.fromMillis(triggerTimestamp, { zone: 'utc' })
      .setZone(NEW_YORK_ZONE)
      .toISODate();

    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i];
      if (!range || range.name !== 'ASIAN') continue;

      const high: unknown = range.high;
      const low: unknown = range.low;
      if (!(high instanceof Decimal) || !high.isFinite() || high.lte(0)) continue;
      if (!(low instanceof Decimal) || !low.isFinite() || low.lte(0)) continue;
      if (high.lte(low)) continue;

      const start = Number(range.start);
      const end = Number(range.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

      // The range must be fully behind the trigger candle.
      if (end >= triggerTimestamp) continue;

      // Skip the still-forming session: it shares the trigger's NY date.
      const rangeNyDate = DateTime.fromMillis(start, { zone: 'utc' })
        .setZone(NEW_YORK_ZONE)
        .toISODate();
      if (rangeNyDate && triggerNyDate && rangeNyDate === triggerNyDate) continue;

      // Freshness: a range that finished more than 24h ago no longer describes
      // the liquidity the current session is running against.
      if (triggerTimestamp - end > ASIAN_RANGE_MAX_AGE_MS) continue;

      return { high, low, end };
    }

    return null;
  }

  /**
   * Session SFP on a single candle.
   *
   * Short: `high > asianHigh && close < asianHigh` (buy-side liquidity taken,
   * close rejects back inside).
   * Long : `low < asianLow && close > asianLow` (sell-side liquidity taken,
   * close rejects back inside).
   *
   * A candle that pierces BOTH boundaries is resolved by the deeper penetration
   * — the side the market actually ran. An exact tie resolves BEARISH so the
   * outcome never depends on array order or floating-point noise.
   */
  private detectSessionSweep(
    candle: any,
    asianHigh: Decimal,
    asianLow: Decimal,
  ): SessionSweep | null {
    let high: Decimal;
    let low: Decimal;
    let close: Decimal;
    try {
      high = new Decimal(candle.high);
      low = new Decimal(candle.low);
      close = new Decimal(candle.close);
    } catch {
      return null;
    }

    if (
      !high.isFinite() ||
      !low.isFinite() ||
      !close.isFinite() ||
      high.lt(low) ||
      close.lte(0)
    ) {
      return null;
    }

    const sweptHigh = high.gt(asianHigh) && close.lt(asianHigh);
    const sweptLow = low.lt(asianLow) && close.gt(asianLow);

    if (sweptHigh && sweptLow) {
      const highPenetration = high.minus(asianHigh);
      const lowPenetration = asianLow.minus(low);

      return lowPenetration.gt(highPenetration)
        ? { direction: 'BULLISH', pierce: low }
        : { direction: 'BEARISH', pierce: high };
    }

    if (sweptHigh) {
      return { direction: 'BEARISH', pierce: high };
    }

    if (sweptLow) {
      return { direction: 'BULLISH', pierce: low };
    }

    return null;
  }

  private reject(
    bucket: keyof Omit<Scenario17RejectionStats, 'totalEvals'>,
    reason: string,
  ): false {
    Scenario17_JudasSwing.rejectionStats[bucket]++;
    this.setReason(reason);
    return false;
  }
}
