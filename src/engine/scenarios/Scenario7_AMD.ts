import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';

export class Scenario7_AMD extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noAsianRange: 0,
    asianRangeTooWide: 0,
    noSweep: 0,
    noChoch: 0,
    displacement: 0,
    noFvg: 0,
    totalEvals: 0
  };

  constructor(config: BotConfig) {
    super(7, 'AMD (Accumulation-Manipulation-Distribution)', config);
  }

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noAsianRange: 0,
      asianRangeTooWide: 0,
      noSweep: 0,
      noChoch: 0,
      displacement: 0,
      noFvg: 0,
      totalEvals: 0
    };
  }

  override evaluate(patternData: any): boolean {
    Scenario7_AMD.rejectionStats.totalEvals++;

    // CRITICAL: AMD works at session transitions
    // Accumulation: Asian session (20:00-24:00 NY) 
    // Manipulation: London open (02:00-05:00 NY) sweep of Asian Low
    // Distribution: Reversal and move to Asian High
    const currentKillzone = patternData.currentKillzone;
    if (!currentKillzone || (currentKillzone !== 'LONDON' && currentKillzone !== 'NY')) {
      this.logRejection('AMD requires London or NY killzone (Manipulation/Distribution phase)');
      Scenario7_AMD.rejectionStats.killzone++;
      return false;
    }

    const { sessionRanges, candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !sessionRanges?.length) return false;

    // Find Asian Range (most recent)
    const asianRange = [...sessionRanges].reverse().find((r: any) => r.name === 'ASIAN');
    if (!asianRange) {
      this.logRejection('No Asian Range detected');
      Scenario7_AMD.rejectionStats.noAsianRange++;
      return false;
    }

    const asianHigh = asianRange.high;
    const asianLow = asianRange.low;

    // FILTER: Asian Range must be Accumulation (tight range), not trending
    // Height must be < 3.0 * ATR(4H) - increased from 1.5 for crypto volatility
    const atr4h = patternData.atr4h || new Decimal('0.01');
    const asianRangeHeight = asianHigh.minus(asianLow);
    const maxAllowedHeight = atr4h.mul(3.0);
    if (asianRangeHeight.gt(maxAllowedHeight)) {
      this.logRejection(`Asian Range too wide for accumulation: ${asianRangeHeight.toFixed(2)} > 3.0*ATR4H (${maxAllowedHeight.toFixed(2)})`);
      Scenario7_AMD.rejectionStats.asianRangeTooWide++;
      return false;
    }

    // Check for Asian Low sweep in last 8 candles (sweep candle + reaction candles)
    // SFP: wick below Asian Low, close back above Asian Low
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const sweepTolerance = atr15m.mul(2.0); // 2 ATR tolerance for wick penetration (more permissive)
    
    let sweepCandle: any = null;
    
    // Check last 8 candles for sweep (sweep could be 1-7 candles ago, CHoCH follows)
    const checkWindow = Math.min(8, candles15m.length);
    for (let i = candles15m.length - checkWindow; i < candles15m.length; i++) {
      const c = candles15m[i];
      const low = new Decimal(c.low);
      const close = new Decimal(c.close);
      
      // Sweep: wick pierces below Asian Low (within tolerance), close back above Asian Low (with tolerance)
      const wickedBelow = low.lt(asianLow.plus(sweepTolerance));
      const closedAbove = close.gt(asianLow.minus(sweepTolerance)); // Allow close within tolerance of asianLow
      
      if (wickedBelow && closedAbove) {
        sweepCandle = c;
        break;
      }
    }

    if (!sweepCandle) {
      this.logRejection('Asian Low not swept in last 8 candles (no SFP manipulation)');
      Scenario7_AMD.rejectionStats.noSweep++;
      return false;
    }

    // CRITICAL: Verify aggressive CHoCH UP after the sweep candle
    // CHoCH can form within 8H window after sweep (price reaction time)
    const sweepTime = sweepCandle.timestamp;
    const recentChoch = [...(structures || [])].reverse().find((s: any) => 
      s.type === 'CHOCH' && 
      s.direction === 'BULLISH' &&
      s.timestamp > sweepTime && // CHoCH MUST be AFTER sweep
      s.timestamp <= sweepTime + 8 * 60 * 60 * 1000 // within 8H after sweep
    );

    if (!recentChoch) {
      this.logRejection('No aggressive BULLISH CHoCH after Asian Low sweep');
      Scenario7_AMD.rejectionStats.noChoch++;
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(recentChoch, 1.5)) {
      this.logRejection('CHoCH after Asian Low sweep displacement < 1.5 ATR');
      Scenario7_AMD.rejectionStats.displacement++;
      return false;
    }

    // Check for 15m FVG in bullish direction after CHoCH
    // Allow FVG to form within 8H after CHoCH
    const fvgsAfterChoch = zones?.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === 'BULLISH' && 
      z.timeframe === '15' &&
      z.timestamp >= recentChoch.timestamp &&
      z.timestamp <= recentChoch.timestamp + 8 * 60 * 60 * 1000 // within 8H after CHoCH
    ) || [];

    const fvg = fvgsAfterChoch[fvgsAfterChoch.length - 1];
    if (!fvg) {
      this.logRejection('No 15m bullish FVG after CHoCH');
      Scenario7_AMD.rejectionStats.noFvg++;
      return false;
    }

    // Entry at 0.5 (Equilibrium) of FVG
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);

    // Use centralized calculateLevels for safe SL/TP geometry
    const levels = this.calculateLevels(
      entry,
      { top: fvg.top, bottom: fvg.bottom, direction: 'BULLISH' },
      'BULLISH',
      atr15m
    );

    // Verify R:R >= 1:3 (calculateLevels already uses 1:3 RR)
    const risk = levels.entry.minus(levels.stopLoss);
    const reward = levels.takeProfit.minus(levels.entry);
    if (reward.div(risk).lt(3)) {
      this.logRejection(`R:R < 1:3 (risk: ${risk.toFixed(4)}, reward: ${reward.toFixed(4)})`);
      return false;
    }

    // Override TP to target Asian High if it provides better R:R
    if (asianHigh.gt(levels.takeProfit)) {
      const customReward = asianHigh.minus(levels.entry);
      if (customReward.div(risk).gte(3)) {
        levels.takeProfit = asianHigh;
      }
    }

    this.setLevels(levels);

    // Set zone details for mitigation tracking (the FVG we entered from)
    this.setZoneDetails({
      type: 'FVG',
      top: fvg.top,
      bottom: fvg.bottom,
      timeframe: '15',
      direction: 'BULLISH',
      timestamp: fvg.timestamp,
    });

    // Set structure details for mitigation tracking (the CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: recentChoch.timestamp,
      price: recentChoch.price,
      direction: 'BULLISH',
    });

    this.setReason(`AMD: Asian Low swept in ${currentKillzone} killzone (Asian Range height ${asianRangeHeight.toFixed(2)} < 3.0*ATR4H) + CHoCH + FVG 0.5 entry, target Asian High`);
    return true;
  }
}