import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario5_HTFLiquiditySweep extends BaseScenario {
  constructor() {
    super(5, 'HTF Liquidity Sweep');
  }

  override evaluate(patternData: any): boolean {
    // CRITICAL: Killzone check - sweep must happen in London/NY killzone only (not ASIAN)
    const killzone = patternData.currentKillzone;
    if (!killzone || (killzone !== 'LONDON' && killzone !== 'NY')) {
      this.logRejection('HTF Liquidity Sweep requires London or NY killzone');
      return false;
    }

    const { candles15m, liquidityPools, structures, zones } = patternData;
    if (!candles15m?.length || !liquidityPools?.length) return false;

    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    // Find HTF liquidity pools: PDH, PDL, PWH, PWL, BSL, SSL
    const htfPools = liquidityPools.filter((pool: any) => 
      ['PDH', 'PDL', 'PWH', 'PWL', 'BSL', 'SSL'].includes(pool.type) && !pool.isTaken
    );

    if (!htfPools.length) {
      this.logRejection('No HTF liquidity pools (PDH/PDL/PWH/PWL/BSL/SSL) available');
      return false;
    }

    // Check for sweep of any HTF pool in the LAST confirmed candle
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    const lastClose = new Decimal(lastCandle.close);

    let sweptPool: any = null;
    let sweepDirection: 'BULLISH' | 'BEARISH' = 'BULLISH';

    for (const pool of htfPools) {
      const level = pool.priceLevel;

      // Bearish sweep: wicked above PDH/PWH/BSL, closed back below
      if (lastHigh.gt(level) && lastClose.lt(level)) {
        sweptPool = pool;
        sweepDirection = 'BEARISH';
        break;
      }
      // Bullish sweep: wicked below PDL/PWL/SSL, closed back above
      if (lastLow.lt(level) && lastClose.gt(level)) {
        sweptPool = pool;
        sweepDirection = 'BULLISH';
        break;
      }
    }

    if (!sweptPool) {
      this.logRejection('No HTF liquidity sweep detected in last candle');
      return false;
    }

    // CRITICAL: Verify aggressive CHoCH on 15m IMMEDIATELY after sweep
    const recentStructures = structures?.filter((s: any) => 
      s.direction === (sweepDirection === 'BULLISH' ? 'BULLISH' : 'BEARISH') &&
      s.kind === 'CHOCH' &&
      s.timestamp >= lastCandle.timestamp - 15 * 60 * 1000 // within last 15m candle
    ) || [];

    const choch = recentStructures[0];
    if (!choch) {
      this.logRejection(`No aggressive 15m CHoCH ${sweepDirection} after ${sweptPool.type} sweep`);
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR after sweep');
      return false;
    }

    // Check for fresh 15m FVG after CHoCH in sweep direction
    const freshFvgs = zones?.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === sweepDirection && 
      z.timeframe === '15' &&
      z.timestamp >= choch.timestamp
    ) || [];

    const fvg = freshFvgs[0];
    if (!fvg) {
      this.logRejection('No 15m FVG found after CHoCH following sweep');
      return false;
    }

    // Entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const sl = sweepDirection === 'BULLISH' 
      ? fvg.bottom.minus(atr15m.mul(0.5))
      : fvg.top.plus(atr15m.mul(0.5));
    const tp = sweepDirection === 'BULLISH'
      ? entry.plus(entry.minus(sl).mul(3))
      : entry.minus(sl.minus(entry).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`HTF Liquidity Sweep: ${sweptPool.type} swept in killzone + 15m CHoCH + FVG 0.5 entry`);
    return true;
  }
}