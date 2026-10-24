import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/** Sweep window: the last 16 LTF candles (4H on a 15m entry timeframe). */
const SWEEP_LOOKBACK_CANDLES = 16;
/** 15m entry timeframe of this scenario. */
const ENTRY_TIMEFRAME = '15';
/** 4H causality budget for sweep → CHoCH and CHoCH → FVG. */
const CAUSALITY_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Deterministic tie-break when several pools are swept by the SAME candle.
 * Price order alone is not reproducible (two pools can sit at equal distance),
 * so the ranking is explicit: macro session extremes first, then swing liquidity.
 */
const POOL_PRIORITY: Record<string, number> = {
  PDH: 0,
  PDL: 1,
  PWH: 2,
  PWL: 3,
  BSL: 4,
  SSL: 5,
};

const SWEEP_POOL_TYPES = Object.keys(POOL_PRIORITY);

type Direction = 'BULLISH' | 'BEARISH';

/**
 * Scenario 5 — HTF Liquidity Sweep.
 *
 * PDH/PDL/PWH/PWL/BSL/SSL sweep in a London/NY killzone → 15m CHoCH → 15m FVG
 * retest entry.
 *
 * The sweep is searched across the last 16 LTF candles, not only the latest one:
 * a sweep is frequently confirmed a few candles after the wick that produced it,
 * and requiring the CHoCH on the very next candle discarded most valid sequences.
 * Causality stays strict — `CHoCH.timestamp >= sweptAt` — so a structure that
 * formed BEFORE the sweep can never justify it.
 */
export class Scenario5_HTFLiquiditySweep extends BaseScenario {
  private static rejectionStats = {
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

    // CRITICAL: Killzone check - sweep must happen in London/NY killzone only (not ASIAN)
    // Bypassable globally via ENFORCE_KILLZONES=false (backtesting)
    const killzone = patternData.currentKillzone;
    if (this.config.enforceKillzones !== false && (!killzone || (killzone !== 'LONDON' && killzone !== 'NY'))) {
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
        pool.priceLevel.gt(0)
    );

    if (!htfPools.length) {
      this.logRejection('No HTF liquidity pools (PDH/PDL/PWH/PWL/BSL/SSL) available');
      stats.noPools++;
      return false;
    }

    // === SWEEP SCAN (last 4H of 15m candles) ===
    // A sweep is not a "last candle" event: price can take a pool and only close
    // back inside a few bars later. Scanning the whole 4H window is what makes
    // the causality gate below meaningful.
    // SMC: sweep = wick pierces the level AND price closes back inside (SFP).
    const sweepWindow = candles15m.slice(-SWEEP_LOOKBACK_CANDLES);

    // Deterministic pool ranking: on a timestamp tie the higher-ranked pool is the
    // dominant liquidity event (PDH > PDL > PWH > PWL > BSL > SSL).
    const rankedPools = [...htfPools].sort(
      (a: any, b: any) =>
        (POOL_PRIORITY[a.type] ?? 99) - (POOL_PRIORITY[b.type] ?? 99),
    );

    let sweptPool: any = null;
    let sweepDirection: Direction | null = null;
    let sweptAt = 0;

    for (const pool of rankedPools) {
      const level = pool.priceLevel;

      // Newest -> oldest: the first hit is this pool's most recent sweep.
      for (let i = sweepWindow.length - 1; i >= 0; i--) {
        const candle = sweepWindow[i];
        const high = new Decimal(candle.high);
        const low = new Decimal(candle.low);
        const close = new Decimal(candle.close);

        const bearishSweep = high.gt(level) && close.lt(level);
        const bullishSweep = low.lt(level) && close.gt(level);
        if (!bearishSweep && !bullishSweep) continue;

        // Latest sweep across ALL pools wins. Strict `>` keeps the higher-ranked
        // pool on a timestamp tie (pools are iterated in rank order).
        if (Number(candle.timestamp) > sweptAt) {
          sweptAt = Number(candle.timestamp);
          sweptPool = pool;
          sweepDirection = bearishSweep ? 'BEARISH' : 'BULLISH';
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
    // The replaced code measured a lower bound from the LAST candle, so a CHoCH
    // printed BEFORE the sweep passed. Causality now runs from `sweptAt`; the
    // same candle is allowed because sweep and break can print together.
    const chochs = (structures ?? []).filter(
      (s: any) =>
        s.type === 'CHOCH' &&
        s.direction === direction &&
        String(s.timeframe) === ENTRY_TIMEFRAME &&
        Number(s.timestamp) >= sweptAt &&
        Number(s.timestamp) <= sweptAt + CAUSALITY_WINDOW_MS
    );

    const choch = chochs[chochs.length - 1];
    if (!choch) {
      this.logRejection(`No aggressive 15m CHoCH ${direction} after ${sweptPool.type} sweep`);
      stats.noChoch++;
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR after sweep');
      stats.displacement++;
      return false;
    }

    // Check for 15m FVG after CHoCH in sweep direction (up to 4H after the CHoCH)
    const fvg = [...(zones ?? [])].reverse().find(
      (z: any) =>
        z.type === 'FVG' &&
        z.direction === direction &&
        String(z.timeframe) === ENTRY_TIMEFRAME &&
        Number(z.timestamp) >= Number(choch.timestamp) &&
        Number(z.timestamp) <= Number(choch.timestamp) + CAUSALITY_WINDOW_MS
    );

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

    // The stop comes from `calculateLevels()` (single source of truth); the target
    // from market structure. `skipMinorObstacles: false` keeps the legacy wall
    // semantics — the nearest obstacle decides, and no room means no trade.
    const resolution = resolveTakeProfit({
      direction,
      entry,
      stopLoss: this.calculateLevels(entry, fvgZone, direction, atr, new Decimal(1)).stopLoss,
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
      offsetMultiplier
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

    // Set structure details for mitigation tracking (the CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: Number(choch.timestamp),
      price: new Decimal(choch.price),
      direction,
    });

    this.setReason(
      `HTF Liquidity Sweep: ${sweptPool.type} swept at ${sweptAt} in killzone + 15m CHoCH + FVG 0.5 entry`
    );
    return true;
  }
}
