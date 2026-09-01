import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario3_IDM extends BaseScenario {
  constructor() {
    super(3, 'Inducement (IDM)');
  }

  override evaluate(patternData: any): boolean {
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      return false;
    }

    // IDM: Local minimum/maximum that acts as inducement
    // Price sweeps a local extreme (IDM), then tests the REAL OB
    
    const lastCandle = patternData.candles15m[patternData.candles15m.length - 1];
    if (!lastCandle) return false;

    // Check for bearish IDM (local low swept, then bounce to test OB)
    const recentLowSweep = patternData.structures?.find((s: any) => 
      s.direction === 'BULLISH' && s.kind === 'CHOCH' && 
      s.brokenSwing && s.brokenSwing.type === 'LOW'
    );

    if (!recentLowSweep) {
      this.logRejection('No IDM sweep detected');
      return false;
    }

    // The real OB should be BELOW the swept low
    const sweptLow = new Decimal(recentLowSweep.brokenSwing.price);
    const realObs = patternData.zones?.filter((z: any) => 
      z.type === 'OB' && z.direction === 'BULLISH' && 
      z.top.lt(sweptLow) && !z.invalidated
    ) || [];

    if (!realObs.length) {
      this.logRejection('No real OB below swept low');
      return false;
    }

    // Check if price is now testing the real OB
    const realOb = realObs[0];
    const lastClose = new Decimal(patternData.candles15m[patternData.candles15m.length - 1].close);
    const testingOb = lastClose.gte(realOb.bottom) && lastClose.lte(realOb.top);

    if (!testingOb) {
      this.logRejection('Price not testing real OB after IDM sweep');
      return false;
    }

    // Entry at 0.5 of the real OB
    const entry = realObs[0].top.plus(realObs[0].bottom).dividedBy(2);
    const sl = realObs[0].bottom.minus(new Decimal('0.001'));
    const tp = entry.plus(entry.minus(sl).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`IDM: Local low swept + Real OB test at 0.5`);
    return true;
  }
}