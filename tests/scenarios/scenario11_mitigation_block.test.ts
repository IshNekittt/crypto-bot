import { Scenario11_MitigationBlock } from '../../src/engine/scenarios/Scenario11_MitigationBlock';
import { Decimal } from 'decimal.js';

describe('Scenario11: Mitigation Block', () => {
  let scenario: Scenario11_MitigationBlock;

  beforeEach(() => {
    scenario = new Scenario11_MitigationBlock();
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(97);
      const zone = { top: new Decimal(99), bottom: new Decimal(97), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(102.5);
      const zone = { top: new Decimal(103), bottom: new Decimal(102), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(97);
      // Inverted: top < bottom
      const zone = { top: new Decimal(97), bottom: new Decimal(99), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(102.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(101), bottom: new Decimal(103), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});