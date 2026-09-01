import { Scenario10_BreakerBlock } from '../../src/engine/scenarios/Scenario10_BreakerBlock';
import { Decimal } from 'decimal.js';

describe('Scenario10: Breaker Block Entry', () => {
  let scenario: Scenario10_BreakerBlock;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasBreakThroughOb: boolean;
    hasNearbyFvg: boolean;
    priceTestingBreaker: boolean;
    breakValidBodyClose: boolean;
    breakDisplacement: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasBreakThroughOb: overrides.hasBreakThroughOb !== false,
      hasNearbyFvg: overrides.hasNearbyFvg !== false,
      priceTestingBreaker: overrides.priceTestingBreaker !== false,
      breakValidBodyClose: overrides.breakValidBodyClose !== false,
      breakDisplacement: overrides.breakDisplacement !== false,
    };

    const breakEvent = config.hasBreakThroughOb ? {
      kind: 'CHOCH', direction: 'BULLISH', price: new Decimal(106),
      timestamp: Date.now() - 2000, isValidated: config.breakValidBodyClose, impulseFactor: config.breakDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const brokenOb = config.hasBreakThroughOb ? {
      type: 'OB', direction: 'BEARISH', top: new Decimal(104), bottom: new Decimal(103),
      timestamp: Date.now() - 3000, mitigated: false, timeframe: '15',
    } : null;

    const nearbyFvg = config.hasNearbyFvg ? {
      type: 'FVG', direction: 'BULLISH', top: new Decimal(107), bottom: new Decimal(105),
      timestamp: Date.now() - 2000, mitigated: false, timeframe: '15',
    } : null;

    const lastCandle = config.priceTestingBreaker ? {
      timestamp: Date.now(), close: '103.5', high: '104.5', low: '103', open: '104', volume: '1000',
    } : {
      timestamp: Date.now(), close: '107', high: '108', low: '106', open: '107', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      structures: [breakEvent].filter(Boolean),
      zones: [brokenOb, nearbyFvg].filter(Boolean),
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario10_BreakerBlock();
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Breaker Block');
      expect(scenario.getLevels().entry).toBeDefined();
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE' }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - break through OB', () => {
    it('should reject when no structures available (no structures = early return)', () => {
      const result = scenario.evaluate(createMockPatternData({ hasBreakThroughOb: false }));
      expect(result).toBe(false);
      // When structures is empty, early return without logging reason
      expect(scenario.getReason()).toBe('');
    });
  });

  describe('negative cases - nearby FVG', () => {
    it('should reject when no FVG near Breaker Block', () => {
      const result = scenario.evaluate(createMockPatternData({ hasNearbyFvg: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No FVG near Breaker Block (displacement required)');
    });
  });

  describe('negative cases - price testing breaker', () => {
    it('should reject when price not testing Breaker Block zone', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTestingBreaker: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Price not testing Breaker Block zone');
    });
  });

  describe('negative cases - break validation', () => {
    it('should reject when original break not validated (wick only)', () => {
      const result = scenario.evaluate(createMockPatternData({ breakValidBodyClose: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Original break not validated (wick only)');
    });

    it('should reject when original break displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ breakDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Original break displacement < 1.5 ATR');
    });
  });
});