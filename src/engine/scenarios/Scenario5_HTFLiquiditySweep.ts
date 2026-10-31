import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/** Sweep window: the last 16 LTF candles (4H on a 15m entry timeframe). */
const SWEEP_LOOKBACK_CANDLES = 16;
/** 15m entry timeframe of this scenario. */
const ENTRY_TIMEFRAME = '15';
/** `detectFVGs()` stamps a gap at c1; it completes two bars later on c3. */
const FVG_FORMATION_CANDLES = 2;
/** Fallback LTF spacing when the candle series is too short to measure. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

/**
 * Deterministic tie-break when several pools are swept by the SAME candle.
 * Recency remains the primary causal key: the CHoCH must react to the latest
 * liquidity event. Priority only decides which pool is reported when two events
 * share a timestamp, so the output never depends on array order.
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

/**
 * Scenario 5 — HTF Liquidity Sweep.
 *
 * PDH/PDL/PWH/PWL/BSL/SSL sweep in a London/NY killzone → 15m CHoCH → 15m FVG
 * retest entry.
 *
 * Causal contract:
 *  1. The sweep is searched across the last 16 LTF candles (4H on 15m), not only
 *     the latest one — a sweep is frequently confirmed a few candles after the
 *     wick that produced it.
 *  2. When several pools are swept, the LATEST sweep is the causal event; pool
 *     priority only breaks same-candle ties deterministically.
 *  3. The CHoCH must print at/after `sweptAt` (`>=`, so a same-candle break is
 *     allowed) and inside one 4H window. A structure that formed BEFORE the
 *     sweep can never justify it.
 *  4. The FVG must COMPLETE at/after the CHoCH. Raw `c1` stamps are two bars
 *     early and would discard the impulse gap the CHoCH itself creates.
 */
export class Scenario5_HTFLiquiditySweep extends BaseScenario {
  private static rejectionStats = {
    wrongMode: 0,
    killzone: 0,
    noPools: 0,
    noSweep: 0,
    noChoch: 0,
    displacement: 0,
    noFvg: 0,
    tpInvalid: 0,
    totalEvals: 0,
  };

  constructor(config: BotConfig) {
    super(5, 'HTF Liquidity Sweep', config);
  }

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      wrongMode: 0,
      killzone: 0,
      noPools: 0,
      noSweep: 0,
      noChoch: 0,
      displacement: 0,
      noFvg: 0,
      tpInvalid: 0,
      totalEvals: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario5_HTFLiquiditySweep.rejectionStats;
    stats.totalEvals++;

    // Mode guard (audit F-03): Scenario 5 is a 15m Classic pattern. In Sniper
    // Mode the router is driven by 1m closes, so the same stale 15m candle would
    // be re-evaluated on every tick. Fail closed rather than stage a stale entry.
    if (
      this.config.enableSniperMode ||
      this.config.ltfTimeframe !== ENTRY_TIMEFRAME
    ) {
      this.logRejection(
        'Scenario 5 is Classic 15m-only (Sniper Mode or non-15m LTF active)',
      );
      stats.wrongMode++;
      return false;
    }

    // Sweep must happen in a London/NY killzone (not ASIAN). Bypassable globally
    // via ENFORCE_KILLZONES=false (backtesting).
    const killzone = patternData.currentKillzone;
    if (
      this.config.enforceKillzones !== false &&
      (!killzone || (killzone !== 'LONDON' && killzone !== 'NY'))
    ) {
      this.logRejection('HTF Liquidity Sweep requires London or NY killzone');
      stats.killzone++;
      return false;
    }

    const { candles15m, liquidityPools, structures, zones } = patternData;
    if (!candles15m?.length || !liquidityPools?.length) {
      stats.noPools++;
      return false;
    }

    // Find HTF liquidity pools: PDH, PDL, PWH, PWL, BSL, SSL
    const htfPools = liquidityPools.filter(
      (pool: any) =>
        SWEEP_POOL_TYPES.includes(pool.type) &&
        !pool.isTaken &&
        pool.priceLevel instanceof Decimal &&
        pool.priceLevel.gt(0),
    );

    if (!htfPools.length) {
      this.logRejection(
        'No HTF liquidity pools (PDH/PDL/PWH/PWL/BSL/SSL) available',
      );
      stats.noPools++;
      return false;
    }

    const ltfMs = this.resolveCandleMs(candles15m);
    const causalityWindowMs = SWEEP_LOOKBACK_CANDLES * ltfMs;

    // === SWEEP SCAN (last 4H of 15m candles) ===
    // A sweep is not a "last candle" event: price can take a pool and only close
    // back inside a few bars later. Scanning the whole 4H window is what makes
    // the causality gate below meaningful.
    // SMC: sweep = wick pierces the level AND price closes back inside (SFP).
    const sweepWindow = candles15m.slice(-SWEEP_LOOKBACK_CANDLES);
    if (sweepWindow.length === 0) {
      this.logRejection('No 15m candle available');
      stats.noPools++;
      return false;
    }

    // Deterministic pool ranking: on a timestamp tie the higher-ranked pool is
    // the dominant liquidity event (PDH > PDL > PWH > PWL > BSL > SSL).
    const rankedPools = [...htfPools].sort(
      (a: any, b: any) =>
        (POOL_PRIORITY[a.type] ?? 99) - (POOL_PRIORITY[b.type] ?? 99),
    );

    let sweptPool: any = null;
    let sweepDirection: Direction | null = null;
    let sweptAt = 0;

