import { Scenario2_FVGFill } from '../../src/engine/scenarios/Scenario2_FVGFill';
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
    maxWorkingCapital: 0,
};

describe('Scenario2: FVG Fill', () => {
  let scenario: Scenario2_FVGFill;

  beforeEach(() => {
    scenario = new Scenario2_FVGFill(mockConfig);
  });

  /**
   * Creates IDEAL synthetic pattern data for FVG Fill:
   * - HTF (4H) BULLISH FVG formed 15 candles ago
   * - 10-15 candles BEFORE FVG: liquidity sweep + CHoCH/BOS (confluence)
   * - Current candle: price at FVG 0.5 (equilibrium)
   * - Fresh 15m BULLISH CHoCH with displacement >= 1.5 ATR
   * - 4H trend is BULLISH (BOS present, no BEARISH)
   */
  const createIdealFvgFillPatternData = () => {
    const FIXED_NOW = 1788675600000; // 2026-09-06 03:00 UTC (LONDON killzone)
    const FVG_TIME = FIXED_NOW - 15 * 900000; // 15 candles ago (225 min ago)

    // HTF FVG (4H): top=100, bottom=98, eq=99 (in Discount zone)
    const htfFvg = {
      type: 'FVG' as const,
      direction: 'BULLISH' as const,
      top: new Decimal(100),
      bottom: new Decimal(98),
      timestamp: FVG_TIME,
      mitigated: false,
      timeframe: '240',
    };

    // Create 30 candles: 15 before FVG, 15 after FVG
    // Candles 0-14: before FVG formation
    // Candle 5 (index 5): LIQUIDITY SWEEP (wick below level, close back inside)
    // Candle 7 (index 7): CHoCH/BOS confirming direction
    // Candle 15 (index 15): FVG formation (timestamp = FVG_TIME)
    // Candles 16-29: after FVG
    // Current candle (index 29): price at FVG equilibrium (99)
    const candles15m: any[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = FIXED_NOW - (29 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volume: '1000',
      });
    }

    // Candle 5 (index 5): LIQUIDITY SWEEP at ~100 min before FVG
    // Wick below 98, close back above 98
    candles15m[5] = {
      ...candles15m[5],
      timestamp: FIXED_NOW - 24 * 900000,
      high: '101',
      low: '97.5', // wicked below 98
      close: '98.5', // closed back above 98
      open: '100',
    };

    // Candle 7 (index 7): BOS confirming bullish direction
    candles15m[7] = {
      ...candles15m[7],
      timestamp: FIXED_NOW - 22 * 900000,
      high: '101',
      low: '99',
      close: '100.5', // bullish close
      open: '100',
    };

    // FVG formation candle (index 15) - this creates the FVG
    // FVG: gap between candle 14 high and candle 16 low
    // Candle 14: high=101, Candle 16: low=99 -> FVG 99-101
    // But we already have htfFvg with top=100, bottom=98, so let's align
    candles15m[14] = {
      ...candles15m[14],
      timestamp: FVG_TIME + 900000, // 1 candle after FVG
      high: '101',
      low: '99',
      close: '100',
    };
    candles15m[15] = { // FVG formation candle (4H candle)
      ...candles15m[15],
      timestamp: FVG_TIME,
      high: '100',
      low: '98',
      close: '99',
      open: '99',
    };
    candles15m[16] = {
      ...candles15m[16],
      timestamp: FVG_TIME - 900000, // 1 candle before FVG
      high: '101',
      low: '99',
      close: '100',
    };

    // Current candle (index 29): price at FVG equilibrium (99)
    const eq = htfFvg.top.plus(htfFvg.bottom).dividedBy(2); // 99
    candles15m[29] = {
      timestamp: FIXED_NOW,
      high: (eq.plus(0.5)).toFixed(2),
      low: (eq.minus(0.5)).toFixed(2),
      close: eq.toFixed(2), // exactly at equilibrium
      open: '99',
      volume: '1000',
    };

    // 15m CHoCH after FVG touch (current candle area)
    const choch = {
      type: 'CHOCH' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(99),
      timestamp: FIXED_NOW - 500, // very recent
      isValidated: true,
      impulseFactor: new Decimal(2.0), // > 1.5
    };

    // 4H structures: BULLISH BOS (trend confirmation)
    const bos4h = {
      type: 'BOS' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(100),
      timestamp: FIXED_NOW - 2 * 60 * 60 * 1000, // 2 hours ago
      timeframe: '240',
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    // Liquidity pools: one sweep pool (taken)
    const sweepPool = {
      type: 'SSL' as const,
      priceLevel: new Decimal(98),
      timestamp: FIXED_NOW - 24 * 900000, // same as sweep candle
      isTaken: true,
      points: [],
    };

    return {
      currentKillzone: 'LONDON' as const,
      currentSession: 'LONDON' as const,
      candles15m,
      zones: [htfFvg],
      structures: [choch, bos4h],
      liquidityPools: [sweepPool],
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
   * Creates FVG Fill pattern WITHOUT liquidity context (should reject)
   */
  const createFvgFillNoLiquidityContext = () => {
    const FIXED_NOW = 1788675600000;
    const FVG_TIME = FIXED_NOW - 15 * 900000;

    const htfFvg = {
      type: 'FVG' as const,
      direction: 'BULLISH' as const,
      top: new Decimal(100),
      bottom: new Decimal(98),
      timestamp: FVG_TIME,
      mitigated: false,
      timeframe: '240',
    };

    const candles15m: any[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = FIXED_NOW - (29 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volume: '1000',
      });
    }

    // NO sweep, NO CHoCH/BOS before FVG - just random candles

    // Current candle at FVG equilibrium
    const eq = htfFvg.top.plus(htfFvg.bottom).dividedBy(2); // 99
    candles15m[29] = {
      timestamp: FIXED_NOW,
      high: (eq.plus(0.5)).toFixed(2),
      low: (eq.minus(0.5)).toFixed(2),
      close: eq.toFixed(2),
      open: '99',
      volume: '1000',
    };

    const choch = {
      type: 'CHOCH' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(99),
      timestamp: FIXED_NOW - 500,
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    const bos4h = {
      type: 'BOS' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(100),
      timestamp: FIXED_NOW - 2 * 60 * 60 * 1000,
      timeframe: '240',
      isValidated: true,
      impulseFactor: new Decimal(2.0),
    };

    return {
      currentKillzone: 'LONDON' as const,
      currentSession: 'LONDON' as const,
      candles15m,
      zones: [htfFvg],
      structures: [choch, bos4h],
      liquidityPools: [], // NO liquidity context
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
    scenario = new Scenario2_FVGFill(mockConfig);
  });

  describe('SYNTHETIC TEST - Ideal FVG Fill Pattern', () => {
    it('should trigger on perfect FVG Fill: HTF FVG + liquidity context + CHoCH', () => {
      const result = scenario.evaluate(createIdealFvgFillPatternData());

      if (!result) {
        console.log('REJECTION REASON:', scenario.getReason());
        console.log('LEVELS:', scenario.getLevels());
      }

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('FVG Fill');
      expect(scenario.getReason()).toContain('Premium/Discount');
      expect(scenario.getLevels().entry).toBeDefined();
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const data = createIdealFvgFillPatternData();
      (data as any).currentKillzone = 'NONE';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - HTF FVG', () => {
    it('should reject when no HTF FVG found', () => {
      const data = createIdealFvgFillPatternData();
      data.zones = [];
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No HTF FVG found');
    });
  });

  describe('negative cases - 0.5 equilibrium', () => {
    it('should reject when price has not touched 0.5 of HTF FVG', () => {
      const data = createIdealFvgFillPatternData();
      data.candles15m[29].close = '70'; // far from eq
      data.candles15m[29].high = '71';
      data.candles15m[29].low = '69';
      // Ensure FVG stays in Discount zone despite modified candle
      // With modified candle (low=69), rangeLow=69, rangeHigh=102, equilibrium=85.5
      // FVG at 82/80 (mid=81) is < 85.5 -> Discount zone
      data.zones[0].top = new Decimal(82);
      data.zones[0].bottom = new Decimal(78);
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('0.5 (Equilibrium) of HTF FVG');
    });
  });

  describe('negative cases - liquidity context', () => {
    it('should reject when no liquidity context (sweep/CHoCH/BOS) before FVG', () => {
      const result = scenario.evaluate(createFvgFillNoLiquidityContext());
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('liquidity context');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no 15m CHoCH after FVG touch', () => {
      const data = createIdealFvgFillPatternData();
      // Ensure FVG is in Discount zone
      data.zones[0].top = new Decimal(100);
      data.zones[0].bottom = new Decimal(98);
      const eq = data.zones[0].top.plus(data.zones[0].bottom).dividedBy(2);
      data.candles15m[29].close = eq.toFixed(2);
      data.candles15m[29].high = (eq.plus(0.5)).toFixed(2);
      data.candles15m[29].low = (eq.minus(0.5)).toFixed(2);
      data.structures = data.structures.filter(s => s.type !== 'CHOCH');
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No 15m CHoCH after FVG touch');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const data = createIdealFvgFillPatternData();
      // Ensure FVG is in Discount zone
      data.zones[0].top = new Decimal(100);
      data.zones[0].bottom = new Decimal(98);
      const eq = data.zones[0].top.plus(data.zones[0].bottom).dividedBy(2);
      data.candles15m[29].close = eq.toFixed(2);
      data.candles15m[29].high = (eq.plus(0.5)).toFixed(2);
      data.candles15m[29].low = (eq.minus(0.5)).toFixed(2);
      data.structures = data.structures.map(s =>
        s.type === 'CHOCH' ? { ...s, impulseFactor: new Decimal(1.0) } : s
      );
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('15m CHoCH displacement < 1.5 ATR');
    });
  });

  describe('negative cases - trend filter', () => {
    it('should reject when 4H trend is not bullish', () => {
      const data = createIdealFvgFillPatternData();
      // Add bearish 4H structure - need to use type assertion to avoid TS error
      data.structures.push({
        type: 'CHOCH' as const,
        direction: 'BEARISH' as const,
        price: new Decimal(100),
        timestamp: Date.now() - 3600000,
        timeframe: '240',
        isValidated: true,
        impulseFactor: new Decimal(2.0),
      } as any);
      // Also ensure FVG is in Discount zone so Premium/Discount filter passes first
      // candles range: high=102, low=98 -> equilibrium=100
      // FVG needs to be < 100 for Discount zone
      data.zones[0].top = new Decimal(100);
      data.zones[0].bottom = new Decimal(98);
      // Update current candle to touch new FVG equilibrium (99)
      const eq = data.zones[0].top.plus(data.zones[0].bottom).dividedBy(2);
      data.candles15m[29].close = eq.toFixed(2);
      data.candles15m[29].high = (eq.plus(0.5)).toFixed(2);
      data.candles15m[29].low = (eq.minus(0.5)).toFixed(2);
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('4H trend not bullish');
    });
  });
});