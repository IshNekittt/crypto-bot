import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario7_AMD extends BaseScenario {
  constructor() {
    super(7, 'AMD (Accumulation-Manipulation-Distribution)');
  }

  override evaluate(patternData: any): boolean {
    // CRITICAL: AMD works at session transitions
    // Accumulation: Asian session (00:00-06:00 NY) 
    // Manipulation: London open (02:00-05:00 NY) sweep of Asian Low
    // Distribution: Reversal and move to Asian High
    const currentKillzone = patternData.currentKillzone;
    if (!currentKillzone || (currentKillzone !== 'LONDON' && currentKillzone !== 'NY')) {
      this.logRejection('AMD requires London or NY killzone (Manipulation/Distribution phase)');
      return false;
    }

    const { sessionRanges, candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !sessionRanges?.length) return false;

    // Find Asian Range
    const asianRange = sessionRanges.find((r: any) => r.name === 'ASIAN');
    if (!asianRange) {
      this.logRejection('No Asian Range detected');
      return false;
    }

    const asianHigh = asianRange.high;
    const asianLow = asianRange.low;

    // Check if price is currently testing/has swept Asian Low (Manipulation phase)
    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    const lastLow = new Decimal(lastCandle.low);
    const lastClose = new Decimal(lastCandle.close);

    // Manipulation: Wick below Asian Low, close back inside (SFP)
    const sweptAsianLow = lastLow.lt(asianLow) && lastClose.gt(asianLow);

    if (!sweptAsianLow) {
      this.logRejection('Asian Low not swept (no manipulation detected)');
      return false;
    }

    // CRITICAL: Verify aggressive CHoCH UP after Asian Low sweep
    // Must be a BULLISH CHoCH immediately after the sweep
    const recentChoch = structures?.find((s: any) => 
      s.kind === 'CHOCH' && 
      s.direction === 'BULLISH' &&
      s.timestamp >= lastCandle.timestamp - 15 * 60 * 1000
    );

    if (!recentChoch) {
      this.logRejection('No aggressive BULLISH CHoCH after Asian Low sweep');
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(recentChoch, 1.5)) {
      this.logRejection('CHoCH after Asian Low sweep displacement < 1.5 ATR');
      return false;
    }

    // Check for fresh 15m FVG in bullish direction after CHoCH
    const freshFvgs = zones?.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === 'BULLISH' && 
      z.timeframe === '15' &&
      z.timestamp >= recentChoch.timestamp
    ) || [];

    const fvg = freshFvgs[0];
    if (!fvg) {
      this.logRejection('No 15m bullish FVG after CHoCH');
      return false;
    }

    // Entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const sl = fvg.bottom.minus(atr15m.mul(0.5));
    const tp = asianHigh; // Target: Asian High

    // Verify R:R >= 1:3
    const risk = entry.minus(sl);
    const reward = tp.minus(entry);
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3 (risk: ${risk.toFixed(4)}, reward: ${reward.toFixed(4)})`);
      return false;
    }

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`AMD: Asian Low swept in ${currentKillzone} killzone + CHoCH + FVG 0.5 entry, target Asian High`);
    return true;
  }
}