import { Scenario8_RangeDeviationReclaim } from '../../src/engine/scenarios/Scenario8_RangeDeviationReclaim';
import { Decimal } from 'decimal.js';

describe('Scenario8: Range Deviation & Reclaim', () => {
  let scenario: Scenario8_RangeDeviationReclaim;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasTradingRange: boolean;
    hasDeviation: boolean;
    hasReclaim: boolean;
    hasChoch: boolean;
    chochDisplacement: boolean;
    hasFreshFvg: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasTradingRange: overrides.hasTradingRange !== false,
      hasDeviation: overrides.hasDeviation !== false,
      hasReclaim: overrides.hasReclaim !== false,
      hasChoch: overrides.hasChoch !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasFreshFvg: overrides.hasFreshFvg !== false,
    };

    const tradingRange = config.hasTradingRange ? {
      high: new Decimal(105), low: new Decimal(95), equilibrium: new Decimal(100), isDeviated: config.hasDeviation,
    } : null;

    const bearishChoch = config.hasChoch ? {
      kind: 'CHOCH', direction: 'BEARISH', price: new Decimal(102),
      timestamp: Date.now() - 500, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const freshFvg = config.hasFreshFvg ? {
      type: 'FVG', direction: 'BEARISH', top: new Decimal(103), bottom: new Decimal(101),
      timestamp: Date.now() - 100, mitigated: false, timeframe: '15',
    } : null;

    const lastCandle = config.hasReclaim ? {
      timestamp: Date.now(), close: '104', high: '106', low: '103', open: '105', volume: '1000',
    } : {
      timestamp: Date.now(), close: '106', high: '107', low: '105', open: '105', volume: '1000',
    };

    const prevCandle = config.hasDeviation ? {
      timestamp: Date.now() - 900000, close: '106', high: '107', low: '105', open: '105', volume: '1000',
    } : {
      timestamp: Date.now() - 900000, close: '104', high: '105', low: '103', open: '104', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [prevCandle, lastCandle],
      tradingRange,
      structures: bearishChoch ? [bearishChoch] : [],
      zones: freshFvg ? [freshFvg] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario8_RangeDeviationReclaim();
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Range Deviation & Reclaim');
      expect(scenario.getLevels().entry).toBeDefined();
    });

    it('should work in NY killzone', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NY' }));
      expect(result).toBe(true);
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is ASIAN', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'ASIAN' }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });

    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE' }));
      expect(result).toBe(false);
    });
  });

  describe('negative cases - trading range', () => {
    it('should reject when no trading range', () => {
      const result = scenario.evaluate(createMockPatternData({ hasTradingRange: false }));
      expect(result).toBe(false);
    });
  });

  describe('negative cases - deviation', () => {
    it('should reject when no deviation above Range High', () => {
      // Create custom mock where neither last nor prev candle deviates
      const mockData = {
        currentKillzone: 'LONDON',
        candles15m: [
          { timestamp: Date.now() - 900000, close: '104', high: '105', low: '103', open: '104', volume: '1000' },
          { timestamp: Date.now(), close: '104', high: '104', low: '103', open: '104', volume: '1000' },
        ],
        tradingRange: { high: new Decimal(105), low: new Decimal(95), equilibrium: new Decimal(100), isDeviated: false },
        structures: [{
          kind: 'CHOCH', direction: 'BEARISH', price: new Decimal(102),
          timestamp: Date.now() - 500, isValidated: true, impulseFactor: new Decimal(2.0),
        }],
        zones: [{
          type: 'FVG', direction: 'BEARISH', top: new Decimal(103), bottom: new Decimal(101),
          timestamp: Date.now() - 100, mitigated: false, timeframe: '15',
        }],
        atr15m: new Decimal('0.5'),
      };
      const result = scenario.evaluate(mockData);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('deviation');
    });
  });

  describe('negative cases - reclaim', () => {
    it('should reject when price has not reclaimed back into range', () => {
      const result = scenario.evaluate(createMockPatternData({ hasReclaim: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('not reclaimed');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no bearish CHoCH on reclaim', () => {
      const result = scenario.evaluate(createMockPatternData({ hasChoch: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No bearish CHoCH on reclaim');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH on reclaim displacement < 1.5 ATR');
    });
  });

  describe('negative cases - FVG', () => {
    it('should reject when no fresh bearish FVG after CHoCH', () => {
      const result = scenario.evaluate(createMockPatternData({ hasFreshFvg: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No bearish 15m FVG after CHoCH');
    });
  });
});