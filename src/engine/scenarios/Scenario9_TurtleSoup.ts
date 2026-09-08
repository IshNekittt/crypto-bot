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
   * Check rejection wick quality: wick that pierced level must be >= 30% of candle range
   * and candle must close in direction of trade (bullish close for long, bearish for short)
   */
  private checkRejectionWick(candle: any, level: Decimal, direction: 'LONG' | 'SHORT'): boolean {
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
      return wickRatio.gte(0.3) && bullishClose;
    } else {
      // Bearish SFP: wick above level, close below level (bearish close)
      const wickAbove = high.gt(level) ? high.minus(level) : new Decimal(0);
      const wickRatio = wickAbove.div(candleRange);
      const bearishClose = close.lt(open);
      return wickRatio.gte(0.3) && bearishClose;
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
    const equilibrium = tradingRange.equilibrium;

    // Check for EQH/EQL - use tolerance matching (not exact equality)
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const eqTolerance = Decimal.max(new Decimal('0.001'), atr15m.mul(0.5).div(rangeHigh)); // 0.1% or 0.5*ATR
    
    const hasEqh = liquidityPools?.some((p: any) => p.type === 'EQH' && this.levelsEqual(p.priceLevel, rangeHigh, eqTolerance)) || false;
    const hasEql = liquidityPools?.some((p: any) => p.type === 'EQL' && this.levelsEqual(p.priceLevel, rangeLow, eqTolerance)) || false;

    if (!hasEqh && !hasEql) {
      this.logRejection('No clean EQH/EQL on range boundaries (within tolerance)');
      Scenario9_TurtleSoup.rejectionStats.noEqhEql++;
      return false;
    }

    // Check for SFP in last 6 candles (SFP candle could be 1-5 candles ago)
    // SFP: wick pierces EQH/EQL, close back inside range
    let sfpCandle: any = null;
    let direction: 'LONG' | 'SHORT' | null = null;
    let sfpWickPrice: Decimal | null = null;
    let sfpClosePrice: Decimal | null = null;

    const checkWindow = Math.min(6, candles15m.length);
    for (let i = candles15m.length - checkWindow; i < candles15m.length; i++) {
      const c = candles15m[i];
      const high = new Decimal(c.high);
      const low = new Decimal(c.low);
      const close = new Decimal(c.close);

      // Bearish SFP at EQH/Range High: wicked above, closed back inside
      if (hasEqh && high.gt(rangeHigh) && close.lt(rangeHigh) && close.gt(rangeLow)) {
        // Check rejection wick quality
        if (!this.checkRejectionWick(c, rangeHigh, 'SHORT')) {
          continue;
        }
        sfpCandle = c;
        direction = 'SHORT';
        sfpWickPrice = high;
        sfpClosePrice = close;
        break;
      }
      // Bullish SFP at EQL/Range Low: wicked below, closed back inside
      if (hasEql && low.lt(rangeLow) && close.gt(rangeLow) && close.lt(rangeHigh)) {
        // Check rejection wick quality
        if (!this.checkRejectionWick(c, rangeLow, 'LONG')) {
          continue;
        }
        sfpCandle = c;
        direction = 'LONG';
        sfpWickPrice = low;
        sfpClosePrice = close;
        break;
      }
      // Stronger SFP: wicked through and closed on opposite side
      if (hasEqh && high.gt(rangeHigh) && close.lt(rangeLow)) {
        if (!this.checkRejectionWick(c, rangeHigh, 'SHORT')) {
          continue;
        }
        sfpCandle = c;
        direction = 'SHORT';
        sfpWickPrice = high;
        sfpClosePrice = close;
        break;
      }
      if (hasEql && low.lt(rangeLow) && close.gt(rangeHigh)) {
        if (!this.checkRejectionWick(c, rangeLow, 'LONG')) {
          continue;
        }
        sfpCandle = c;
        direction = 'LONG';
        sfpWickPrice = low;
        sfpClosePrice = close;
        break;
      }
    }

    if (!sfpCandle || !direction || !sfpWickPrice || !sfpClosePrice) {
      this.logRejection('No SFP candle with valid rejection wick (>=30% range, close in direction)');
      Scenario9_TurtleSoup.rejectionStats.noRejectionWick++;
      return false;
    }

    // CRITICAL: Entry is IMMEDIATELY at market on SFP candle CLOSE
    const entry = sfpClosePrice;

    // SL: At the wick extreme (true invalidation point) + buffer (0.5 ATR)
    // If price goes back beyond the manipulation wick, the setup failed
    const slBuffer = atr15m.mul(0.5); // Increased from 0.2 to 0.5 ATR
    const sl = direction === 'LONG' ? sfpWickPrice.minus(slBuffer) : sfpWickPrice.plus(slBuffer);

    // TP: Range Equilibrium (0.5) instead of opposite boundary - better R:R and higher hit rate
    const tp = equilibrium;

    // Verify R:R >= 1:3
    const risk = direction === 'LONG' ? entry.minus(sl) : sl.minus(entry);
    const reward = direction === 'LONG' ? tp.minus(entry) : entry.minus(tp);
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3 (risk: ${risk.toFixed(4)}, reward: ${reward.toFixed(4)})`);
      Scenario9_TurtleSoup.rejectionStats.rr++;
      return false;
    }

    // Verify entry is in correct Premium/Discount zone
    // Longs only in Discount (below 0.5), Shorts only in Premium (above 0.5)
    const pdZone = entry.gt(equilibrium) ? 'PREMIUM' : entry.lt(equilibrium) ? 'DISCOUNT' : 'EQUILIBRIUM';
    if (direction === 'LONG' && pdZone !== 'DISCOUNT') {
      this.logRejection('Long entry not in Discount zone');
      Scenario9_TurtleSoup.rejectionStats.premiumDiscount++;
      return false;
    }
    if (direction === 'SHORT' && pdZone !== 'PREMIUM') {
      this.logRejection('Short entry not in Premium zone');
      Scenario9_TurtleSoup.rejectionStats.premiumDiscount++;
      return false;
    }

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Turtle Soup: SFP on ${hasEqh ? 'EQH' : 'EQL'} in ${killzone} killzone, rejection wick >=30%, immediate market entry on SFP candle close, SL at wick extreme + 0.5 ATR, target range equilibrium`);
    return true;
  }
}