import { Scenario4_MitigationChain } from '../../src/engine/scenarios/Scenario4_MitigationChain';
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
  fundingAlertThresholdPct: '0.0',
  fundingRestoreThresholdPct: '0.0001',
  symbolScenarios: new Map(),
  backtestCsvPath: null,
  cooldownCandles: 16,
  smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6,
  smartEntryThresholdPct: '0.0015',
    enableSniperMode: false,
    backtestDays: 60,
    useLocalCacheOnly: false,
    maxWorkingCapital: 0,
    preflightBufferPct: "0.05",
    enableHealthcheckServer: false,
    allowedDaysOfWeek: [1, 2, 3, 4, 5],
    enforceKillzones: true,
    enableTradeNotifications: true,
};

describe('Scenario4: Mitigation Chain', () => {
  let scenario: Scenario4_MitigationChain;

  beforeEach(() => {
    scenario = new Scenario4_MitigationChain(mockConfig);
  });

  /**
   * Creates IDEAL synthetic pattern data for Mitigation Chain:
   * - OB formed 5 candles ago (timestamp = now - 5*15min)
   * - BOS occurred 3 candles after OB (within 24H)
   * - Current candle: price at OB 0.5 (equilibrium = 101)
   * - Fresh 15m BULLISH CHoCH with displacement >= 1.5 ATR
   * - 4H trend is BULLISH (BOS present, no BEARISH)
   */
  const createIdealMitigationChainPatternData = () => {
    const FIXED_NOW = 1788675600000; // LONDON killzone
    const OB_TIME = FIXED_NOW - 5 * 900000; // 5 candles ago (75 min)

    // Trend OB (BULLISH): top=101, bottom=99, eq=100 (in Discount zone if equilibrium > 100)
    const trendOb = {
      type: 'OB' as const,
      direction: 'BULLISH' as const,
      top: new Decimal(101),
      bottom: new Decimal(99),
      timestamp: OB_TIME,
      mitigated: false,
      timeframe: '15',
    };

    // Create 6 candles
    const candles15m: any[] = [];
    for (let i = 0; i < 6; i++) {
      const ts = FIXED_NOW - (5 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '100',
        high: '102',
        low: '98',
        close: '100',
        volume: '1000',
      });
    }

    // OB formation candle (index 0, timestamp = OB_TIME)
    candles15m[0] = {
      timestamp: OB_TIME,
      open: '100',
      high: '101.5',
      low: '99.5',
      close: '100.5',
      volume: '1000',
    };

    // Candle 1: BOS after OB (within 24H)
    const bosTime = OB_TIME + 3 * 900000; // 45 min after OB
    candles15m[1] = {
      timestamp: bosTime,
      open: '100',
      high: '103', // BOS: broke above recent high
      low: '99',
      close: '102',
      volume: '1000',
    };

    // Current candle (index 5): price at OB equilibrium (100)
    candles15m[5] = {
      timestamp: FIXED_NOW,
      high: '100.5',
      low: '99.5',
      close: '100', // exactly at OB equilibrium
      open: '100',
      volume: '1000',
    };

    // 15m CHoCH after OB touch (current area)
    const choch = {
      type: 'CHOCH' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(100),
      timestamp: FIXED_NOW - 500,
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    // 4H structures: BULLISH BOS (trend confirmation) - must be AFTER OB formation
    const bos4h = {
      type: 'BOS' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(102),
      timestamp: OB_TIME + 3 * 900000, // 45 min after OB (same as bosTime candle)
      timeframe: '240',
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    return {
      currentKillzone: 'LONDON' as const,
      currentSession: 'LONDON' as const,
      candles15m,
      zones: [trendOb],
      structures: [choch, bos4h],
      atr15m: new Decimal('0.5'),
      patternRecognizer: {
        config: {
          wickRatioThreshold: new Decimal('0.4'),
        },
        calculatePremiumDiscount: (candles: any[]) => {
          const highs = candles.map((c: any) => new Decimal(c.high));
          const lows = candles.map((c: any) => new Decimal(c.low));
          const rangeHigh = Decimal.max(...highs);
          const rangeLow = Decimal.min(...lows);
          const equilibrium = rangeHigh.plus(rangeLow).dividedBy(2);
          return { equilibrium, rangeHigh, rangeLow, isPremium: false, isDiscount: false };
        }
      } as any,
    };
  };

  /**
   * Creates Mitigation Chain pattern WITHOUT BOS after OB (should reject)
   */
  const createMitigationChainNoBosAfterOb = () => {
    const FIXED_NOW = 1788675600000;
    const OB_TIME = FIXED_NOW - 5 * 900000;

    const trendOb = {
      type: 'OB' as const,
      direction: 'BULLISH' as const,
      top: new Decimal(102),
      bottom: new Decimal(100),
      timestamp: OB_TIME,
      mitigated: false,
      timeframe: '15',
    };

    const candles15m: any[] = [];
    for (let i = 0; i < 6; i++) {
      const ts = FIXED_NOW - (5 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volume: '1000',
      });
    }

    // OB formation
    candles15m[0] = {
      timestamp: OB_TIME,
      open: '101',
      high: '102.5',
      low: '100.5',
      close: '101.5',
      volume: '1000',
    };

    // NO BOS after OB - just random candles

    // Current candle at OB equilibrium
    candles15m[5] = {
      timestamp: FIXED_NOW,
      high: '101.5',
      low: '100.5',
      close: '101',
      open: '101',
      volume: '1000',
    };

    const choch = {
      type: 'CHOCH' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(101),
      timestamp: FIXED_NOW - 500,
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    const bos4h = {
      type: 'BOS' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(102),
      timestamp: FIXED_NOW - 2 * 60 * 60 * 1000,
      timeframe: '240',
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    return {
      currentKillzone: 'LONDON' as const,
      currentSession: 'LONDON' as const,
      candles15m,
      zones: [trendOb],
      structures: [choch, bos4h],
      atr15m: new Decimal('0.5'),
      patternRecognizer: {
        config: {
          wickRatioThreshold: new Decimal('0.4'),
        },
        calculatePremiumDiscount: (candles: any[]) => {
          const highs = candles.map((c: any) => new Decimal(c.high));
          const lows = candles.map((c: any) => new Decimal(c.low));
          const rangeHigh = Decimal.max(...highs);
          const rangeLow = Decimal.min(...lows);
          const equilibrium = rangeHigh.plus(rangeLow).dividedBy(2);
          return { equilibrium, rangeHigh, rangeLow, isPremium: false, isDiscount: false };
        }
      } as any,
    };
  };

  beforeEach(() => {
    scenario = new Scenario4_MitigationChain(mockConfig);
  });

  describe('SYNTHETIC TEST - Ideal Mitigation Chain Pattern', () => {
    it('should trigger on perfect Mitigation Chain: OB + BOS + 0.5 touch + CHoCH', () => {
      const result = scenario.evaluate(createIdealMitigationChainPatternData());
      
      if (!result) {
        console.log('REJECTION REASON:', scenario.getReason());
        console.log('LEVELS:', scenario.getLevels());
      }
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Chain');
      expect(scenario.getReason()).toContain('BOS validated');
      expect(scenario.getLevels().entry).toBeDefined();
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const data = createIdealMitigationChainPatternData();
      (data as any).currentKillzone = 'NONE';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - trend OB', () => {
    it('should reject when no valid OB in trend direction', () => {
      const data = createIdealMitigationChainPatternData();
      data.zones = [];
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No valid OB in trend direction');
    });

    it('should reject when OB is mitigated', () => {
      const data = createIdealMitigationChainPatternData();
      data.zones[0].mitigated = true;
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid OB');
    });
  });

  describe('negative cases - BOS validation', () => {
    it('should reject when OB did not produce true BOS after formation', () => {
      const data = createMitigationChainNoBosAfterOb();
      // Ensure OB is in Discount zone
      data.zones[0].top = new Decimal(101);
      data.zones[0].bottom = new Decimal(99);
      data.candles15m[5].close = '100';
      data.candles15m[5].high = '100.5';
      data.candles15m[5].low = '99.5';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('BOS');
    });
  });

  describe('negative cases - 0.5 equilibrium', () => {
it('should reject when price has not touched 0.5 of OB', () => {
      const data = createIdealMitigationChainPatternData();
      // Price far from OB equilibrium - set to 94
      data.candles15m[5].close = '94';
      data.candles15m[5].high = '95';
      data.candles15m[5].low = '93';
      // Ensure OB stays in Discount zone despite modified candle
      // With modified candle (low=93), rangeLow=93, rangeHigh=103, equilibrium=98
      // OB must be < 98 to be in Discount zone
      data.zones[0].top = new Decimal(97);
      data.zones[0].bottom = new Decimal(95);
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('0.5 (Equilibrium) of OB');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no CHoCH confirming trend direction', () => {
      const data = createIdealMitigationChainPatternData();
      // Ensure OB is in Discount zone
      data.zones[0].top = new Decimal(100);
      data.zones[0].bottom = new Decimal(98);
      data.candles15m[5].close = '99';
      data.candles15m[5].high = '100';
      data.candles15m[5].low = '98';
      data.structures = data.structures.filter(s => s.type !== 'CHOCH');
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No 15m CHoCH confirming trend direction');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const data = createIdealMitigationChainPatternData();
      // Ensure OB is in Discount zone
      data.zones[0].top = new Decimal(100);
      data.zones[0].bottom = new Decimal(98);
      data.candles15m[5].close = '99';
      data.candles15m[5].high = '100';
      data.candles15m[5].low = '98';
      data.structures = data.structures.map(s => 
        s.type === 'CHOCH' ? { ...s, impulseFactor: new Decimal(1.0) } : s
      );
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH displacement < 1.5 ATR');
    });
  });

  describe('negative cases - trend filter', () => {
    it('should reject when 4H trend is not bullish', () => {
      const data = createIdealMitigationChainPatternData();
      // Add bearish 4H structure
      data.structures.push({
        type: 'CHOCH' as const,
        direction: 'BEARISH' as const,
        price: new Decimal(100),
        timestamp: Date.now() - 3600000,
        timeframe: '240',
        isValidated: true,
        impulseFactor: new Decimal(2.0),
      } as any);
      // Also need to ensure OB is in Discount zone so Premium/Discount filter passes first
      // OB at 102/100 (mid=101) is above equilibrium (100) -> Premium zone
      // Change OB to be in Discount zone
      data.zones[0].top = new Decimal(100);
      data.zones[0].bottom = new Decimal(98);
      // Set current candle to touch OB equilibrium (99)
      data.candles15m[5].close = '99';
      data.candles15m[5].high = '100';
      data.candles15m[5].low = '98';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('4H trend not bullish');
    });
  });
});