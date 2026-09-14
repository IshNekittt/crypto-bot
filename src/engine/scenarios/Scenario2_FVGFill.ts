import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario2_FVGFill extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noHtfFvg: 0,
    noFvgTouch: 0,
    noChoch: 0,
    displacement: 0,
    trendFilter: 0,
    noLiquidityContext: 0,
    totalEvals: 0
  };

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noHtfFvg: 0,
      noFvgTouch: 0,
      noChoch: 0,
      displacement: 0,
      trendFilter: 0,
      noLiquidityContext: 0,
      totalEvals: 0
    };
  }

  constructor() {
    super(2, 'FVG Fill');
  }

  /**
   * Check if there was a liquidity sweep or CHoCH in the last 10-15 candles
   * before the FVG was formed. This provides the "confluence" context.
   */
  private hasLiquidityContext(patternData: any, fvgTimestamp: number): boolean {
    const { candles15m, liquidityPools, structures } = patternData;
    if (!candles15m?.length) return false;

    // Find the index of the candle at/around FVG formation
    const fvgIndex = candles15m.findIndex((c: any) => c.timestamp === fvgTimestamp);
    if (fvgIndex < 0) return false;

    // Look back 10-15 candles from FVG formation
    const lookbackStart = Math.max(0, fvgIndex - 15);
    const lookbackEnd = fvgIndex;
    
    // Check for sweeps in liquidity pools within lookback window
    const recentPools = liquidityPools?.filter((p: any) => 
      p.timestamp >= candles15m[lookbackStart].timestamp &&
      p.timestamp <= candles15m[lookbackEnd].timestamp &&
      p.isTaken
    ) || [];

    if (recentPools.length > 0) return true;

    // Check for CHoCH or BOS in structures within lookback window
    const recentStructures = structures?.filter((s: any) => 
      s.timestamp >= candles15m[lookbackStart].timestamp &&
      s.timestamp <= candles15m[lookbackEnd].timestamp &&
      (s.type === 'CHOCH' || s.type === 'BOS')
    ) || [];

    return recentStructures.length > 0;
  }

  override evaluate(patternData: any): boolean {
    Scenario2_FVGFill.rejectionStats.totalEvals++;

    if (!patternData.currentKillzone || patternData.currentKillzone === 'NONE') {
      this.logRejection('Not in active killzone');
      Scenario2_FVGFill.rejectionStats.killzone++;
      return false;
    }

    // Find HTF FVG (4H or Daily)
    const htfFvgs = patternData.zones?.filter((z: any) => 
      z.type === 'FVG' && (z.timeframe === '240' || z.timeframe === 'D')
    ) || [];

    if (!htfFvgs.length) {
      this.logRejection('No HTF FVG found');
      Scenario2_FVGFill.rejectionStats.noHtfFvg++;
      return false;
    }

    // Get the most recent HTF FVG
    const htfFvg = htfFvgs[0];
    const lastCandle = patternData.candles15m[patternData.candles15m.length - 1];
    if (!lastCandle) return false;

    // CRITICAL: 0.5 RULE - Price must touch EXACTLY 50% (Equilibrium) of FVG
    // Not "near" or "close" - EXACTLY 0.5 level
    const lastClose = new Decimal(lastCandle.close);
    const eq = htfFvg.top.plus(htfFvg.bottom).dividedBy(2);
    
    // Check if price touched EXACTLY the 0.5 level (within tick precision)
    const touched50 = lastClose.eq(eq) || 
      (new Decimal(lastCandle.low).lte(eq) && new Decimal(lastCandle.high).gte(eq));

    if (!touched50) {
      this.logRejection(`Price has not touched 0.5 (Equilibrium) of HTF FVG. Current: ${lastClose.toFixed(4)}, EQ: ${eq.toFixed(4)}`);
      Scenario2_FVGFill.rejectionStats.noFvgTouch++;
      return false;
    }

    // CONFLUENCE FILTER: FVG must have liquidity context (sweep or CHoCH/BOS in prior 10-15 candles)
    if (!this.hasLiquidityContext(patternData, htfFvg.timestamp)) {
      this.logRejection('No liquidity context (sweep/CHoCH/BOS) in 15 candles before HTF FVG formation');
      Scenario2_FVGFill.rejectionStats.noLiquidityContext++;
      return false;
    }

    // Check for 15m CHoCH with Displacement validation (any valid CHoCH after FVG touch)
    const choch = patternData.structures?.find((s: any) => 
      s.type === 'CHOCH' && s.direction === 'BULLISH'
    );
    if (!choch) {
      this.logRejection('No 15m CHoCH after FVG touch');
      Scenario2_FVGFill.rejectionStats.noChoch++;
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR');
      Scenario2_FVGFill.rejectionStats.displacement++;
      return false;
    }

    // FIX: 4H Trend Filter - Only allow longs if 4H structure is BULLISH
    const htfStructures = patternData.structures?.filter((s: any) => 
      (s.timeframe === '240' || s.timeframe === '4H') && 
      (s.type === 'BOS' || s.type === 'CHOCH')
    ) || [];
    
    const hasBullish4h = htfStructures.some((s: any) => s.direction === 'BULLISH');
    const hasBearish4h = htfStructures.some((s: any) => s.direction === 'BEARISH');
    
    // For long entries, 4H trend must be BULLISH (no BEARISH structures)
    if (!hasBullish4h || hasBearish4h) {
      this.logRejection('4H trend not bullish - entry against HTF trend');
      Scenario2_FVGFill.rejectionStats.trendFilter++;
      return false;
    }

    // Entry at 0.5 of HTF FVG
    const entry = htfFvg.top.plus(htfFvg.bottom).dividedBy(2);

    // Use base class calculateLevels with BULLISH direction (Long only)
    const levels = this.calculateLevels(
      entry,
      {
        top: htfFvg.top,
        bottom: htfFvg.bottom,
        direction: 'BULLISH',
      },
      'BULLISH',
      patternData.atr15m || new Decimal('0.01'),
    );

    this.setLevels({
      entry: levels.entry.toFixed(2),
      stopLoss: levels.stopLoss.toFixed(2),
      takeProfit: levels.takeProfit.toFixed(2),
    });

    this.setReason(`FVG Fill: HTF FVG 0.5 touch + liquidity context + 15m CHoCH`);
    return true;
  }
}