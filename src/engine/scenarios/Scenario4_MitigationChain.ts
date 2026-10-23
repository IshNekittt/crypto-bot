import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';

export class Scenario4_MitigationChain extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noValidOb: 0,
    noObTouch: 0,
    noChoch: 0,
    displacement: 0,
    trendFilter: 0,
    premiumDiscount: 0,
    noBosAfterBounce: 0,
    totalEvals: 0
  };

  constructor(config: BotConfig) {
    super(4, 'Mitigation Chain', config);
  }

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noValidOb: 0,
      noObTouch: 0,
      noChoch: 0,
      displacement: 0,
      trendFilter: 0,
      premiumDiscount: 0,
      noBosAfterBounce: 0,
      totalEvals: 0
    };
  }

  /**
   * Check if the OB bounce led to a true BOS (Break of Structure)
   * The OB is only valid if the candle that bounced from it triggered a BOS in the trend direction
   */
  private hasBosAfterBounce(patternData: any, ob: any): boolean {
    const { structures } = patternData;
    if (!structures?.length) return false;

    // Look for BOS in trend direction (BULLISH for long) that occurred AFTER the OB timestamp
    const bosAfterOb = [...structures].reverse().find((s: any) => 
      s.type === 'BOS' && 
      s.direction === 'BULLISH' &&
      s.timestamp > ob.timestamp &&
      s.timestamp <= ob.timestamp + 24 * 60 * 60 * 1000 // within 24H after OB formation
    );

    return !!bosAfterOb;
  }

  protected override evaluateInternal(patternData: any): boolean {
    Scenario4_MitigationChain.rejectionStats.totalEvals++;

    if (this.config.enforceKillzones !== false && (!patternData.currentKillzone || patternData.currentKillzone === 'NONE')) {
      this.logRejection('Not in active killzone');
      Scenario4_MitigationChain.rejectionStats.killzone++;
      return false;
    }

    // Mitigation Chain: Strong trend with OBs being mitigated at 50% (Equilibrium)
    // Each new OB is tested at exactly 50% before continuation
    
    const { candles15m } = patternData;
    if (!candles15m.length) return false;

    // Find the most recent OB in trend direction.
    // NOTE: `!z.mitigated` was removed — `PatternRecognizer` hardcodes
    // `mitigated: false`, so the predicate was a no-op. Re-entry protection is
    // enforced exclusively by `ScenarioRouter.filterMitigatedZones`.
    const trendObs = patternData.zones?.filter((z: any) => 
      z.type === 'OB' && z.direction === 'BULLISH'
    ) || [];

    if (!trendObs.length) {
      this.logRejection('No valid OB in trend direction');
      Scenario4_MitigationChain.rejectionStats.noValidOb++;
      return false;
    }

    // Get the most recent OB
    const latestOb = trendObs[trendObs.length - 1];
    
    // PREMIUM/DISCOUNT FILTER (Fibonacci 0.5)
    // For BULLISH OB (Long): OB must be in DISCOUNT zone (below 0.5)
    const pd = patternData.patternRecognizer.calculatePremiumDiscount(patternData.candles15m);
    if (!pd) {
      this.logRejection('Could not calculate Premium/Discount levels');
      return false;
    }
    
    const obMid = latestOb.top.plus(latestOb.bottom).dividedBy(2);
    
    // BULLISH OB must be in DISCOUNT (below equilibrium)
    if (obMid.gte(pd.equilibrium)) {
      this.logRejection('BULLISH OB not in Discount zone (above 0.5)');
      Scenario4_MitigationChain.rejectionStats.premiumDiscount++;
      return false;
    }
    
    // STRENGTH FILTER: OB must have produced a true BOS after its formation
    // This validates the OB as a "strong" institutional level
    if (!this.hasBosAfterBounce(patternData, latestOb)) {
      this.logRejection('OB did not produce true BOS after formation - weak block');
      Scenario4_MitigationChain.rejectionStats.noBosAfterBounce++;
      return false;
    }
    
    const lastCandle = patternData.candles15m[patternData.candles15m.length - 1];
    if (!lastCandle) return false;

    const lastClose = new Decimal(lastCandle.close);
    const eq = latestOb.top.plus(latestOb.bottom).dividedBy(2);
    
    // CRITICAL: Price must touch EXACTLY 50% (Equilibrium) of OB
    const touched50 = lastClose.eq(latestOb.top.plus(latestOb.bottom).dividedBy(2)) ||
      (new Decimal(lastCandle.low).lte(eq) && new Decimal(lastCandle.high).gte(eq));

    if (!touched50) {
      this.logRejection(`Price has not touched 0.5 (Equilibrium) of OB. Current: ${lastCandle.close}, EQ: ${eq.toFixed(4)}`);
      Scenario4_MitigationChain.rejectionStats.noObTouch++;
      return false;
    }

    // Verify trend structure - need CHoCH in direction of trend (any valid CHoCH)
    const choch = [...(patternData.structures || [])].reverse().find((s: any) => 
      s.type === 'CHOCH' && s.direction === 'BULLISH'
    );
    
    if (!choch) {
      this.logRejection('No 15m CHoCH confirming trend direction');
      Scenario4_MitigationChain.rejectionStats.noChoch++;
      return false;
    }

    // Check displacement on the CHoCH
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('CHoCH displacement < 1.5 ATR');
      Scenario4_MitigationChain.rejectionStats.displacement++;
      return false;
    }

    // FIX: 4H Trend Filter - Only allow longs if 4H structure is BULLISH
    const htfStructures = patternData.structures?.filter((s: any) => 
      (s.timeframe === '240' || s.timeframe === '4H') && 
      (s.type === 'BOS' || s.type === 'CHOCH')
    ) || [];
    
    const hasBullish4h = htfStructures.some((s: any) => s.direction === 'BULLISH');
    const hasBearish4h = htfStructures.some((s: any) => s.direction === 'BEARISH');
    
    // For long entries, 4H trend must be BULLISH (no BEARISH structures)
    if (!hasBullish4h || hasBearish4h) {
      this.logRejection('4H trend not bullish - entry against HTF trend');
      Scenario4_MitigationChain.rejectionStats.trendFilter++;
      return false;
    }

    // Entry at 0.5 of OB
    const entry = patternData.tradingRange?.equilibrium || 
      latestOb.top.plus(latestOb.bottom).dividedBy(2);

    // Use base class calculateLevels with BULLISH direction (Long only)
    const levels = this.calculateLevels(
      entry,
      {
        top: latestOb.top,
        bottom: latestOb.bottom,
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
      top: latestOb.top,
      bottom: latestOb.bottom,
      timeframe: latestOb.timeframe || '15',
      direction: latestOb.direction,
      timestamp: latestOb.timestamp,
    });

    // Set structure details for mitigation tracking (the CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction: choch.direction,
    });

    this.setReason(`Mitigation Chain: OB 0.5 mitigation + BOS validated + Premium/Discount`);
    return true;
  }
}