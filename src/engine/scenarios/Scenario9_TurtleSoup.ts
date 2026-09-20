import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario9_TurtleSoup extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noTradingRange: 0,
    noEqhEql: 0,
    noSfp: 0,
    rr: 0,
    premiumDiscount: 0,
    noRejectionWick: 0,
    totalEvals: 0
  };

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noTradingRange: 0,
      noEqhEql: 0,
      noSfp: 0,
      rr: 0,
      premiumDiscount: 0,
      noRejectionWick: 0,
      totalEvals: 0
    };
  }

  constructor() {
    super(9, 'Turtle Soup (Range SFP)');
  }

  /**
   * Check if two price levels are equal within tolerance (0.1% or 0.5*ATR)
   */
  private levelsEqual(price1: Decimal, price2: Decimal, tolerance: Decimal): boolean {
    return price1.minus(price2).abs().div(price1).lte(tolerance);
  }

  /**
   * Check rejection wick quality: wick that pierced level must be >= 40% of candle range
   * and candle must close in direction of trade (bullish close for long, bearish for short)
   */
  private checkRejectionWick(candle: any, level: Decimal, direction: 'LONG' | 'SHORT', wickThreshold: Decimal): boolean {
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    const open = new Decimal(candle.open);
    const close = new Decimal(candle.close);
    
    const candleRange = high.minus(low);
    if (candleRange.eq(0)) return false;
    
    if (direction === 'LONG') {
      // Bullish SFP: wick below level, close above level (bullish close)
      const wickBelow = low.lt(level) ? level.minus(low) : new Decimal(0);
      const wickRatio = wickBelow.div(candleRange);
      const bullishClose = close.gt(open);
      return wickRatio.gte(wickThreshold) && bullishClose;
    } else {
      // Bearish SFP: wick above level, close below level (bearish close)
      const wickAbove = high.gt(level) ? high.minus(level) : new Decimal(0);
      const wickRatio = wickAbove.div(candleRange);
      const bearishClose = close.lt(open);
      return wickRatio.gte(wickThreshold) && bearishClose;
    }
  }

  override evaluate(patternData: any): boolean {
    Scenario9_TurtleSoup.rejectionStats.totalEvals++;

    // CRITICAL: Killzone check - London/NY only for Turtle Soup
    const killzone = patternData.currentKillzone;
    if (!killzone || (killzone !== 'LONDON' && killzone !== 'NY')) {
      this.logRejection('Turtle Soup requires London or NY killzone');
      Scenario9_TurtleSoup.rejectionStats.killzone++;
      return false;
    }

    const { candles15m, tradingRange, liquidityPools } = patternData;
    if (!candles15m?.length || !tradingRange) {
      Scenario9_TurtleSoup.rejectionStats.noTradingRange++;
      return false;
    }

    const rangeHigh = tradingRange.high;
    const rangeLow = tradingRange.low;

    // Check for EQH/EQL - use tolerance matching (not exact equality)
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const eqTolerance = Decimal.max(new Decimal('0.001'), atr15m.mul(0.5).div(rangeHigh)); // 0.1% or 0.5*ATR
    
    const hasEqh = liquidityPools?.some((p: any) => p.type === 'EQH' && this.levelsEqual(p.priceLevel, rangeHigh, eqTolerance)) || false;
    const hasEql = liquidityPools?.some((p: any) => p.type === 'EQL' && this.levelsEqual(p.priceLevel, rangeLow, eqTolerance)) || false;

    if (!hasEqh && !hasEql) {
      this.logRejection('No EQH/EQL liquidity at range boundaries');
      Scenario9_TurtleSoup.rejectionStats.noEqhEql++;
      return false;
    }

    // Get the last closed candle (the one that just closed)
    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    const lastClose = new Decimal(lastCandle.close);
    const candleRange = lastHigh.minus(lastLow);
    if (candleRange.eq(0)) return false;

    const wickThreshold = patternData.patternRecognizer?.config?.wickRatioThreshold || new Decimal('0.4');

    // Check for BEARISH Turtle Soup (Range High sweep -> Short)
    if (hasEqh && lastHigh.gt(rangeHigh)) {
      // Use helper to check rejection wick
      if (this.checkRejectionWick(lastCandle, rangeHigh, 'SHORT', wickThreshold)) {
        // Valid Bearish SFP
        
        // Entry first (needed for safe SL calculation)
        const entry = lastClose; // Enter on close of SFP candle
        
        // SL = wick tip + 0.5 * ATR (SAFE: ensure SL > entry for SHORT)
        const atr = patternData.atr15m || new Decimal('0.01');
        const slOffset = atr.mul(new Decimal('0.5'));
        const stopLoss = Decimal.max(lastHigh, entry).plus(slOffset);
        // For SHORT: TP = entry - (stopLoss - entry) * 3
        const riskAmount = stopLoss.minus(entry).abs();
        const takeProfit = entry.minus(riskAmount.mul(3)); // 1:3 RR

        // R:R check - must be >= 1:3
        const rewardAmount = entry.minus(takeProfit).abs();
        if (rewardAmount.div(riskAmount).lt(new Decimal('3'))) {
          this.logRejection('R:R < 1:3');
          Scenario9_TurtleSoup.rejectionStats.rr++;
          return false;
        }

        this.setLevels({
          entry,
          stopLoss,
          takeProfit,
        });

        this.setReason(`Turtle Soup (Short): Range High SFP + Wick >= 40% + Close Inside + Bollinger Squeeze`);
        return true;
      } else {
        // Rejection wick check failed
        if (this.wickRatioBelowThreshold(lastCandle, rangeHigh, 'SHORT', wickThreshold)) {
          this.logRejection('Rejection wick too small: wick < 40% of candle range');
          Scenario9_TurtleSoup.rejectionStats.noRejectionWick++;
        } else {
          this.logRejection('SFP candle closes wrong direction (not bearish close)');
          Scenario9_TurtleSoup.rejectionStats.noRejectionWick++;
        }
        return false;
      }
    }

    // Check for BULLISH Turtle Soup (Range Low sweep -> Long)
    if (hasEql && lastLow.lt(rangeLow)) {
      // Use helper to check rejection wick
      if (this.checkRejectionWick(lastCandle, rangeLow, 'LONG', wickThreshold)) {
        // Valid Bullish SFP
        
        // Entry first (needed for safe SL calculation)
        const entry = lastClose; // Enter on close of SFP candle
        
        // SL = wick tip - 0.5 * ATR (SAFE: ensure SL < entry for LONG)
        const atr = patternData.atr15m || new Decimal('0.01');
        const slOffset = atr.mul(new Decimal('0.5'));
        const stopLoss = Decimal.min(lastLow, entry).minus(slOffset);
        const takeProfit = entry.plus(stopLoss.minus(entry).mul(3)); // 1:3 RR

        // R:R check - must be >= 1:3
        const riskAmount = entry.minus(stopLoss).abs();
        const reward = takeProfit.minus(entry).abs();
        if (reward.div(riskAmount).lt(new Decimal('3'))) {
          this.logRejection('R:R < 1:3');
          Scenario9_TurtleSoup.rejectionStats.rr++;
          return false;
        }

        this.setLevels({
          entry,
          stopLoss,
          takeProfit,
        });

        this.setReason(`Turtle Soup (Long): Range Low SFP + Wick >= 40% + Close Inside + Bollinger Squeeze`);
        return true;
      } else {
        // Rejection wick check failed
        if (this.wickRatioBelowThreshold(lastCandle, rangeLow, 'LONG', wickThreshold)) {
          this.logRejection('Rejection wick too small: wick < 40% of candle range');
          Scenario9_TurtleSoup.rejectionStats.noRejectionWick++;
        } else {
          this.logRejection('SFP candle closes wrong direction (not bullish close)');
          Scenario9_TurtleSoup.rejectionStats.noRejectionWick++;
        }
        return false;
      }
    }

    // No valid SFP found
    Scenario9_TurtleSoup.rejectionStats.noSfp++;
    return false;
  }

  /**
   * Check if rejection wick ratio is below threshold (helper for specific rejection reasons)
   */
  private wickRatioBelowThreshold(candle: any, level: Decimal, direction: 'LONG' | 'SHORT', wickThreshold: Decimal): boolean {
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    
    const candleRange = high.minus(low);
    if (candleRange.eq(0)) return true;
    
    if (direction === 'LONG') {
      const wickBelow = low.lt(level) ? level.minus(low) : new Decimal(0);
      const wickRatio = wickBelow.div(candleRange);
      return wickRatio.lt(wickThreshold);
    } else {
      const wickAbove = high.gt(level) ? high.minus(level) : new Decimal(0);
      const wickRatio = wickAbove.div(candleRange);
      return wickRatio.lt(wickThreshold);
    }
  }
}