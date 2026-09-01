import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario9_TurtleSoup extends BaseScenario {
  constructor() {
    super(9, 'Turtle Soup (Range SFP)');
  }

  override evaluate(patternData: any): boolean {
    // CRITICAL: Killzone check - London/NY only for Turtle Soup
    const killzone = patternData.currentKillzone;
    if (!killzone || (killzone !== 'LONDON' && killzone !== 'NY')) {
      this.logRejection('Turtle Soup requires London or NY killzone');
      return false;
    }

    const { candles15m, tradingRange, liquidityPools } = patternData;
    if (!candles15m?.length || !tradingRange) return false;

    const rangeHigh = tradingRange.high;
    const rangeLow = tradingRange.low;
    const equilibrium = tradingRange.equilibrium;

    // Check for EQH/EQL - clean equal highs/lows
    const hasEqh = liquidityPools?.some((p: any) => p.type === 'EQH' && p.priceLevel.eq(rangeHigh)) || false;
    const hasEql = liquidityPools?.some((p: any) => p.type === 'EQL' && p.priceLevel.eq(rangeLow)) || false;

    if (!hasEqh && !hasEql) {
      this.logRejection('No clean EQH/EQL on range boundaries');
      return false;
    }

    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    const lastClose = new Decimal(lastCandle.close);

    let direction: 'LONG' | 'SHORT' | null = null;
    let slLevel: Decimal | null = null;

    // Check for SFP at Range High (bearish Turtle Soup)
    // Wick above Range High, close back inside range
    if (hasEqh && lastHigh.gt(rangeHigh) && lastClose.lt(rangeHigh) && lastClose.gt(rangeLow)) {
      direction = 'SHORT';
      slLevel = lastHigh; // SL at tip of the wick
    }
    // Check for SFP at Range Low (bullish Turtle Soup)
    // Wick below Range Low, close back inside range
    else if (hasEql && lastLow.lt(rangeLow) && lastClose.gt(rangeLow) && lastClose.lt(rangeHigh)) {
      direction = 'LONG';
      slLevel = lastLow; // SL at tip of the wick
    }

    if (!direction) {
      this.logRejection('No SFP candle closing back inside range on EQH/EQL');
      return false;
    }

    // CRITICAL: Entry is IMMEDIATELY at market on candle CLOSE
    // No waiting for pullback, no limit order - MARKET ORDER on close of SFP candle
    const entry = lastClose;

    // SL is at the tip of the wick (the extreme of the sweep)
    const sl = slLevel!;

    // TP is opposite side of range
    const tp = direction === 'LONG' ? rangeHigh : rangeLow;

    // Verify R:R >= 1:3
    const risk = direction === 'LONG' ? entry.minus(sl) : sl.minus(entry);
    const reward = direction === 'LONG' ? tp.minus(entry) : entry.minus(tp);
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3 (risk: ${risk.toFixed(4)}, reward: ${reward.toFixed(4)})`);
      return false;
    }

    // Verify entry is in correct Premium/Discount zone
    // Longs only in Discount (below 0.5), Shorts only in Premium (above 0.5)
    const pdZone = entry.gt(equilibrium) ? 'PREMIUM' : entry.lt(equilibrium) ? 'DISCOUNT' : 'EQUILIBRIUM';
    if (direction === 'LONG' && pdZone !== 'DISCOUNT') {
      this.logRejection('Long entry not in Discount zone');
      return false;
    }
    if (direction === 'SHORT' && pdZone !== 'PREMIUM') {
      this.logRejection('Short entry not in Premium zone');
      return false;
    }

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Turtle Soup: SFP on ${hasEqh ? 'EQH' : 'EQL'} in ${killzone} killzone, immediate market entry on candle close, SL at wick tip, target opposite range boundary`);
    return true;
  }
}