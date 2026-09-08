import { Scenario5_HTFLiquiditySweep } from '../../src/engine/scenarios/Scenario5_HTFLiquiditySweep';
import { Decimal } from 'decimal.js';

describe('Scenario5: HTF Liquidity Sweep', () => {
  let scenario: Scenario5_HTFLiquiditySweep;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasLiquiditySweep: boolean;
    sweepPoolType: string;
    hasChochAfterSweep: boolean;
    chochDisplacement: boolean;
    hasFreshFvg: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasLiquiditySweep: overrides.hasLiquiditySweep || false,
      sweepPoolType: overrides.sweepPoolType || 'PDH',
      hasChochAfterSweep: overrides.hasChochAfterSweep !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasFreshFvg: overrides.hasFreshFvg !== false,
    };

    const liquidityPool = {
      type: config.sweepPoolType, priceLevel: new Decimal(105),
      points: [], isTaken: false, timestamp: Date.now() - 1000,
    };

    const now = Date.now();
    const choch = config.hasChochAfterSweep ? {
      type: 'CHOCH', direction: 'BEARISH', price: new Decimal(103),
      timestamp: now - 2 * 60 * 60 * 1000, // 2 hours ago (within 4H window)
      isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const freshFvg = config.hasFreshFvg ? {
      type: 'FVG', direction: 'BEARISH', top: new Decimal(103), bottom: new Decimal(101),
      timestamp: now, // Current candle timestamp (FVG formed on current candle)
      mitigated: false, timeframe: '15',
    } : null;

    // Sweep candle: wick above PDH (105) at 106, close back below at 104 (SFP)
    const sweepCandle = config.hasLiquiditySweep ? {
      timestamp: now, close: '104', high: '106', low: '103', open: '100', volume: '1000',
    } : {
      timestamp: now, close: '100', high: '101', low: '99', open: '100', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      currentSession: 'LONDON',
      candles15m: [sweepCandle],
      structures: choch ? [choch] : [],
      zones: freshFvg ? [freshFvg] : [],
      liquidityPools: [liquidityPool],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario5_HTFLiquiditySweep();
  });

  describe('positive cases', () => {
    it('should trigger when PDH swept in killzone with CHoCH and FVG', () => {
      const result = scenario.evaluate(createMockPatternData({ hasLiquiditySweep: true }));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('HTF Liquidity Sweep');
      expect(scenario.getLevels().entry).toBeDefined();
    });

    it('should work in NY killzone', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NY', hasLiquiditySweep: true }));
      expect(result).toBe(true);
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE', hasLiquiditySweep: true }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });
  });

  describe('negative cases - liquidity sweep', () => {
    it('should reject when no HTF liquidity pool swept', () => {
      const result = scenario.evaluate(createMockPatternData({ hasLiquiditySweep: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('sweep');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no CHoCH after sweep', () => {
      const result = scenario.evaluate(createMockPatternData({ hasLiquiditySweep: true, hasChochAfterSweep: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ hasLiquiditySweep: true, chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('displacement < 1.5 ATR');
    });
  });

  describe('negative cases - FVG', () => {
    it('should reject when no fresh FVG after CHoCH', () => {
      const result = scenario.evaluate(createMockPatternData({ hasLiquiditySweep: true, hasFreshFvg: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('FVG');
    });
  });
});