    for (const pool of rankedPools) {
      const level = pool.priceLevel;
      const side = POOL_SIDE[pool.type];
      if (!side) continue;

      // Newest -> oldest: the first hit is this pool's most recent sweep.
      for (let i = sweepWindow.length - 1; i >= 0; i--) {
        const candle = sweepWindow[i];
        const high = new Decimal(candle.high);
        const low = new Decimal(candle.low);
        const close = new Decimal(candle.close);

        const isSweep =
          side === 'HIGH'
            ? high.gt(level) && close.lt(level)
            : low.lt(level) && close.gt(level);
        if (!isSweep) continue;

        // The LATEST sweep across ALL pools is the causal liquidity event.
        // Strict `>` keeps the higher-ranked pool on a timestamp tie, because
        // pools are iterated in rank order.
        const candleTimestamp = Number(candle.timestamp);
        if (candleTimestamp > sweptAt) {
          sweptAt = candleTimestamp;
          sweptPool = pool;
          sweepDirection = side === 'HIGH' ? 'BEARISH' : 'BULLISH';
        }
        break;
      }
    }

    if (!sweptPool || !sweepDirection) {
      this.logRejection('No HTF liquidity sweep detected in last 16 candles');
      stats.noSweep++;
      return false;
    }

    const direction: Direction = sweepDirection;

    // === CAUSALITY: the CHoCH must FOLLOW the sweep ===
    // A CHoCH that printed before the sweep describes the previous reaction and
    // must never validate this one. The same candle is allowed because sweep and
    // break can print together.
    const chochs = (structures ?? [])
      .filter(
        (s: any) =>
          s.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= sweptAt &&
          Number(s.timestamp) <= sweptAt + causalityWindowMs,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochs[chochs.length - 1];
    if (!choch) {
      this.logRejection(
        `No aggressive 15m CHoCH ${direction} after ${sweptPool.type} sweep`,
      );
      stats.noChoch++;
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR (AGENTS.md §7.2)
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR after sweep');
      stats.displacement++;
      return false;
    }

    // === FVG after the CHoCH (completion-bar causality) ===
    // `detectFVGs()` stamps the gap at c1, two bars before it completes on c3.
    // Measuring from the completion bar admits the impulse FVG left by the CHoCH
    // while still rejecting a gap that fully formed before the trigger.
    const fvgs = (zones ?? []).filter((z: any) => {
      if (z.type !== 'FVG') return false;
      if (z.direction !== direction) return false;
      if (String(z.timeframe) !== ENTRY_TIMEFRAME) return false;
      const completesAt =
        Number(z.timestamp) + FVG_FORMATION_CANDLES * ltfMs;
      return (
        completesAt >= Number(choch.timestamp) &&
        completesAt <= Number(choch.timestamp) + causalityWindowMs
      );
    });

    const fvg = fvgs[fvgs.length - 1];
    if (!fvg) {
      this.logRejection('No 15m FVG found after CHoCH following sweep');
      stats.noFvg++;
      return false;
    }

    // Entry at 0.5 (Equilibrium) of FVG
    const entry = new Decimal(fvg.top).plus(fvg.bottom).dividedBy(2);
    const fvgZone = {
      top: new Decimal(fvg.top),
      bottom: new Decimal(fvg.bottom),
      direction,
    };

    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    const offsetMultiplier = this.config.smcSlAtrOffset
      ? new Decimal(this.config.smcSlAtrOffset)
      : new Decimal('0.5');

    // The stop comes from `calculateLevels()` (single source of truth); the
    // target from market structure. `skipMinorObstacles: false` keeps the legacy
    // wall semantics — the nearest obstacle decides, and no room means no trade.
    const base = this.calculateLevels(
      entry,
      fvgZone,
      direction,
      atr,
      new Decimal(1),
      offsetMultiplier,
    );

    const resolution = resolveTakeProfit({
      direction,
      entry: base.entry,
      stopLoss: base.stopLoss,
      zones: zones ?? [],
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
      this.logRejection(`Take-profit rejected: ${resolution.reason}`);
      stats.tpInvalid++;
      return false;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      fvgZone,
      direction,
      atr,
      resolution.takeProfit,
      offsetMultiplier,
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // Set zone details for mitigation tracking (the FVG we entered from)
    this.setZoneDetails({
      type: 'FVG',
      top: fvgZone.top,
      bottom: fvgZone.bottom,
      timeframe: ENTRY_TIMEFRAME,
      direction,
      timestamp: Number(fvg.timestamp),
    });

    // Set structure details for mitigation tracking (the CHoCH is the trigger)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: Number(choch.timestamp),
      price: new Decimal(choch.price),
      direction,
    });

    this.setReason(
      `HTF Liquidity Sweep: ${sweptPool.type} swept at ${sweptAt} in killzone + 15m CHoCH + FVG 0.5 entry`,
    );
    return true;
  }

  /**
   * Candle spacing of the entry series, in milliseconds.
   *
   * The sweep / CHoCH / FVG windows are all "16 LTF candles", so the budget must
   * be expressed in the LTF actually in use, never assumed to be 15 minutes
   * (Invariant 12).
   */
  private resolveCandleMs(candles: any[]): number {
    const start = Math.max(1, candles.length - 5);
    for (let i = start; i < candles.length; i++) {
      const delta =
        Number(candles[i].timestamp) - Number(candles[i - 1].timestamp);
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
    return DEFAULT_LTF_MS;
  }
}
