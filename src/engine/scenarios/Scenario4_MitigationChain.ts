import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario4_MitigationChain extends BaseScenario {
  constructor() {
    super(4, 'Mitigation Chain');
  }

  override evaluate(patternData: any): boolean {
    if (!patternData.currentKillzone || patternData.currentKillzone === 'NONE') {
      this.logRejection('Not in active killzone');
      return false;
    }

    // Mitigation Chain: Strong trend with OBs being mitigated at 50% (Equilibrium)
    // Each new OB is tested at exactly 50% before continuation
    
    const { candles15m } = patternData;
    if (!candles15m.length) return false;

    // Find the most recent unmitigated OB in trend direction
    const trendObs = patternData.zones?.filter((z: any) => 
      z.type === 'OB' && z.direction === 'BULLISH' && !z.mitigated
    ) || [];

    if (!trendObs.length) {
      this.logRejection('No valid OB in trend direction');
      return false;
    }

    // Get the most recent OB
    const latestOb = trendObs[0];
    
    // Check if OB is being mitigated at EXACTLY 50% (Equilibrium)
    const lastCandle = patternData.candles15m[patternData.candles15m.length - 1];
    if (!lastCandle) return false;

    const lastClose = new Decimal(lastCandle.close);
    const eq = latestOb.top.plus(latestOb.bottom).dividedBy(2);
    
    // CRITICAL: Price must touch EXACTLY 50% (Equilibrium) of OB
    const touched50 = lastClose.eq(latestOb.top.plus(latestOb.bottom).dividedBy(2)) ||
      (new Decimal(lastCandle.low).lte(eq) && new Decimal(lastCandle.high).gte(eq));

    if (!touched50) {
      this.logRejection(`Price has not touched 0.5 (Equilibrium) of OB. Current: ${lastCandle.close}, EQ: ${eq.toFixed(4)}`);
      return false;
    }

    // Verify trend structure - need CHoCH in direction of trend
    const choch = patternData.structures?.find((s: any) => 
      s.kind === 'CHOCH' && s.direction === 'BULLISH'
    );
    
    if (!choch) {
      this.logRejection('No CHoCH confirming trend direction');
      return false;
    }

    // Check displacement on the CHoCH
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('CHoCH displacement < 1.5 ATR');
      return false;
    }

    // Entry at 0.5 of OB
    const entry = patternData.tradingRange?.equilibrium || 
      trendObs[0].top.plus(trendObs[0].bottom).dividedBy(2);
    
    const sl = trendObs[0].bottom.minus(new Decimal('0.001'));
    const tp = entry.plus(entry.minus(sl).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Mitigation Chain: OB 0.5 mitigation + CHoCH continuation`);
    return true;
  }
}