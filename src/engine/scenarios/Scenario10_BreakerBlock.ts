import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario10_BreakerBlock extends BaseScenario {
  constructor() {
    super(10, 'Breaker Block Entry');
  }

  override evaluate(patternData: any): boolean {
    // Breaker Block can work in any killzone, but prefer active sessions
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      return false;
    }

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) return false;

    // Find Breaker Block: an OB that was impulsively broken through (close beyond OB)
    // The broken OB becomes a Breaker Block - price should return to test it
    
    // Look for a structure break (BOS/CHoCH) that broke through an OB
    const breaksThroughOb = structures.filter((s: any) => {
      const brokenObs = zones.filter((z: any) => 
        z.type === 'OB' && 
        z.direction === (s.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH') && // opposite direction OB
        s.price.gt(z.top) && s.price.gt(z.bottom) // for bullish break, price broke above bearish OB
      );
      return brokenObs.length > 0;
    });

    if (!breaksThroughOb.length) {
      this.logRejection('No OB broken by impulsive structure break');
      return false;
    }

    const breakEvent = breaksThroughOb[0];
    const brokenObDirection = breakEvent.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    
    // Find the OB that was broken
    const brokenOb = zones.find((z: any) => 
      z.type === 'OB' && 
      z.direction === brokenObDirection &&
      breakEvent.price.gt(z.top) // for bullish break, broke above bearish OB top
    );

    if (!brokenOb) {
      this.logRejection('Broken OB not found');
      return false;
    }

    // Check for MANDATORY FVG near the breaker (displacement confirmation)
    const nearbyFvgs = zones.filter((z: any) => 
      z.type === 'FVG' && 
      z.direction === breakEvent.direction &&
      z.timestamp >= breakEvent.timestamp - 15 * 60 * 1000 &&
      z.timestamp <= breakEvent.timestamp + 15 * 60 * 1000
    );

    if (!nearbyFvgs.length) {
      this.logRejection('No FVG near Breaker Block (displacement required)');
      return false;
    }

    // Wait for price to return and test the Breaker Block (mirror test)
    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    const lastClose = new Decimal(lastCandle.close);
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);

    // Breaker Block zone = the original OB zone
    const breakerTop = brokenOb.top;
    const breakerBottom = brokenOb.bottom;

    // Price should test the breaker zone
    const testingBreaker = breakEvent.direction === 'BULLISH'
      ? lastLow.lte(breakerTop) && lastClose.gte(breakerBottom) // test from above for bullish breaker
      : lastHigh.gte(breakerBottom) && lastClose.lte(breakerTop); // test from below for bearish breaker

    if (!testingBreaker) {
      this.logRejection('Price not testing Breaker Block zone');
      return false;
    }

    // Verify structure break was valid (body close with displacement)
    if (!this.isValidBodyClose(breakEvent)) {
      this.logRejection('Original break not validated (wick only)');
      return false;
    }
    if (!this.isValidDisplacement(breakEvent, 1.5)) {
      this.logRejection('Original break displacement < 1.5 ATR');
      return false;
    }

    // Entry at 0.5 (Equilibrium) of Breaker Block
    const entry = breakerTop.plus(breakerBottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const sl = breakEvent.direction === 'BULLISH'
      ? breakerBottom.minus(atr15m.mul(0.5))
      : breakerTop.plus(atr15m.mul(0.5));
    const tp = breakEvent.direction === 'BULLISH'
      ? entry.plus(entry.minus(sl).mul(3))
      : entry.minus(sl.minus(entry).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Breaker Block: ${brokenObDirection} OB broken by ${breakEvent.direction} impulsive break + FVG + mirror test at 0.5`);
    return true;
  }
}