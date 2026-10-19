import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';

export class Scenario5_HTFLiquiditySweep extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noPools: 0,
    noSweep: 0,
    noChoch: 0,
    displacement: 0,
    noFvg: 0,
    totalEvals: 0
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
      totalEvals: 0
    };
  }

  override evaluate(patternData: any): boolean {
    Scenario5_HTFLiquiditySweep.rejectionStats.totalEvals++;

    // CRITICAL: Killzone check - sweep must happen in London/NY killzone only (not ASIAN)
    // Bypassable globally via ENFORCE_KILLZONES=false (backtesting)
    const killzone = patternData.currentKillzone;
    if (this.config.enforceKillzones !== false && (!killzone || (killzone !== 'LONDON' && killzone !== 'NY'))) {
      this.logRejection('HTF Liquidity Sweep requires London or NY killzone');
      Scenario5_HTFLiquiditySweep.rejectionStats.killzone++;
      return false;
    }

    const { candles15m, liquidityPools, structures, zones } = patternData;
    if (!candles15m?.length || !liquidityPools?.length) {
      Scenario5_HTFLiquiditySweep.rejectionStats.noPools++;
      return false;
    }

    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    // Find HTF liquidity pools: PDH, PDL, PWH, PWL, BSL, SSL
    const htfPools = liquidityPools.filter((pool: any) => 
      ['PDH', 'PDL', 'PWH', 'PWL', 'BSL', 'SSL'].includes(pool.type) && !pool.isTaken
    );

    if (!htfPools.length) {
      this.logRejection('No HTF liquidity pools (PDH/PDL/PWH/PWL/BSL/SSL) available');
      Scenario5_HTFLiquiditySweep.rejectionStats.noPools++;
      return false;
    }

    // Check for sweep of any HTF pool in the LAST confirmed candle
    // SMC: Sweep = wick pierces level AND price closes back inside (SFP pattern)
    // Also accept: wick pierces level AND closes on other side (stronger sweep)
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    const lastClose = new Decimal(lastCandle.close);
    const lastOpen = new Decimal(lastCandle.open);

    let sweptPool: any = null;
    let sweepDirection: 'BULLISH' | 'BEARISH' = 'BULLISH';

    for (const pool of htfPools) {
      const level = pool.priceLevel;

      // Bearish sweep: wicked above level, closed back below (SFP)
      // OR: wicked above and closed below (strong bearish)
      const bearishSweep = lastHigh.gt(level) && lastClose.lt(level);
      const strongBearish = lastHigh.gt(level) && lastClose.lt(level) && lastClose.lt(lastOpen);

      // Bullish sweep: wicked below level, closed back above (SFP)
      // OR: wicked below and closed above (strong bullish)
      const bullishSweep = lastLow.lt(level) && lastClose.gt(level);
      const strongBullish = lastLow.lt(level) && lastClose.gt(level) && lastClose.gt(lastOpen);

      if (bearishSweep || strongBearish) {
        sweptPool = pool;
        sweepDirection = 'BEARISH';
        break;
      }
      if (bullishSweep || strongBullish) {
        sweptPool = pool;
        sweepDirection = 'BULLISH';
        break;
      }
    }

    if (!sweptPool) {
      this.logRejection('No HTF liquidity sweep detected in last candle');
      Scenario5_HTFLiquiditySweep.rejectionStats.noSweep++;
      return false;
    }

    // CRITICAL: Verify aggressive CHoCH on 15m AFTER sweep (within 4H window, not just 15m)
    // SMC: CHoCH can form within several candles after sweep as price reacts
    const recentStructures = structures?.filter((s: any) => 
      s.direction === (sweepDirection === 'BULLISH' ? 'BULLISH' : 'BEARISH') &&
      s.type === 'CHOCH' &&
      s.timestamp >= lastCandle.timestamp - 4 * 60 * 60 * 1000 // within last 4H (16 candles on 15m)
    ) || [];

    const choch = recentStructures[recentStructures.length - 1];
    if (!choch) {
      this.logRejection(`No aggressive 15m CHoCH ${sweepDirection} after ${sweptPool.type} sweep`);
      Scenario5_HTFLiquiditySweep.rejectionStats.noChoch++;
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR after sweep');
      Scenario5_HTFLiquiditySweep.rejectionStats.displacement++;
      return false;
    }

    // Check for 15m FVG after CHoCH in sweep direction
    // Allow FVG to form within reasonable window after CHoCH (up to 4H)
    const fvgsAfterChoch = zones?.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === sweepDirection && 
      z.timeframe === '15' &&
      z.timestamp >= choch.timestamp &&
      z.timestamp <= choch.timestamp + 4 * 60 * 60 * 1000 // within 4H after CHoCH
    ) || [];

    const fvg = fvgsAfterChoch[fvgsAfterChoch.length - 1];
    if (!fvg) {
      this.logRejection('No 15m FVG found after CHoCH following sweep');
      Scenario5_HTFLiquiditySweep.rejectionStats.noFvg++;
      return false;
    }

    // Entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');

    // Use centralized calculateLevels for safe SL/TP geometry (bidirectional)
    const levels = this.calculateLevels(
      entry,
      {
        top: fvg.top,
        bottom: fvg.bottom,
        direction: sweepDirection,
      },
      sweepDirection,
      atr15m,
      new Decimal(3),
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // Set zone details for mitigation tracking (the FVG we entered from)
    this.setZoneDetails({
      type: 'FVG',
      top: fvg.top,
      bottom: fvg.bottom,
      timeframe: '15',
      direction: sweepDirection,
      timestamp: fvg.timestamp,
    });

    // Set structure details for mitigation tracking (the CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction: sweepDirection,
    });

    this.setReason(`HTF Liquidity Sweep: ${sweptPool.type} swept in killzone + 15m CHoCH + FVG 0.5 entry`);
    return true;
  }
}