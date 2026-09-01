import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario1_HTFContinuation extends BaseScenario {
  constructor() {
    super(1, 'HTF Continuation');
  }

  override evaluate(patternData: any): boolean {
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      return false;
    }

    const { zones } = patternData;

    // Find 4H Order Block
    const htfObs = zones.filter((z: any) => z.type === 'OB' && z.timeframe === '240');
    if (!htfObs.length) {
      this.logRejection('No valid 4H Order Block found');
      return false;
    }

    const latestObs = htfObs.filter((ob: any) => !ob.mitigated);
    if (!latestObs.length) {
      this.logRejection('All 4H OBs mitigated');
      return false;
    }

    const latestOb = latestObs[0];
    const lastCandle = patternData.candles15m[patternData.candles15m.length - 1];
    if (!lastCandle) {
      this.logRejection('No 15m candle available');
      return false;
    }

    // Check if price touched 4H OB
    const lastClose = new Decimal(lastCandle.close);
    const touched = lastClose.gte(latestOb.bottom) && lastClose.lte(latestOb.top);
    if (!touched) {
      this.logRejection('Price has not touched 4H OB zone');
      return false;
    }

    // Check for 15m CHoCH with Displacement validation
    const structures15m = patternData.structures?.filter((s: any) => s.direction === 'BULLISH') || [];
    const choch = structures15m.find((s: any) => s.kind === 'CHOCH');
    if (!choch) {
      this.logRejection('No 15m CHoCH found after OB touch');
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR');
      return false;
    }

    // Check for fresh 15m FVG after CHoCH
    const freshFvgs = patternData.zones?.filter((z: any) => 
      z.type === 'FVG' && z.direction === 'BULLISH' && z.timeframe === '15' && z.index >= choch.candleIndex
    ) || [];
    
    const fvg = freshFvgs[0];
    if (!fvg) {
      this.logRejection('No 15m FVG found after CHoCH');
      return false;
    }

    // Entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const atr15m = 0.01; // TODO: get from patternData
    const sl = new Decimal(choch.price).minus(new Decimal(atr15m).mul(2));
    const tp = entry.plus(entry.minus(sl).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`HTF Continuation: 4H OB touch + 15m CHoCH + 15m FVG entry`);
    return true;
  }
}