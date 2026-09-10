import { Scenario1_HTFContinuation } from '../../src/engine/scenarios/Scenario1_HTFContinuation';
import { Decimal } from 'decimal.js';

describe('Scenario1: HTF Continuation', () => {
  let scenario: Scenario1_HTFContinuation;

  beforeEach(() => {
    scenario = new Scenario1_HTFContinuation();
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(101.5);
      const zone = { top: new Decimal(104), bottom: new Decimal(102), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(98.5);
      const zone = { top: new Decimal(98), bottom: new Decimal(96), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(101.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(102), bottom: new Decimal(104), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(98.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(96), bottom: new Decimal(98), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});