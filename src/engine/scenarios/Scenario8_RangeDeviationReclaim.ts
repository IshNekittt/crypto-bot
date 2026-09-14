import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

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

  constructor() {
    super(8, 'Range Deviation & Reclaim');
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
    const equilibrium = tradingRange.equilibrium;

    // Check for deviation and reclaim in last 6 candles
    // Deviation: price wicked above Range High
    // Reclaim: price closed back inside range
    let deviationCandle: any = null;
    let reclaimCandle: any = null;
    
    const checkWindow = Math.min(6, candles15m.length);
    for (let i = candles15m.length - checkWindow; i < candles15m.length; i++) {
      const c = candles15m[i];
      const high = new Decimal(c.high);
      const close = new Decimal(c.close);
      
      // Deviation: wicked above range high
      if (!deviationCandle && high.gt(rangeHigh)) {
        deviationCandle = c;
      }
      // Reclaim: closed back inside range (after deviation)
      // Allow same-candle reclaim (wick above, close inside = SFP pattern)
      if (deviationCandle && c.timestamp >= deviationCandle.timestamp && close.lt(rangeHigh) && close.gt(rangeLow)) {
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

    // Look for bearish structure break (CHoCH down) after reclaim
    // CHoCH can form within 8H window after reclaim
    const reclaimTime = reclaimCandle.timestamp;
    const bearishChoch = structures?.find((s: any) => 
      s.type === 'CHOCH' && s.direction === 'BEARISH' &&
      s.timestamp > reclaimTime && // CHoCH MUST be AFTER reclaim
      s.timestamp <= reclaimTime + 8 * 60 * 60 * 1000 // within 8H after reclaim
    );

    if (!bearishChoch) {
      this.logRejection('No bearish CHoCH on reclaim');
      Scenario8_RangeDeviationReclaim.rejectionStats.noChoch++;
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(bearishChoch, 1.5)) {
      this.logRejection('CHoCH on reclaim displacement < 1.5 ATR');
      Scenario8_RangeDeviationReclaim.rejectionStats.displacement++;
      return false;
    }

    // Check for bearish FVG after CHoCH
    // Allow FVG to form within 8H after CHoCH
    const fvgsAfterChoch = patternData.zones?.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === 'BEARISH' && 
      z.timeframe === '15' &&
      z.timestamp >= bearishChoch.timestamp &&
      z.timestamp <= bearishChoch.timestamp + 8 * 60 * 60 * 1000 // within 8H after CHoCH
    ) || [];

    const fvg = fvgsAfterChoch[0];
    if (!fvg) {
      this.logRejection('No bearish 15m FVG after CHoCH');
      Scenario8_RangeDeviationReclaim.rejectionStats.noFvg++;
      return false;
    }

    // SHORT entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);

    // Use base class calculateLevels with BEARISH direction (Short only)
    const levels = this.calculateLevels(
      entry,
      {
        top: fvg.top,
        bottom: fvg.bottom,
        direction: 'BEARISH',
      },
      'BEARISH',
      patternData.atr15m || new Decimal('0.01'),
    );

    // Verify R:R >= 1:3
    const risk = levels.stopLoss.minus(entry);
    const reward = entry.minus(levels.takeProfit);
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3`);
      Scenario8_RangeDeviationReclaim.rejectionStats.rr++;
      return false;
    }

    this.setLevels({
      entry: levels.entry.toFixed(2),
      stopLoss: levels.stopLoss.toFixed(2),
      takeProfit: levels.takeProfit.toFixed(2),
    });

    // Set zone details for mitigation tracking (the FVG we entered from)
    this.setZoneDetails({
      type: 'FVG',
      top: fvg.top,
      bottom: fvg.bottom,
      timeframe: '15',
      direction: 'BEARISH',
      timestamp: fvg.timestamp,
    });

    this.setReason(`Range Deviation & Reclaim: RH deviated + reclaim + bearish CHoCH + FVG 0.5 entry, target: ${equilibrium.toFixed(2)} / ${rangeLow.toFixed(2)}`);
    return true;
  }
}