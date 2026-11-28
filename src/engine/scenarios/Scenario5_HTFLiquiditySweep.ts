import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { ROUND_TRIP_TAKER_FEE } from '../../config/fees';
import { resolveTakeProfit } from '../tpResolver';

/**
 * Volume baseline window: the 20 CONFIRMED candles immediately BEFORE the sweep
 * candle.
 *
 * The sweep candle is excluded from its own baseline (see `evaluateInternal`).
 * Including it would contaminate the reference distribution with exactly the
 * expansion the gate is trying to measure — the same causality rule that governs
 * the volume-exhaustion baseline in `src/engine/brain/volumeExhaustion.ts`
 * (Invariant 56).
 */
const VOLUME_BASELINE_CANDLES = 20;

/** Fallback when `SMC_SWEEP_VOLUME_MULTIPLIER` is absent from the config object. */
const DEFAULT_SWEEP_VOLUME_MULTIPLIER = new Decimal('1.3');

/**
 * Deterministic tie-break when several pools are swept by the SAME candle.
 *
 * Pool priority decides which liquidity event is reported (and therefore which
 * direction is traded) when one candle pierces more than one level: the dominant
 * macro pool wins, so the output never depends on array order.
 */
const POOL_PRIORITY: Record<string, number> = {
  PDH: 0,
  PDL: 1,
  PWH: 2,
  PWL: 3,
  BSL: 4,
  SSL: 5,
};

/**
 * Which side of the market each pool represents.
 *
 * A high is swept by a wick ABOVE it that closes back below (bearish SFP); a low
 * is swept by a wick BELOW it that closes back above (bullish SFP). Enforcing
 * the side prevents a "PDH sweep" from being manufactured by a downward move
 * that never took buy-side liquidity.
 */
const POOL_SIDE: Record<string, 'HIGH' | 'LOW'> = {
  PDH: 'HIGH',
  PWH: 'HIGH',
  BSL: 'HIGH',
  PDL: 'LOW',
  PWL: 'LOW',
  SSL: 'LOW',
};

const SWEEP_POOL_TYPES = Object.keys(POOL_PRIORITY);

type Direction = 'BULLISH' | 'BEARISH';

export interface Scenario5RejectionStats {
  totalEvals: number;
  wrongMode: number;
  killzone: number;
  noPools: number;
  insufficientCandles: number;
  noSweep: number;
  lowVolumeSweep: number;
  tpInvalid: number;
  triggered: number;
}

const EMPTY_STATS: Scenario5RejectionStats = {
  totalEvals: 0,
  wrongMode: 0,
  killzone: 0,
  noPools: 0,
  insufficientCandles: 0,
  noSweep: 0,
  lowVolumeSweep: 0,
  tpInvalid: 0,
  triggered: 0,
};

/**
 * Scenario 5 — HTF Liquidity Sweep (Volume-Confirmed SFP).
 *
 * A London/NY SFP that takes PDH/PDL/PWH/PWL/BSL/SSL liquidity and closes back
 * inside the level, CONFIRMED by institutional volume expansion on the sweep
 * candle itself.
 *
 * Why the confirmation chain was replaced
 * ---------------------------------------
 * The previous implementation required Sweep → 15m CHoCH (≥1.5 ATR displacement)
 * → 15m FVG, then entered at the FVG midpoint. Each link is a lagging structure:
 * by the time the gap retraced, the sweep was 3–10 candles old and the entry sat
 * far from the liquidity that justified it. Setup frequency collapsed while the
 * entry quality did not improve — the FVG was a proxy for the reaction, not the
 * reaction itself.
 *
 * The SFP is self-confirming. The wick is the manipulation, the close back
 * inside is the rejection, and VOLUME is the institutional participation that
 * separates a genuine stop-run from a casual poke. Nothing is deferred to a
 * later candle, so the entry is the sweep candle's own close and the invalidation
 * is the wick that must not be revisited.
 *
 * Causal contract
 * ---------------
 *  1. The sweep candle is the LAST CLOSED LTF candle. There is no lookback: the
 *     entry is placed at that candle's close, so an older wick would enter at a
 *     price totally disconnected from the liquidity event being traded.
 *  2. The stop is the sweep candle's pierced extreme (high for a short, low for
 *     a long) pushed away by `0.5 × atr15m` (`SMC_SL_ATR_OFFSET`, never below the
 *     `calculateLevels()` 0.1% floor). A stop sitting exactly on the wick is
 *     consumed by ordinary 15m noise — the double sweep — so the volatility
 *     buffer is what makes the invalidation survivable rather than decorative.
 *  3. The volume baseline ends BEFORE the sweep candle. The reference window can
 *     never contain the candle it is judging.
 *  4. Macro liquidity pools are NEVER burned (Invariant 21). The trigger is
 *     burned as a structure (timestamp identity), so the same candle can never
 *     re-fire while PDH/PDL/PWH/PWL stay tradable for the rest of the session.
 */
