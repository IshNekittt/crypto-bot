import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario8_RangeDeviationReclaim extends BaseScenario {
  constructor() {
    super(8, 'Range Deviation & Reclaim');
  }

  override evaluate(patternData: any): boolean {
    // CRITICAL: Killzone check - only London/NY
    const killzone = patternData.currentKillzone;
    if (!killzone || (killzone !== 'LONDON' && killzone !== 'NY')) {
      this.logRejection('Range Deviation requires London or NY killzone');
      return false;
    }

    const { candles15m, tradingRange, structures } = patternData;
    if (!candles15m?.length || !tradingRange) return false;

    const rangeHigh = tradingRange.high;
    const rangeLow = tradingRange.low;
    const equilibrium = tradingRange.equilibrium;

    // Check if there was a deviation above Range High
    const lastCandle = candles15m[candles15m.length - 1];
    const prevCandle = candles15m[candles15m.length - 2];
    if (!lastCandle || !prevCandle) return false;

    const lastHigh = new Decimal(lastCandle.high);
    const lastClose = new Decimal(lastCandle.close);
    const prevClose = new Decimal(prevCandle.close);

    // Deviation: price wicked above Range High
    const deviatedUp = lastHigh.gt(rangeHigh);
    
    // Reclaim: price closed back INSIDE the range (below Range High)
    const reclaimed = lastClose.lt(rangeHigh) && prevClose.gte(rangeHigh);

    // Alternative: check if range was marked as deviated and now reclaimed
    const wasDeviated = tradingRange.isDeviated;
    const nowReclaimed = lastClose.lt(rangeHigh) && lastClose.gt(rangeLow);

    if (!deviatedUp && !wasDeviated) {
      this.logRejection('No deviation above Range High detected');
      return false;
    }

    if (!reclaimed && !nowReclaimed) {
      this.logRejection('Price has not reclaimed back into range');
      return false;
    }

    // Look for bearish structure break (CHoCH down) on reclaim
    const bearishChoch = structures?.find((s: any) => 
      s.kind === 'CHOCH' && s.direction === 'BEARISH'
    );

    if (!bearishChoch) {
      this.logRejection('No bearish CHoCH on reclaim');
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(bearishChoch, 1.5)) {
      this.logRejection('CHoCH on reclaim displacement < 1.5 ATR');
      return false;
    }

    // Check for fresh bearish FVG after CHoCH
    const freshFvgs = patternData.zones?.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === 'BEARISH' && 
      z.timeframe === '15' &&
      z.timestamp >= bearishChoch.timestamp
    ) || [];

    const fvg = freshFvgs[0];
    if (!fvg) {
      this.logRejection('No bearish 15m FVG after CHoCH');
      return false;
    }

    // SHORT entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const sl = fvg.top.plus(atr15m.mul(0.5));
    // For SHORT: TP = Entry - (SL - Entry) * 3 (target below entry)
    const tp = entry.minus(sl.minus(entry).mul(3));

    // Verify R:R >= 1:3
    const risk = sl.minus(entry);
    const reward = entry.minus(tp);
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3`);
      return false;
    }

    // First target: 0.5 Range (equilibrium), Second target: Range Low
    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Range Deviation & Reclaim: RH deviated + reclaim + bearish CHoCH + FVG 0.5 entry, target: ${equilibrium.toFixed(2)} / ${rangeLow.toFixed(2)}`);
    return true;
  }
}