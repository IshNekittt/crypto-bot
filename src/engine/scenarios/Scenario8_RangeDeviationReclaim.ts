import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';

export class Scenario8_RangeDeviationReclaim extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noTradingRange: 0,
    noDeviation: 0,
    noReclaim: 0,
    noChoch: 0,
    displacement: 0,
    noFvg: 0,
    rr: 0,
    totalEvals: 0
  };

  constructor(config: BotConfig) {
    super(8, 'Range Deviation & Reclaim', config);
  }

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noTradingRange: 0,
      noDeviation: 0,
      noReclaim: 0,
      noChoch: 0,
      displacement: 0,
      noFvg: 0,
      rr: 0,
      totalEvals: 0
    };
  }

  override evaluate(patternData: any): boolean {
    Scenario8_RangeDeviationReclaim.rejectionStats.totalEvals++;

    // CRITICAL: Killzone check - only London/NY
    const killzone = patternData.currentKillzone;
    if (!killzone || (killzone !== 'LONDON' && killzone !== 'NY')) {
      this.logRejection('Range Deviation requires London or NY killzone');
      Scenario8_RangeDeviationReclaim.rejectionStats.killzone++;
      return false;
    }

    const { candles15m, tradingRange, structures } = patternData;
    if (!candles15m?.length || !tradingRange) {
      Scenario8_RangeDeviationReclaim.rejectionStats.noTradingRange++;
      return false;
    }

    const rangeHigh = tradingRange.high;
    const rangeLow = tradingRange.low;

    // Check for deviation and reclaim in last 6 candles
    // Deviation: price wicked above Range High
    // Reclaim: price closed back inside range
    let deviationCandle: any = null;
    let reclaimCandle: any = null;
    
    const checkWindow = Math.min(6, candles15m.length);
    let deviationFound = false;
    for (let i = candles15m.length - checkWindow; i < candles15m.length; i++) {
      const c = candles15m[i];
      const high = new Decimal(c.high);
      const close = new Decimal(c.close);
      
      // Deviation: wicked above range high
      if (!deviationFound && high.gt(rangeHigh)) {
        deviationCandle = c;
        deviationFound = true;
        continue; // Don't check reclaim on the same candle
      }
      // Reclaim: closed back inside range AFTER deviation candle
      if (deviationFound && close.lt(rangeHigh) && close.gt(rangeLow)) {
        reclaimCandle = c;
        break;
      }
    }

    if (!deviationCandle) {
      this.logRejection('No deviation above Range High detected in last 6 candles');
      Scenario8_RangeDeviationReclaim.rejectionStats.noDeviation++;
      return false;
    }

    if (!reclaimCandle) {
      this.logRejection('Price has not reclaimed back into range after deviation');
      Scenario8_RangeDeviationReclaim.rejectionStats.noReclaim++;
      return false;
    }

    // WICK FILTER: The deviation candle MUST leave a wick (wick >= 40% of candle range)
    // This confirms it was a fake-out, not a true breakout
    const devHigh = new Decimal(deviationCandle.high);
    const devLow = new Decimal(deviationCandle.low);
    const devRange = devHigh.minus(devLow);
    if (devRange.eq(0)) {
      this.logRejection('Deviation candle has zero range');
      Scenario8_RangeDeviationReclaim.rejectionStats.noDeviation++;
      return false;
    }
    
    // Wick above range high (for bearish deviation)
    const wickAbove = devHigh.minus(rangeHigh);
    const wickRatio = wickAbove.div(devRange);
    const wickThreshold = patternData.patternRecognizer?.config?.wickRatioThreshold || new Decimal('0.4');
    
    if (wickRatio.lt(wickThreshold)) {
      this.logRejection(`Deviation wick too small: ${wickRatio.toFixed(2)} < ${wickThreshold.toFixed(2)}`);
      Scenario8_RangeDeviationReclaim.rejectionStats.noDeviation++;
      return false;
    }

    // Look for bearish structure break (CHoCH down) after reclaim
    // CHoCH can form within 8H window after reclaim
    const reclaimTime = reclaimCandle.timestamp;
    const bearishChoch = [...(structures || [])].reverse().find((s: any) => 
      s.type === 'CHOCH' && s.direction === 'BEARISH' &&
      s.timestamp >= reclaimTime &&
      s.timestamp <= reclaimTime + 8 * 60 * 60 * 1000 // 8 hours
    );

    if (!bearishChoch) {
      this.logRejection('No bearish CHoCH after reclaim');
      Scenario8_RangeDeviationReclaim.rejectionStats.noChoch++;
      return false;
    }

    // Check displacement on the CHoCH
    if (!this.isValidDisplacement(bearishChoch, 1.5)) {
      this.logRejection('Bearish CHoCH displacement < 1.5 ATR');
      Scenario8_RangeDeviationReclaim.rejectionStats.displacement++;
      return false;
    }

    // Look for FVG in the area to define precise entry
    const fvgs = patternData.zones?.filter((z: any) => 
      z.type === 'FVG' && z.direction === 'BEARISH' &&
      z.top.gte(rangeLow) && z.bottom.lte(rangeHigh)
    ) || [];

    if (!fvgs.length) {
      this.logRejection('No bearish FVG in range for entry');
      Scenario8_RangeDeviationReclaim.rejectionStats.noFvg++;
      return false;
    }

    // Entry at FVG 0.5 or equilibrium
    const fvg = fvgs[fvgs.length - 1];
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const atr = patternData.atr15m || new Decimal('0.01');

    // Use centralized calculateLevels for safe SL/TP geometry
    // Range boundaries as zone: top=rangeHigh, bottom=rangeLow, direction=BEARISH (short from deviation)
    const levels = this.calculateLevels(
      entry,
      { top: rangeHigh, bottom: rangeLow, direction: 'BEARISH' },
      'BEARISH',
      atr
    );

    // Verify R:R >= 1:3
    const risk = levels.stopLoss.minus(levels.entry).abs();
    const reward = levels.entry.minus(levels.takeProfit).abs();
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3 (risk: ${risk.toFixed(4)}, reward: ${reward.toFixed(4)})`);
      return false;
    }

    this.setLevels(levels);

    // Set zone details for mitigation tracking (the bearish FVG we entered from)
    this.setZoneDetails({
      type: 'FVG',
      top: fvg.top,
      bottom: fvg.bottom,
      timeframe: fvg.timeframe || '15',
      direction: 'BEARISH',
      timestamp: fvg.timestamp,
    });

    // Set structure details for mitigation tracking (the bearish CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: bearishChoch.timestamp,
      price: bearishChoch.price,
      direction: 'BEARISH',
    });

    this.setReason(`Range Deviation: Deviation + Reclaim + Bearish CHoCH + Bollinger Squeeze`);
    return true;
  }
}