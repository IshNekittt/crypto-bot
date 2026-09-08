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
    breakIsBos: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasBreakThroughOb: overrides.hasBreakThroughOb !== false,
      hasNearbyFvg: overrides.hasNearbyFvg !== false,
      priceTestingBreaker: overrides.priceTestingBreaker !== false,
      breakValidBodyClose: overrides.breakValidBodyClose !== false,
      breakDisplacement: overrides.breakDisplacement !== false,
      breakIsBos: overrides.breakIsBos !== false,
    };

    const now = Date.now();
    const breakEvent = config.hasBreakThroughOb ? {
      type: config.breakIsBos ? 'BOS' : 'CHOCH', direction: 'BULLISH', price: new Decimal(106),
      timestamp: now - 2 * 60 * 60 * 1000, // 2 hours ago
      isValidated: config.breakValidBodyClose, impulseFactor: config.breakDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    // OB must be fresh (<24H old)
    const brokenOb = config.hasBreakThroughOb ? {
      type: 'OB', direction: 'BEARISH', top: new Decimal(104), bottom: new Decimal(103),
      timestamp: now - 3 * 60 * 60 * 1000, mitigated: false, timeframe: '15',
    } : null;

    const nearbyFvg = config.hasNearbyFvg ? {
      type: 'FVG', direction: 'BULLISH', top: new Decimal(107), bottom: new Decimal(105),
      timestamp: now - 2 * 60 * 60 * 1000, mitigated: false, timeframe: '15',
    } : null;

    // Create candles with a swing high at 104 that gets swept (wick above 104, close below 104)
    // This simulates liquidity being swept at the OB top before the break
    // Need proper swing high: lower highs on both sides, then sweep
    const candles15m: any[] = [];
    // Add candles before the swing high - lower highs
    for (let i = 0; i < 10; i++) {
      const ts = now - (25 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '102', high: '102.5', low: '101', close: '102', volume: '1000',
      });
    }
    // Swing high at 104 (index 10) - local maximum
    candles15m.push({
      timestamp: now - 15 * 900000,
      open: '102', high: '104', low: '101', close: '102', volume: '1000',
    });
    // Two candles after with lower highs (to confirm swing high)
    candles15m.push({
      timestamp: now - 13 * 900000,
      open: '102', high: '103', low: '101', close: '102', volume: '1000',
    });
    candles15m.push({
      timestamp: now - 12 * 900000,
      open: '102', high: '103', low: '101', close: '102', volume: '1000',
    });
    // Sweep candle: wick above 104, close below 104
    candles15m.push({
      timestamp: now - 11 * 900000,
      open: '102', high: '105', low: '101', close: '103', volume: '1000',
    });
    // More candles after sweep
    for (let i = 0; i < 5; i++) {
      const ts = now - (10 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '102', high: '103', low: '101', close: '102', volume: '1000',
      });
    }
    // Current candle (retest)
    const lastCandle = config.priceTestingBreaker ? {
      timestamp: now, close: '103.5', high: '104.5', low: '103', open: '104', volume: '1000',
    } : {
      timestamp: now, close: '107', high: '108', low: '106', open: '107', volume: '1000',
    };
    candles15m.push(lastCandle);

    return {
      currentKillzone: config.killzone,
      currentSession: 'LONDON',
      candles15m,
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
      const result = scenario.evaluate(createMockPatternData({ breakIsBos: true }));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Breaker Block');
      expect(scenario.getLevels().entry).toBeDefined();
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE', breakIsBos: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - break through OB', () => {
    it('should reject when no structures available (no structures = early return)', () => {
      const result = scenario.evaluate(createMockPatternData({ hasBreakThroughOb: false, breakIsBos: true }));
      expect(result).toBe(false);
      // When structures is empty, early return without logging reason
      expect(scenario.getReason()).toBe('');
    });
  });

  describe('negative cases - break type', () => {
    it('should reject when break is CHoCH not BOS', () => {
      const result = scenario.evaluate(createMockPatternData({ breakIsBos: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No OB broken by impulsive BOS (Break of Structure)');
    });
  });

  describe('negative cases - nearby FVG', () => {
    it('should reject when no FVG near Breaker Block', () => {
      const result = scenario.evaluate(createMockPatternData({ hasNearbyFvg: false, breakIsBos: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No FVG near Breaker Block (displacement required)');
    });
  });

  describe('negative cases - price testing breaker', () => {
    it('should reject when price not testing Breaker Block zone', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTestingBreaker: false, breakIsBos: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Price not testing Breaker Block zone on retest');
    });
  });

  describe('negative cases - break validation', () => {
    it('should reject when original break not validated (wick only)', () => {
      const result = scenario.evaluate(createMockPatternData({ breakValidBodyClose: false, breakIsBos: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Original break not validated (wick only)');
    });

    it('should reject when original break displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ breakDisplacement: false, breakIsBos: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Original break displacement < 1.5 ATR');
    });
  });

  describe('negative cases - OB freshness', () => {
    it('should reject when broken OB too old (>24H)', () => {
      const mockData = {
        currentKillzone: 'LONDON',
        currentSession: 'LONDON',
        candles15m: [{
          timestamp: Date.now(), close: '103.5', high: '104.5', low: '103', open: '104', volume: '1000',
        }],
        structures: [{
          type: 'BOS', direction: 'BULLISH', price: new Decimal(106),
          timestamp: Date.now() - 2 * 60 * 60 * 1000,
          isValidated: true, impulseFactor: new Decimal(2.0),
        }],
        zones: [{
          type: 'OB', direction: 'BEARISH', top: new Decimal(104), bottom: new Decimal(103),
          timestamp: Date.now() - 30 * 60 * 60 * 1000, mitigated: false, timeframe: '15', // 30H old
        }, {
          type: 'FVG', direction: 'BULLISH', top: new Decimal(107), bottom: new Decimal(105),
          timestamp: Date.now() - 2 * 60 * 60 * 1000, mitigated: false, timeframe: '15',
        }],
        atr15m: new Decimal('0.5'),
      };
      const result = scenario.evaluate(mockData);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Broken OB too old (>24H) - not a fresh Breaker Block');
    });
  });

  describe('negative cases - liquidity sweep', () => {
    it('should reject when broken OB extreme did not sweep liquidity', () => {
      // Create mock data without the swept swing high
      const mockData = {
        currentKillzone: 'LONDON',
        currentSession: 'LONDON',
        candles15m: [{
          timestamp: Date.now(), close: '103.5', high: '104.5', low: '103', open: '104', volume: '1000',
        }],
        structures: [{
          type: 'BOS', direction: 'BULLISH', price: new Decimal(106),
          timestamp: Date.now() - 2 * 60 * 60 * 1000,
          isValidated: true, impulseFactor: new Decimal(2.0),
        }],
        zones: [{
          type: 'OB', direction: 'BEARISH', top: new Decimal(104), bottom: new Decimal(103),
          timestamp: Date.now() - 3 * 60 * 60 * 1000, mitigated: false, timeframe: '15',
        }, {
          type: 'FVG', direction: 'BULLISH', top: new Decimal(107), bottom: new Decimal(105),
          timestamp: Date.now() - 2 * 60 * 60 * 1000, mitigated: false, timeframe: '15',
        }],
        atr15m: new Decimal('0.5'),
      };
      const result = scenario.evaluate(mockData);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Broken OB extreme did not sweep liquidity (not a true Breaker Block)');
    });
  });
});