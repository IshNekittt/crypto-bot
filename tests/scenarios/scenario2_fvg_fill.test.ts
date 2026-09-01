import { Scenario2_FVGFill } from '../../src/engine/scenarios/Scenario2_FVGFill';
import { Decimal } from 'decimal.js';

describe('Scenario2: FVG Fill', () => {
  let scenario: Scenario2_FVGFill;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasHtfFvg: boolean;
    priceTouchesEq: boolean;
    hasChoch: boolean;
    chochDisplacement: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasHtfFvg: overrides.hasHtfFvg !== false,
      priceTouchesEq: overrides.priceTouchesEq !== false,
      hasChoch: overrides.hasChoch !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
    };

    const htfFvg = config.hasHtfFvg ? {
      type: 'FVG', direction: 'BULLISH', top: new Decimal(105), bottom: new Decimal(103),
      timestamp: Date.now() - 100000, mitigated: false, timeframe: '240',
    } : null;

    const choch = config.hasChoch ? {
      kind: 'CHOCH', direction: 'BULLISH', price: new Decimal(104),
      timestamp: Date.now() - 1000, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const eq = htfFvg ? htfFvg.top.plus(htfFvg.bottom).dividedBy(2) : new Decimal(104);

    const lastCandle = {
      timestamp: Date.now(),
      close: config.priceTouchesEq ? eq.toFixed(2) : '95',
      high: config.priceTouchesEq ? (eq.plus(0.5)).toFixed(2) : '101',
      low: config.priceTouchesEq ? (eq.minus(0.5)).toFixed(2) : '99',
      open: '100', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      zones: htfFvg ? [htfFvg] : [],
      structures: choch ? [choch] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario2_FVGFill();
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('FVG Fill');
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

  describe('negative cases - HTF FVG', () => {
    it('should reject when no HTF FVG found', () => {
      const result = scenario.evaluate(createMockPatternData({ hasHtfFvg: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No HTF FVG found');
    });
  });

  describe('negative cases - 0.5 equilibrium', () => {
    it('should reject when price has not touched 0.5 of HTF FVG', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTouchesEq: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('0.5 (Equilibrium) of HTF FVG');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no 15m CHoCH after FVG touch', () => {
      const result = scenario.evaluate(createMockPatternData({ hasChoch: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No 15m CHoCH after FVG touch');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('15m CHoCH displacement < 1.5 ATR');
    });
  });
});