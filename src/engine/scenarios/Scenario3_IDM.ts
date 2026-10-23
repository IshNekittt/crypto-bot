import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';

export class Scenario3_IDM extends BaseScenario {
  constructor(config: BotConfig) {
    super(3, 'IDM', config);
  }

  protected override evaluateInternal(patternData: any): boolean {
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      return false;
    }

    // IDM: Local minimum/maximum that acts as inducement
    // Price sweeps a local extreme (IDM), then tests the REAL OB
    
    const lastCandle = patternData.candles15m?.[patternData.candles15m.length - 1];
    if (!lastCandle) return false;

    // IDM: the inducement is the freshest 15m BULLISH CHoCH — the structure that
    // broke the local swing and signalled the reversal. NOTE: `brokenSwing` is a
    // legacy field emitted only by the deprecated `smc.ts` detector; production
    // structures never carry it, which made this scenario permanently dead.
    const recentLowSweep = [...(patternData.structures || [])].reverse().find((s: any) => 
      s.direction === 'BULLISH' && s.type === 'CHOCH' && s.timeframe === '15'
    );

    if (!recentLowSweep) {
      this.logRejection('No IDM sweep detected');
      return false;
    }

    // The real OB should be BELOW the swept low
    const sweptLow = new Decimal(recentLowSweep.price);
    const realObs = patternData.zones?.filter((z: any) => 
      z.type === 'OB' && z.direction === 'BULLISH' && z.timeframe === '15' &&
      z.top.lt(sweptLow) && !z.mitigated
    ) || [];

    if (!realObs.length) {
      this.logRejection('No real OB below swept low');
      return false;
    }

    // Check if price is now testing the real OB
    const realOb = realObs[realObs.length - 1];
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    const testingOb = lastHigh.gte(realOb.bottom) && lastLow.lte(realOb.top);

    if (!testingOb) {
      this.logRejection('Price not testing real OB after IDM sweep');
      return false;
    }

    // Entry at 0.5 of the real OB
    const entry = realOb.top.plus(realOb.bottom).dividedBy(2);

    // Use base class calculateLevels with BULLISH direction (Long only)
    const levels = this.calculateLevels(
      entry,
      {
        top: realOb.top,
        bottom: realOb.bottom,
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

    // Set structure details for mitigation tracking (the sweep CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: recentLowSweep.timestamp,
      price: recentLowSweep.price,
      direction: 'BULLISH',
    });

    this.setReason(`IDM: Local low swept + Real OB test at 0.5`);
    return true;
  }
}