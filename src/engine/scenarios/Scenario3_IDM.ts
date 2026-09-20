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
      s.direction === 'BULLISH' && s.type === 'CHOCH' && 
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
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    const testingOb = lastHigh.gte(realOb.bottom) && lastLow.lte(realOb.top);

    if (!testingOb) {
      this.logRejection('Price not testing real OB after IDM sweep');
      return false;
    }

    // Entry at 0.5 of the real OB
    const entry = realObs[0].top.plus(realObs[0].bottom).dividedBy(2);

    // Use base class calculateLevels with BULLISH direction (Long only)
    const levels = this.calculateLevels(
      entry,
      {
        top: realObs[0].top,
        bottom: realObs[0].bottom,
        direction: 'BULLISH',
      },
      'BULLISH',
      patternData.atr15m || new Decimal('0.01'),
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // Set zone details for mitigation tracking (the OB we entered from)
    this.setZoneDetails({
      type: 'OB',
      top: realOb.top,
      bottom: realOb.bottom,
      timeframe: '15',
      direction: 'BULLISH',
      timestamp: realOb.timestamp,
    });

    this.setReason(`IDM: Local low swept + Real OB test at 0.5`);
    return true;
  }
}