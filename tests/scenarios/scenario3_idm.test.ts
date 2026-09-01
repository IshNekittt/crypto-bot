import { Scenario3_IDM } from '../../src/engine/scenarios/Scenario3_IDM';
import { Decimal } from 'decimal.js';

describe('Scenario3: Inducement (IDM)', () => {
  let scenario: Scenario3_IDM;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasIdmSweep: boolean;
    hasRealOb: boolean;
    priceTestsOb: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasIdmSweep: overrides.hasIdmSweep !== false,
      hasRealOb: overrides.hasRealOb !== false,
      priceTestsOb: overrides.priceTestsOb !== false,
    };

    const recentLowSweep = config.hasIdmSweep ? {
      direction: 'BULLISH', kind: 'CHOCH',
      brokenSwing: { type: 'LOW', price: new Decimal(100), timestamp: Date.now() - 2000, index: 10, isSwept: false },
    } : null;

    const realOb = config.hasRealOb ? {
      type: 'OB', direction: 'BULLISH', top: new Decimal(99.5), bottom: new Decimal(99),
      timestamp: Date.now() - 100000, mitigated: false, invalidated: false,
    } : null;

    const lastCandle = {
      timestamp: Date.now(),
      close: config.priceTestsOb ? '99.2' : '95',
      high: '100', low: '98.5', open: '99', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      zones: realOb ? [realOb] : [],
      structures: recentLowSweep ? [recentLowSweep] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario3_IDM();
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('IDM');
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

  describe('negative cases - IDM sweep', () => {
    it('should reject when no IDM sweep detected', () => {
      const result = scenario.evaluate(createMockPatternData({ hasIdmSweep: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No IDM sweep detected');
    });
  });

  describe('negative cases - real OB', () => {
    it('should reject when no real OB below swept low', () => {
      const result = scenario.evaluate(createMockPatternData({ hasRealOb: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No real OB below swept low');
    });
  });

  describe('negative cases - OB test', () => {
    it('should reject when price not testing real OB', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTestsOb: false }));
      expect(result).toBe(false);
      // The real OB exists, so the rejection should be about price not testing
      expect(scenario.getReason()).toBe('Price not testing real OB after IDM sweep');
    });
  });
});