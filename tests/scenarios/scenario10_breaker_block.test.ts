import { Scenario10_BreakerBlock } from '../../src/engine/scenarios/Scenario10_BreakerBlock';
import { Decimal } from 'decimal.js';

describe('Scenario10: Breaker Block Entry', () => {
  let scenario: Scenario10_BreakerBlock;

  beforeEach(() => {
    scenario = new Scenario10_BreakerBlock();
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(103.5);
      const zone = { top: new Decimal(107), bottom: new Decimal(105), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr, new Decimal(2));
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(96.5);
      const zone = { top: new Decimal(96), bottom: new Decimal(94), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr, new Decimal(2));
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(103.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(105), bottom: new Decimal(107), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr, new Decimal(2));
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(96.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(94), bottom: new Decimal(96), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr, new Decimal(2));
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});