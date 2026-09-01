import { Scenario7_AMD } from '../../src/engine/scenarios/Scenario7_AMD';
import { Decimal } from 'decimal.js';

describe('Scenario7: AMD (Accumulation-Manipulation-Distribution)', () => {
  let scenario: Scenario7_AMD;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasAsianRange: boolean;
    asianLowSwept: boolean;
    hasChoch: boolean;
    chochDisplacement: boolean;
    hasFreshFvg: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasAsianRange: overrides.hasAsianRange !== false,
      asianLowSwept: overrides.asianLowSwept || false,
      hasChoch: overrides.hasChoch !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasFreshFvg: overrides.hasFreshFvg !== false,
    };

    const asianRange = config.hasAsianRange ? {
      name: 'ASIAN', high: new Decimal(105), low: new Decimal(99),
      start: Date.now() - 50000, end: Date.now() - 10000,
    } : null;

    const choch = config.hasChoch ? {
      kind: 'CHOCH', direction: 'BULLISH', price: new Decimal(100),
      timestamp: Date.now() - 500, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const freshFvg = config.hasFreshFvg ? {
      type: 'FVG', direction: 'BULLISH', top: new Decimal(101), bottom: new Decimal(99.5),
      timestamp: Date.now() - 100, mitigated: false, timeframe: '15',
    } : null;

    const sweepCandle = config.asianLowSwept ? {
      timestamp: Date.now(), open: '100', high: '101', low: '98.5', close: '99.5', volume: '1000',
    } : {
      timestamp: Date.now(), open: '100', high: '101', low: '99.5', close: '100', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [sweepCandle],
      sessionRanges: asianRange ? [asianRange] : [],
      structures: choch ? [choch] : [],
      zones: freshFvg ? [freshFvg] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario7_AMD();
  });

  describe('positive cases', () => {
    it('should trigger when Asian Low swept in London/NY killzone with CHoCH and FVG', () => {
      const result = scenario.evaluate(createMockPatternData({ asianLowSwept: true }));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('AMD');
      expect(scenario.getLevels().entry).toBeDefined();
      expect(scenario.getLevels().takeProfit).toBeDefined();
      expect(parseFloat(scenario.getLevels().takeProfit)).toBe(105);
    });

    it('should work in NY killzone', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NY', asianLowSwept: true }));
      expect(result).toBe(true);
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is ASIAN', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'ASIAN', asianLowSwept: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });

    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE', asianLowSwept: true }));
      expect(result).toBe(false);
    });
  });

  describe('negative cases - Asian Range', () => {
    it('should reject when no Asian Range detected', () => {
      const result = scenario.evaluate(createMockPatternData({ hasAsianRange: false }));
      expect(result).toBe(false);
    });
  });

  describe('negative cases - Asian Low sweep', () => {
    it('should reject when Asian Low not swept', () => {
      const result = scenario.evaluate(createMockPatternData({ asianLowSwept: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('Asian Low not swept');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no bullish CHoCH after sweep', () => {
      const result = scenario.evaluate(createMockPatternData({ asianLowSwept: true, hasChoch: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ asianLowSwept: true, chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH after Asian Low sweep displacement < 1.5 ATR');
    });
  });

  describe('negative cases - FVG', () => {
    it('should reject when no fresh bullish FVG after CHoCH', () => {
      const result = scenario.evaluate(createMockPatternData({ asianLowSwept: true, hasFreshFvg: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('FVG');
    });
  });
});