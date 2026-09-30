import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { SwingPoint } from '../../smc/patternRecognizer';

export class Scenario10_BreakerBlock extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noBreak: 0,
    noBrokenOb: 0,
    noFvg: 0,
    noRetest: 0,
    noLiquiditySweep: 0,
    displacement: 0,
    bodyClose: 0,
    notBos: 0,
    obNotFresh: 0,
    totalEvals: 0
  };

  constructor(config: BotConfig) {
    super(10, 'Breaker Block Entry', config);
  }

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noBreak: 0,
      noBrokenOb: 0,
      noFvg: 0,
      noRetest: 0,
      noLiquiditySweep: 0,
      displacement: 0,
      bodyClose: 0,
      notBos: 0,
      obNotFresh: 0,
      totalEvals: 0
    };
  }

  /**
   * Check if the broken OB's extreme was a liquidity sweep (swept swing point)
   * For bearish OB (broken by bullish break): OB.top must have been a swing high that got swept
   * For bullish OB (broken by bearish break): OB.bottom must have been a swing low that got swept
   */
  private wasObExtremeLiquiditySwept(ob: any, candles: any[], breakDirection: 'BULLISH' | 'BEARISH'): boolean {
    if (candles.length < 20) return false;
    
    const lookbackCandles = candles.slice(-50); // Check last 50 candles for swing point
    
    if (breakDirection === 'BULLISH') {
      // Bearish OB was broken by bullish break - check if OB.top was a swing high that got swept
      const obTop = ob.top;
      
      // Find swing highs in lookback
      const swingHighs: SwingPoint[] = [];
      for (let i = 2; i < lookbackCandles.length - 2; i++) {
        const isHigh = lookbackCandles.slice(i - 2, i + 3).every((c, idx) => 
          idx === 2 || new Decimal(c.high).lt(lookbackCandles[i].high)
        );
        if (isHigh) {
          swingHighs.push({
            type: 'HIGH',
            price: new Decimal(lookbackCandles[i].high),
            timestamp: lookbackCandles[i].timestamp,
            index: i,
            isSwept: false
          });
        }
      }
      
      // Check if any swing high matches OB.top (within 0.1% tolerance) and was swept
      for (const swing of swingHighs) {
        const diff = swing.price.minus(obTop).abs().div(swing.price);
        if (diff.lte(new Decimal('0.001'))) {
          // Check if this swing high was swept (wick above, close below)
          // Look at candles after this swing
          const swingIdx = lookbackCandles.findIndex(c => c.timestamp === swing.timestamp);
          if (swingIdx >= 0) {
            for (let i = swingIdx + 1; i < lookbackCandles.length; i++) {
              const c = lookbackCandles[i];
              const high = new Decimal(c.high);
              const close = new Decimal(c.close);
              if (high.gt(swing.price) && close.lt(swing.price)) {
                return true; // Liquidity swept!
              }
            }
          }
        }
      }
      return false;
    } else {
      // Bullish OB was broken by bearish break - check if OB.bottom was a swing low that got swept
      const obBottom = ob.bottom;
      
      // Find swing lows in lookback
      const swingLows: SwingPoint[] = [];
      for (let i = 2; i < lookbackCandles.length - 2; i++) {
        const isLow = lookbackCandles.slice(i - 2, i + 3).every((c, idx) => 
          idx === 2 || new Decimal(c.low).gt(lookbackCandles[i].low)
        );
        if (isLow) {
          swingLows.push({
            type: 'LOW',
            price: new Decimal(lookbackCandles[i].low),
            timestamp: lookbackCandles[i].timestamp,
            index: i,
            isSwept: false
          });
        }
      }
      
      // Check if any swing low matches OB.bottom (within 0.1% tolerance) and was swept
      for (const swing of swingLows) {
        const diff = swing.price.minus(obBottom).abs().div(swing.price);
        if (diff.lte(new Decimal('0.001'))) {
          // Check if this swing low was swept (wick below, close above)
          const swingIdx = lookbackCandles.findIndex(c => c.timestamp === swing.timestamp);
          if (swingIdx >= 0) {
            for (let i = swingIdx + 1; i < lookbackCandles.length; i++) {
              const c = lookbackCandles[i];
              const low = new Decimal(c.low);
              const close = new Decimal(c.close);
              if (low.lt(swing.price) && close.gt(swing.price)) {
                return true; // Liquidity swept!
              }
            }
          }
        }
      }
      return false;
    }
  }

  override evaluate(patternData: any): boolean {
    Scenario10_BreakerBlock.rejectionStats.totalEvals++;

    // Breaker Block can work in any killzone, but prefer active sessions
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      Scenario10_BreakerBlock.rejectionStats.killzone++;
      return false;
    }

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) return false;

    // Find Breaker Block: an OB that was impulsively broken through (close beyond OB)
    // The broken OB becomes a Breaker Block - price should return to test it
    
    // Look for a structure break (BOS only - not CHoCH) that broke through an OB
    // BOS is more reliable for Breaker Blocks than CHoCH
    const breaksThroughOb = structures.filter((s: any) => {
      if (s.type !== 'BOS') return false; // Only BOS, not CHoCH
      const brokenObs = zones.filter((z: any) => 
        z.type === 'OB' && 
        z.direction === (s.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH') && // opposite direction OB
        s.price.gt(z.top) && s.price.gt(z.bottom) // for bullish break, price broke above bearish OB
      );
      return brokenObs.length > 0;
    });

    if (!breaksThroughOb.length) {
      this.logRejection('No OB broken by impulsive BOS (Break of Structure)');
      Scenario10_BreakerBlock.rejectionStats.noBreak++;
      return false;
    }

    const breakEvent = breaksThroughOb[0];
    const brokenObDirection = breakEvent.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    
    // Find the OB that was broken
    const brokenOb = zones.find((z: any) => 
      z.type === 'OB' && 
      z.direction === brokenObDirection &&
      breakEvent.price.gt(z.top) // for bullish break, broke above bearish OB top
    );

    if (!brokenOb) {
      this.logRejection('Broken OB not found');
      Scenario10_BreakerBlock.rejectionStats.noBrokenOb++;
      return false;
    }

    // FILTER: Broken OB must be fresh (formed within 24H before break)
    // Old OBs are less reliable as Breaker Blocks
    const obAge = breakEvent.timestamp - brokenOb.timestamp;
    const maxObAge = 24 * 60 * 60 * 1000; // 24 hours
    if (obAge > maxObAge) {
      this.logRejection('Broken OB too old (>24H) - not a fresh Breaker Block');
      Scenario10_BreakerBlock.rejectionStats.obNotFresh++;
      return false;
    }

    // CRITICAL FILTER: The broken OB's extreme must have swept liquidity before being broken
    // i.e., OB.top (for bearish OB) or OB.bottom (for bullish OB) must have been a swing point that got swept
    if (!this.wasObExtremeLiquiditySwept(brokenOb, candles15m, breakEvent.direction)) {
      this.logRejection('Broken OB extreme did not sweep liquidity (not a true Breaker Block)');
      Scenario10_BreakerBlock.rejectionStats.noLiquiditySweep++;
      return false;
    }

    // Check for MANDATORY FVG near the breaker (displacement confirmation)
    const nearbyFvgs = zones.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === breakEvent.direction &&
      z.timestamp >= breakEvent.timestamp - 15 * 60 * 1000 &&
      z.timestamp <= breakEvent.timestamp + 15 * 60 * 1000
    );

    if (!nearbyFvgs.length) {
      this.logRejection('No FVG near Breaker Block (displacement required)');
      Scenario10_BreakerBlock.rejectionStats.noFvg++;
      return false;
    }

    // Wait for price to return and test the Breaker Block (mirror test)
    // SMC RULE: Entry ONLY on RETEST after breakout candle CLOSES
    // The breakEvent.timestamp is the breakout candle timestamp
    // We must be on a SUBSEQUENT candle (retest)
    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    // CRITICAL: Must be on a candle AFTER the breakout candle (retest, not breakout)
    // Also: Retest must happen within 4H of break (not days later)
    if (lastCandle.timestamp <= breakEvent.timestamp) {
      this.logRejection('Entry only allowed on retest candle AFTER breakout candle closes');
      Scenario10_BreakerBlock.rejectionStats.noRetest++;
      return false;
    }
    const retestWindow = 4 * 60 * 60 * 1000; // 4 hours
    if (lastCandle.timestamp > breakEvent.timestamp + retestWindow) {
      this.logRejection('Retest too late (>4H after break) - Breaker Block expired');
      Scenario10_BreakerBlock.rejectionStats.noRetest++;
      return false;
    }

    const lastClose = new Decimal(lastCandle.close);
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);

    // Breaker Block zone = the original OB zone
    const breakerTop = brokenOb.top;
    const breakerBottom = brokenOb.bottom;

    // Price should test the breaker zone on RETEST
    const testingBreakerNow = breakEvent.direction === 'BULLISH'
      ? lastLow.lte(breakerTop) && lastClose.gte(breakerBottom)
      : lastHigh.gte(breakerBottom) && lastClose.lte(breakerTop);

    if (!testingBreakerNow) {
      this.logRejection('Price not testing Breaker Block zone on retest');
      Scenario10_BreakerBlock.rejectionStats.noRetest++;
      return false;
    }

    // Verify structure break was valid (body close with displacement)
    if (!this.isValidBodyClose(breakEvent)) {
      this.logRejection('Original break not validated (wick only)');
      Scenario10_BreakerBlock.rejectionStats.bodyClose++;
      return false;
    }
    if (!this.isValidDisplacement(breakEvent, 1.5)) {
      this.logRejection('Original break displacement < 1.5 ATR');
      Scenario10_BreakerBlock.rejectionStats.displacement++;
      return false;
    }

    // Entry at 0.5 (Equilibrium) of Breaker Block
    const entry = breakerTop.plus(breakerBottom).dividedBy(2);

    // Use base class calculateLevels with correct trade direction (breakEvent.direction)
    const levels = this.calculateLevels(
      entry,
      {
        top: breakerTop,
        bottom: breakerBottom,
        direction: breakEvent.direction, // zone direction = trade direction
      },
      breakEvent.direction, // trade direction = BOS direction
      patternData.atr15m || new Decimal('0.01'),
      new Decimal(2), // TP: 2R instead of 3R for higher hit rate on Breaker Blocks
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    this.setReason(`Breaker Block: ${brokenObDirection} OB (liquidity swept, fresh) broken by ${breakEvent.direction} BOS + FVG + mirror test at 0.5, target 2R`);
    return true;
  }
}