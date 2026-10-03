import { Scenario5_HTFLiquiditySweep } from '../../src/engine/scenarios/Scenario5_HTFLiquiditySweep';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../src/config/env';

const mockConfig: BotConfig = {
  apiKey: '',
  apiSecret: '',
  testnet: false,
  demoTrading: true,
  symbols: [],
  riskPercent: '2',
  reducedRiskPercent: '1',
  leverage: '10',
  dataDir: 'data',
  historyCandles: 200,
  ltfTimeframe: '15',
  htfTimeframe: '240',
  macroCandles: 1000,
  telegramBotToken: null,
  telegramChatId: null,
  databaseUrl: null,
  autoTrading: false,
  tradeApprovalTimeoutMinutes: 5,
  enableLiveTestOrders: false,
  activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
  enableFundingMonitor: false,
  fundingMonitorSymbols: [],
  fundingAlertThreshold: '0.0',
  fundingRestoreThreshold: '0.0001',
  symbolScenarios: new Map(),
  backtestCsvPath: null,
  cooldownCandles: 16,
  smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6,
  smartEntryThresholdPct: '0.0015',
    enableSniperMode: false,
    backtestDays: 60,
};

describe('Scenario5: HTF Liquidity Sweep', () => {
  let scenario: Scenario5_HTFLiquiditySweep;

  beforeEach(() => {
    scenario = new Scenario5_HTFLiquiditySweep(mockConfig);
  });

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

  // Helper for BULLISH (Long) setups: PDL/SSL sweep
  const createBullishPatternData = (overrides: Partial<{
    killzone: string;
    hasChochAfterSweep: boolean;
    chochDisplacement: boolean;
    hasFreshFvg: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasChochAfterSweep: overrides.hasChochAfterSweep !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasFreshFvg: overrides.hasFreshFvg !== false,
    };

    // PDL at 95 - sweep wick below at 94, close back above at 96 (SFP bullish)
    const liquidityPool = {
      type: 'PDL', priceLevel: new Decimal(95),
      points: [], isTaken: false, timestamp: Date.now() - 1000,
    };

    const now = Date.now();
    const choch = config.hasChochAfterSweep ? {
      type: 'CHOCH', direction: 'BULLISH', price: new Decimal(97),
      timestamp: now - 2 * 60 * 60 * 1000,
      isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    // BULLISH FVG: top > bottom
    const freshFvg = config.hasFreshFvg ? {
      type: 'FVG', direction: 'BULLISH', top: new Decimal(97), bottom: new Decimal(95),
      timestamp: now,
      mitigated: false, timeframe: '15',
    } : null;

    // Sweep candle: wick below PDL (95) at 94, close back above at 96
    const sweepCandle = {
      timestamp: now, close: '96', high: '98', low: '94', open: '100', volume: '1000',
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
    scenario = new Scenario5_HTFLiquiditySweep(mockConfig);
  });

  describe('positive cases', () => {
    it('should trigger when PDH swept in killzone with CHoCH and FVG', () => {
      const result = scenario.evaluate(createMockPatternData({ hasLiquiditySweep: true }));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('HTF Liquidity Sweep');
      expect(scenario.getLevels().entry).toBeDefined();
    });

    it('should trigger when PDL swept in killzone with BULLISH CHoCH and FVG (Long setup)', () => {
      const result = scenario.evaluate(createBullishPatternData({}));
      
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

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      scenario.evaluate(createBullishPatternData({}));
      
      const levels = scenario.getLevels();
      const entry = new Decimal(levels.entry);
      const sl = new Decimal(levels.stopLoss);
      const tp = new Decimal(levels.takeProfit);
      
      // BULLISH: SL < Entry < TP
      expect(sl.lt(entry)).toBe(true);
      expect(tp.gt(entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      scenario.evaluate(createMockPatternData({ hasLiquiditySweep: true }));
      
      const levels = scenario.getLevels();
      const entry = new Decimal(levels.entry);
      const sl = new Decimal(levels.stopLoss);
      const tp = new Decimal(levels.takeProfit);
      
      // BEARISH: SL > Entry > TP
      expect(sl.gt(entry)).toBe(true);
      expect(tp.lt(entry)).toBe(true);
    });

    it('should handle inverted FVG zone (top < bottom) correctly for Long', () => {
      // Create inverted zone: top < bottom (swapped coordinates)
      const invertedFvgPatternData = {
        currentKillzone: 'LONDON',
        currentSession: 'LONDON',
        candles15m: [{
          timestamp: Date.now(), close: '96', high: '98', low: '94', open: '100', volume: '1000',
        }],
        structures: [{
          type: 'CHOCH', direction: 'BULLISH', price: new Decimal(97),
          timestamp: Date.now() - 2 * 60 * 60 * 1000,
          isValidated: true, impulseFactor: new Decimal(2.0),
        }],
        zones: [{
          type: 'FVG', direction: 'BULLISH', 
          top: new Decimal(95), bottom: new Decimal(97), // INVERTED: top < bottom
          timestamp: Date.now(), mitigated: false, timeframe: '15',
        }],
        liquidityPools: [{
          type: 'PDL', priceLevel: new Decimal(95),
          points: [], isTaken: false, timestamp: Date.now() - 1000,
        }],
        atr15m: new Decimal('0.5'),
      };
      
      const result = scenario.evaluate(invertedFvgPatternData);
      
      expect(result).toBe(true);
      const levels = scenario.getLevels();
      const entry = new Decimal(levels.entry);
      const sl = new Decimal(levels.stopLoss);
      
      // Even with inverted zone, SL must be < Entry for BULLISH
      expect(sl.lt(entry)).toBe(true);
    });

    it('should handle inverted FVG zone (top < bottom) correctly for Short', () => {
      // Create inverted zone for BEARISH: top < bottom
      const invertedFvgPatternData = {
        currentKillzone: 'LONDON',
        currentSession: 'LONDON',
        candles15m: [{
          timestamp: Date.now(), close: '104', high: '106', low: '103', open: '100', volume: '1000',
        }],
        structures: [{
          type: 'CHOCH', direction: 'BEARISH', price: new Decimal(103),
          timestamp: Date.now() - 2 * 60 * 60 * 1000,
          isValidated: true, impulseFactor: new Decimal(2.0),
        }],
        zones: [{
          type: 'FVG', direction: 'BEARISH', 
          top: new Decimal(101), bottom: new Decimal(103), // INVERTED: top < bottom
          timestamp: Date.now(), mitigated: false, timeframe: '15',
        }],
        liquidityPools: [{
          type: 'PDH', priceLevel: new Decimal(105),
          points: [], isTaken: false, timestamp: Date.now() - 1000,
        }],
        atr15m: new Decimal('0.5'),
      };
      
      const result = scenario.evaluate(invertedFvgPatternData);
      
      expect(result).toBe(true);
      const levels = scenario.getLevels();
      const entry = new Decimal(levels.entry);
      const sl = new Decimal(levels.stopLoss);
      
      // Even with inverted zone, SL must be > Entry for BEARISH
      expect(sl.gt(entry)).toBe(true);
    });
  });
});