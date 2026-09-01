import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario2_FVGFill extends BaseScenario {
  constructor() {
    super(2, 'FVG Fill');
  }

  override evaluate(patternData: any): boolean {
    if (!patternData.currentKillzone || patternData.currentKillzone === 'NONE') {
      this.logRejection('Not in active killzone');
      return false;
    }

    // Find HTF FVG (4H or Daily)
    const htfFvgs = patternData.zones?.filter((z: any) => 
      z.type === 'FVG' && (z.timeframe === '240' || z.timeframe === 'D')
    ) || [];

    if (!htfFvgs.length) {
      this.logRejection('No HTF FVG found');
      return false;
    }

    // Get the most recent HTF FVG
    const htfFvg = htfFvgs[0];
    const lastCandle = patternData.candles15m[patternData.candles15m.length - 1];
    if (!lastCandle) return false;

    // CRITICAL: 0.5 RULE - Price must touch EXACTLY 50% (Equilibrium) of FVG
    // Not "near" or "close" - EXACTLY 0.5 level
    const lastClose = new Decimal(lastCandle.close);
    const eq = htfFvg.top.plus(htfFvg.bottom).dividedBy(2);
    
    // Check if price touched EXACTLY the 0.5 level (within tick precision)
    const touched50 = lastClose.eq(eq) || 
      (new Decimal(lastCandle.low).lte(eq) && new Decimal(lastCandle.high).gte(eq));

    if (!touched50) {
      this.logRejection(`Price has not touched 0.5 (Equilibrium) of HTF FVG. Current: ${lastClose.toFixed(4)}, EQ: ${eq.toFixed(4)}`);
      return false;
    }

    // Check for 15m CHoCH with Displacement validation
    const choch = patternData.structures?.find((s: any) => s.kind === 'CHOCH' && s.direction === 'BULLISH');
    if (!choch) {
      this.logRejection('No 15m CHoCH after FVG touch');
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR');
      return false;
    }

    // Entry at 0.5 of HTF FVG
    const entry = htfFvg.top.plus(htfFvg.bottom).dividedBy(2);
    const sl = htfFvg.bottom.minus(new Decimal('0.001'));
    const tp = entry.plus(entry.minus(sl).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`FVG Fill: HTF FVG 0.5 touch + 15m CHoCH`);
    return true;
  }
}