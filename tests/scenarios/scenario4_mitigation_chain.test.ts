import { Scenario4_MitigationChain } from '../../src/engine/scenarios/Scenario4_MitigationChain';
import { Decimal } from 'decimal.js';

describe('Scenario4: Mitigation Chain', () => {
  let scenario: Scenario4_MitigationChain;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasTrendOb: boolean;
    obMitigated: boolean;
    priceTouchesEq: boolean;
    hasChoch: boolean;
    chochDisplacement: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasTrendOb: overrides.hasTrendOb !== false,
      obMitigated: overrides.obMitigated || false,
      priceTouchesEq: overrides.priceTouchesEq !== false,
      hasChoch: overrides.hasChoch !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
    };

    const trendOb = config.hasTrendOb ? {
      type: 'OB', direction: 'BULLISH', top: new Decimal(102), bottom: new Decimal(100),
      timestamp: Date.now() - 100000, mitigated: config.obMitigated, timeframe: '15',
    } : null;

    const choch = config.hasChoch ? {
      kind: 'CHOCH', direction: 'BULLISH', price: new Decimal(103),
      timestamp: Date.now() - 1000, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const lastCandle = {
      timestamp: Date.now(),
      close: config.priceTouchesEq ? '101' : '94',
      high: config.priceTouchesEq ? '102' : '98',
      low: config.priceTouchesEq ? '100' : '93',
      open: '100', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      zones: trendOb ? [trendOb] : [],
      structures: choch ? [choch] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario4_MitigationChain();
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Chain');
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

  describe('negative cases - trend OB', () => {
    it('should reject when no valid OB in trend direction', () => {
      const result = scenario.evaluate(createMockPatternData({ hasTrendOb: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No valid OB in trend direction');
    });

    it('should reject when OB is mitigated', () => {
      const result = scenario.evaluate(createMockPatternData({ obMitigated: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid OB');
    });
  });

  describe('negative cases - 0.5 equilibrium', () => {
    it('should reject when price has not touched 0.5 of OB', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTouchesEq: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('0.5 (Equilibrium) of OB');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no CHoCH confirming trend direction', () => {
      const result = scenario.evaluate(createMockPatternData({ hasChoch: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No CHoCH confirming trend direction');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH displacement < 1.5 ATR');
    });
  });
});