export class Scenario5_HTFLiquiditySweep extends BaseScenario {
  private static rejectionStats: Scenario5RejectionStats = { ...EMPTY_STATS };

  constructor(config: BotConfig) {
    super(5, 'HTF Liquidity Sweep', config);
  }

  static getRejectionStats(): Readonly<Scenario5RejectionStats> {
    return { ...Scenario5_HTFLiquiditySweep.rejectionStats };
  }

  static resetStats(): void {
    Scenario5_HTFLiquiditySweep.rejectionStats = { ...EMPTY_STATS };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario5_HTFLiquiditySweep.rejectionStats;
    stats.totalEvals++;

    if (!this.isClassicMode()) {
      return this.reject(
        'wrongMode',
        'Scenario 5 requires Classic mode with LTF of at least 5 minutes',
      );
    }

    // Sweep must happen in a London/NY killzone (not ASIAN). Bypassable globally
    // via ENFORCE_KILLZONES=false (backtesting).
    const killzone = patternData.currentKillzone;
    if (
      this.config.enforceKillzones !== false &&
      (!killzone || (killzone !== 'LONDON' && killzone !== 'NY'))
    ) {
      return this.reject(
        'killzone',
        'HTF Liquidity Sweep requires London or NY killzone',
      );
    }

    const liquidityPools: any[] = patternData.liquidityPools ?? [];
    const candles15m: any[] = patternData.candles15m ?? [];

    // Find HTF liquidity pools: PDH, PDL, PWH, PWL, BSL, SSL
    const htfPools = liquidityPools.filter(
      (pool: any) =>
        SWEEP_POOL_TYPES.includes(pool.type) &&
        !pool.isTaken &&
        pool.priceLevel instanceof Decimal &&
        pool.priceLevel.isFinite() &&
        pool.priceLevel.gt(0),
    );

    if (!htfPools.length) {
      return this.reject(
        'noPools',
        'No HTF liquidity pools (PDH/PDL/PWH/PWL/BSL/SSL) available',
      );
    }

    // 20 baseline candles + 1 sweep candle. Without the full baseline the volume
    // gate cannot be evaluated and must fail closed rather than silently pass.
    if (candles15m.length < VOLUME_BASELINE_CANDLES + 1) {
      return this.reject(
        'insufficientCandles',
        `Requires ${VOLUME_BASELINE_CANDLES + 1} confirmed 15m candles (volume baseline + sweep)`,
      );
    }

    const sweepCandle = candles15m[candles15m.length - 1];
    // The sweep itself is the structure; there is no separate CHoCH/BOS filter.
    // Legacy mitigation records have no timeframe and match by timestamp.
    if (patternData.mitigatedStructures?.some((structure: { timestamp: number; timeframe?: string }) =>
      structure.timestamp === sweepCandle.timestamp &&
      (structure.timeframe === undefined || structure.timeframe === this.config.ltfTimeframe)
    )) {
      return this.reject('noSweep', 'Sweep candle already consumed');
    }
    const sfp = this.detectSfp(sweepCandle, htfPools);

    if (!sfp) {
      return this.reject(
        'noSweep',
        'No SFP on the last closed LTF candle: no HTF pool pierced and rejected by the close',
      );
    }

    // === VOLUME CONFIRMATION (Zvezdin rule) ===
    // The SFP is only institutional if the sweep candle expands volume. The
    // baseline is the SMA of the 20 closed candles BEFORE it; the sweep candle
    // must reach `multiplier` x that baseline.
    const multiplier = this.resolveVolumeMultiplier();
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
        'lowVolumeSweep',
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
        'lowVolumeSweep',
        `Volume baseline is unusable (baseline=${baselineVolume.toString()}, sweep=${sweepVolume.toString()})`,
      );
    }

    const requiredVolume = baselineVolume.mul(multiplier);
    if (sweepVolume.lt(requiredVolume)) {
      return this.reject(
        'lowVolumeSweep',
        `Sweep lacks institutional volume expansion: ${sweepVolume.toFixed(2)} < ${multiplier.toString()}x baseline ${requiredVolume.toFixed(2)}`,
      );
    }

    const direction = sfp.direction;

    // Entry = the sweep candle's close. This is the price at which the rejection
    // was confirmed; the live path decides Market vs Limit against it, but the
    // scenario never invents a better fill than the market printed.
    const entry = new Decimal(sweepCandle.close);

    if (!entry.isFinite() || entry.lte(0)) {
      return this.reject('noSweep', 'Sweep candle close is not a usable price');
    }

    // The sweep candle's own range is the invalidation. `calculateLevels()` puts
    // the stop strictly beyond the PIERCED extreme — `max(top, bottom, entry)` for
    // a short, `min(top, bottom, entry)` for a long — and enforces the 0.1% floor,
    // so an inverted or same-side zone cannot place the stop behind the entry.
    const wickZone = {
      top: new Decimal(sweepCandle.high),
      bottom: new Decimal(sweepCandle.low),
      direction,
    };

    // VOLATILITY BUFFER: the wick alone is not an invalidation, it is the edge of
    // one. A stop parked on the pierced extreme is consumed by the next 15m noise
    // candle (the classic double sweep), so the buffer is pushed a further
    // `0.5 × atr15m` away. `calculateLevels()` keeps the 0.1% floor and the
    // inverted-zone defense, so a missing/short ATR degrades to the old floor
    // rather than moving the stop behind the entry.
    const stopAtr =
      patternData.atr15m instanceof Decimal &&
      patternData.atr15m.isFinite() &&
      patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal(0);

    // `rr = 1` is a placeholder — only the STOP is consumed from this call. The
    // target is resolved from market structure below. `calculateLevels()` applies
    // `SMC_SL_ATR_OFFSET` (default 0.5) to `stopAtr` and keeps its 0.1% floor.
    const baseLevels = this.calculateLevels(
      entry,
      wickZone,
      direction,
      stopAtr,
      new Decimal(1),
    );

    const resolution = resolveTakeProfit({
      htfTimeframe: this.config.htfTimeframe,
      sweptLevelPrice: sfp.level,
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
      // MACRO TARGETING: a major HTF liquidity sweep carries enough momentum to
      // trade through internal 15m swings, so a minor bump is not a wall — the
      // resolver steps over it and targets the next real pool / HTF zone. A MAJOR
      // barrier still rejects (see tpResolver), which is the point: the setup must
      // have genuine macro room, not manufactured room.
      skipMinorObstacles: true,
    });

    if (!resolution.ok) {
      return this.reject('tpInvalid', `Take-profit rejected: ${resolution.reason}`);
    }

    // === FEE-INCLUSIVE NET R:R FLOOR ===
    // Both legs are charged, so the fee is subtracted from the reward AND added
    // to the risk:
    //
    //   netRr = (targetDistance − roundTripFee) / (stopDistance + roundTripFee)
    //
    // A 1:2 geometry that survives only before fees is not a 1:2 trade.
    const stopDistance = baseLevels.entry.minus(baseLevels.stopLoss).abs();
    if (stopDistance.lte(0)) {
      return this.reject('tpInvalid', 'Zero stop distance — Net R:R is undefined');
    }

    const targetDistance = resolution.takeProfit.minus(baseLevels.entry).abs();
    const roundTripFeeInPrice = baseLevels.entry.mul(ROUND_TRIP_TAKER_FEE);
    const netRr = targetDistance
      .minus(roundTripFeeInPrice)
      .div(stopDistance.plus(roundTripFeeInPrice));

    if (!netRr.isFinite() || netRr.lt(this.config.dynamicTpMinRr)) {
      return this.reject(
        'tpInvalid',
        `Net R:R ${netRr.toFixed(3)} < ${this.config.dynamicTpMinRr.toString()} (target ${targetDistance
          .div(baseLevels.entry)
          .mul(100)
          .toFixed(3)}% | stop ${stopDistance
          .div(baseLevels.entry)
          .mul(100)
          .toFixed(3)}% | fee ${ROUND_TRIP_TAKER_FEE.mul(100).toFixed(3)}%)`,
      );
    }

    // Stop geometry is re-derived through the single source of truth; the target
    // is substituted only after it has been validated against entry side.
    const levels = this.calculateLevelsWithTarget(
      entry,
      wickZone,
      direction,
      stopAtr,
      resolution.takeProfit,
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // No `zoneDetails`: PDH/PDL/PWH/PWL must never be burned (Invariant 21). The
    // trigger is a candle event, so it is burned as a STRUCTURE — its timestamp is
    // the identity that stops the same candle from firing twice (Invariant 39).
    this.setStructureDetails({
      type: 'SWEEP',
      timestamp: Number(sweepCandle.timestamp),
      price:
        direction === 'BEARISH'
          ? new Decimal(sweepCandle.high)
          : new Decimal(sweepCandle.low),
      direction,
    });

    stats.triggered++;
    this.setReason(
      `HTF Liquidity Sweep: ${sfp.pool.type} (${sfp.level.toString()}) swept at ${Number(sweepCandle.timestamp)} ` +
        `(high ${sweepCandle.high} / low ${sweepCandle.low}, close ${entry.toString()}) ` +
        `+ volume ${sweepVolume.div(baselineVolume).toFixed(2)}x baseline → ${direction} SFP`,
    );
    return true;
  }

  /**
   * SFP detection on a single candle across the ranked pool set.
   *
   * Short (high-side pool): `high > level && close < level`.
   * Long  (low-side pool) : `low < level && close > level`.
   *
   * Pools are consumed in `POOL_PRIORITY` order, so a candle that pierces two
   * levels deterministically reports the dominant one (PDH > PDL > PWH > PWL >
   * BSL > SSL) instead of depending on the order the recognizer emitted them in.
   */
  private detectSfp(
    candle: any,
    htfPools: any[],
  ): { pool: any; direction: Direction; level: Decimal } | null {
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

    const rankedPools = [...htfPools].sort(
      (a: any, b: any) =>
        (POOL_PRIORITY[a.type] ?? 99) - (POOL_PRIORITY[b.type] ?? 99),
    );

    for (const pool of rankedPools) {
      const side = POOL_SIDE[pool.type];
      if (!side) continue;

      const level: Decimal = pool.priceLevel;
      const isSfp =
        side === 'HIGH'
          ? high.gt(level) && close.lt(level)
          : low.lt(level) && close.gt(level);

      if (!isSfp) continue;

      return {
        pool,
        direction: side === 'HIGH' ? 'BEARISH' : 'BULLISH',
        level,
      };
    }

    return null;
  }

  /**
   * Institutional volume multiple (`SMC_SWEEP_VOLUME_MULTIPLIER`, default 1.3).
   *
   * Declared with a defensive fallback for hand-built config objects: a missing
   * value must never silently downgrade the gate to "no confirmation".
   */
  private resolveVolumeMultiplier(): Decimal {
    const configured = this.config.sweepVolumeMultiplier;
    if (configured instanceof Decimal && configured.isFinite() && configured.gt(0)) {
      return configured;
    }
    return DEFAULT_SWEEP_VOLUME_MULTIPLIER;
  }

  private reject(
    bucket: keyof Omit<Scenario5RejectionStats, 'totalEvals'>,
    reason: string,
  ): false {
    Scenario5_HTFLiquiditySweep.rejectionStats[bucket]++;
    this.setReason(reason);
    return false;
  }
}
