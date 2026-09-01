import { Scenario1_HTFContinuation } from '../../src/engine/scenarios/Scenario1_HTFContinuation';
import { Decimal } from 'decimal.js';

describe('Scenario1: HTF Continuation', () => {
  let scenario: Scenario1_HTFContinuation;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasHtfOb: boolean;
    obMitigated: boolean;
    priceTouchesOb: boolean;
    hasChoch: boolean;
    chochDisplacement: boolean;
    hasFreshFvg: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasHtfOb: overrides.hasHtfOb !== false,
      obMitigated: overrides.obMitigated || false,
      priceTouchesOb: overrides.priceTouchesOb !== false,
      hasChoch: overrides.hasChoch !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasFreshFvg: overrides.hasFreshFvg !== false,
    };

    const htfOb = config.hasHtfOb ? {
      type: 'OB', direction: 'BULLISH', top: new Decimal(102), bottom: new Decimal(101),
      timestamp: Date.now() - 100000, mitigated: config.obMitigated, timeframe: '240',
    } : null;

    const choch = config.hasChoch ? {
      kind: 'CHOCH', direction: 'BULLISH', price: new Decimal(103),
      timestamp: Date.now() - 1000, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
      brokenSwing: { type: 'LOW', price: new Decimal(99), timestamp: Date.now() - 2000, index: 10, isSwept: false },
      candleIndex: 20,
    } : null;

    const freshFvg = config.hasFreshFvg ? {
      type: 'FVG', direction: 'BULLISH', top: new Decimal(104), bottom: new Decimal(102),
      timestamp: Date.now() - 500, mitigated: false, timeframe: '15', index: 25,
    } : null;

    const lastCandle = {
      timestamp: Date.now(),
      close: config.priceTouchesOb ? '101.5' : '95',
      high: '102', low: '101', open: '100', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      zones: [htfOb, freshFvg].filter(Boolean),
      structures: choch ? [choch] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario1_HTFContinuation();
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('HTF Continuation');
      expect(scenario.getLevels().entry).toBeDefined();
      expect(scenario.getLevels().stopLoss).toBeDefined();
      expect(scenario.getLevels().takeProfit).toBeDefined();
      
      const entry = parseFloat(scenario.getLevels().entry);
      const sl = parseFloat(scenario.getLevels().stopLoss);
      const tp = parseFloat(scenario.getLevels().takeProfit);
      expect(entry).toBeGreaterThan(sl);
      expect(tp).toBeGreaterThan(entry);
      expect(tp - entry).toBeCloseTo((entry - sl) * 3, 1);
    });

    it('should work in NY killzone', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NY' }));
      expect(result).toBe(true);
    });

    it('should work in ASIAN killzone', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'ASIAN' }));
      expect(result).toBe(true);
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE' }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - HTF OB', () => {
    it('should reject when no HTF OB found', () => {
      const result = scenario.evaluate(createMockPatternData({ hasHtfOb: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No valid 4H Order Block found');
    });

    it('should reject when HTF OB is mitigated', () => {
      const result = scenario.evaluate(createMockPatternData({ obMitigated: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('All 4H OBs mitigated');
    });

    it('should reject when price has not touched HTF OB', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTouchesOb: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Price has not touched 4H OB zone');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no 15m CHoCH found', () => {
      const result = scenario.evaluate(createMockPatternData({ hasChoch: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No 15m CHoCH found after OB touch');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('15m CHoCH displacement < 1.5 ATR');
    });
  });

  describe('negative cases - FVG', () => {
    it('should reject when no fresh 15m FVG after CHoCH', () => {
      const result = scenario.evaluate(createMockPatternData({ hasFreshFvg: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No 15m FVG found after CHoCH');
    });
  });
});