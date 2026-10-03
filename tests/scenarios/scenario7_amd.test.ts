import { Scenario7_AMD } from '../../src/engine/scenarios/Scenario7_AMD';
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

describe('Scenario7: AMD (Accumulation-Manipulation-Distribution)', () => {
  let scenario: Scenario7_AMD;

  beforeEach(() => {
    scenario = new Scenario7_AMD(mockConfig);
  });

  /**
   * Creates IDEAL synthetic pattern data for AMD scenario:
   * - Asian Range during 20:00-24:00 NY time (tight, < 1.5*ATR4H)
   * - London Killzone (02:00-05:00 NY)
   * - Asian Low sweep with SFP (wick below, close above)
   * - BULLISH CHoCH within 8H after sweep with 1.5+ ATR displacement
   * - BULLISH FVG after CHoCH within 8H
   */
  const createIdealAmdPatternData = () => {
    // Use a fixed timestamp that falls in LONDON killzone (02:00-05:00 NY)
    // 2026-09-06 03:00:00 UTC = 2026-09-05 23:00 EDT (NY time) -> actually need London time
    // London killzone is 02:00-05:00 NY = 06:00-09:00 UTC
    const FIXED_NOW = 1788675600000; // 2026-09-06 03:00:00 UTC (in London killzone)
    
    // Asian session: 20:00-24:00 NY = 00:00-04:00 UTC (next day)
    // But we need the Asian session BEFORE the London session
    // So Asian session was 2026-09-05 20:00-24:00 NY = 2026-09-06 00:00-04:00 UTC
    const asianRangeStart = FIXED_NOW - 7 * 60 * 60 * 1000; // 7 hours before = 20:00 NY previous day
    const asianRangeEnd = FIXED_NOW - 3 * 60 * 60 * 1000;   // 3 hours before = 24:00 NY previous day

    // Asian Range: tight consolidation (height < 1.5 * ATR4H)
    // ATR4H = 10, so max height = 15. Let's make range 99-105 (height = 6)
    const asianRange = {
      name: 'ASIAN' as const,
      high: new Decimal(105),
      low: new Decimal(99),
      start: asianRangeStart,
      end: asianRangeEnd,
    };

    // Create candles in the check window (last 8 candles = 2 hours)
    const candles15m: any[] = [];
    for (let i = 0; i < 8; i++) {
      const ts = FIXED_NOW - (7 - i) * 900000; // 15 min intervals going back 2 hours
      candles15m.push({
        timestamp: ts,
        open: '100',
        high: '101',
        low: '100.5', // Above Asian Low (99)
        close: '100',
        volume: '1000',
      });
    }

    // Sweep candle (index 3 = 4th candle back): wicked below Asian Low (99), closed above
    // Asian Low = 99, sweepTolerance = 2 * ATR15m = 2 * 0.5 = 1.0
    // So wicked below 99 + 1 = 100. Close above 99 - 1 = 98
    candles15m[3].low = '97.5'; // Wicked below 98 (Asian Low - tolerance)
    candles15m[3].close = '99.2'; // Closed above 98

    // Sweep time = candle 3 timestamp
    const sweepTime = candles15m[3].timestamp;
    const chochTime = sweepTime + 2 * 60 * 60 * 1000; // 2 hours after sweep (within 8H)

    // CHoCH with 2.0 ATR displacement (impulseFactor > 1.5)
    const choch = {
      type: 'CHOCH' as const,
      direction: 'BULLISH' as const,
      price: new Decimal(100),
      timestamp: chochTime,
      isValidated: true,
      impulseFactor: new Decimal(2.0), // > 1.5
    };

    // FVG after CHoCH (within 8H)
    const fvgTime = chochTime + 900000; // 15 min after CHoCH
    const freshFvg = {
      type: 'FVG' as const,
      direction: 'BULLISH' as const,
      top: new Decimal(102),
      bottom: new Decimal(100.5),
      timestamp: fvgTime,
      mitigated: false,
      timeframe: '15',
    };

    return {
      currentKillzone: 'LONDON' as const,
      currentSession: 'LONDON' as const,
      candles15m,
      sessionRanges: [asianRange],
      structures: [choch],
      zones: [freshFvg],
      atr15m: new Decimal('0.5'),
      atr4h: new Decimal('10'), // Asian range height = 6, 1.5*ATR4H = 15 > 6 ✓
    };
  };

  beforeEach(() => {
    scenario = new Scenario7_AMD(mockConfig);
  });

  describe('SYNTHETIC TEST - Ideal AMD Pattern', () => {
    it('should trigger on perfect AMD setup: Asian Range + Sweep + CHoCH + FVG', () => {
      const result = scenario.evaluate(createIdealAmdPatternData());
      
      if (!result) {
        console.log('REJECTION REASON:', scenario.getReason());
        console.log('LEVELS:', scenario.getLevels());
      }
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('AMD');
      expect(scenario.getLevels().entry).toBeDefined();
      expect(scenario.getLevels().takeProfit).toBeDefined();
      expect(parseFloat(scenario.getLevels().takeProfit.toString())).toBe(105); // Asian High
    });
  });

  // Keep existing negative case tests...
  describe('negative cases - killzone', () => {
    it('should reject when killzone is ASIAN', () => {
      const data = createIdealAmdPatternData();
      (data as any).currentKillzone = 'ASIAN';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });

    it('should reject when killzone is NONE', () => {
      const data = createIdealAmdPatternData();
      (data as any).currentKillzone = 'NONE';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });
  });

  describe('negative cases - Asian Range width', () => {
    it('should reject when Asian Range too wide (> 3.0*ATR4H)', () => {
      const data = createIdealAmdPatternData();
      // Make range wider: high=120, low=90 (height=30), ATR4H=10 -> 3.0*ATR4H=30, 30>30 is false
      // Need even wider: high=130, low=90 (height=40), ATR4H=10 -> 3.0*ATR4H=30, 40>30
      data.sessionRanges[0].high = new Decimal(130);
      data.sessionRanges[0].low = new Decimal(90);
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('too wide');
    });
  });

  describe('negative cases - Asian Low sweep', () => {
    it('should reject when Asian Low not swept', () => {
      const data = createIdealAmdPatternData();
      // Remove sweep - make all candles above Asian Low
      data.candles15m.forEach(c => {
        c.low = '101';
        c.close = '100';
      });
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('swept');
    });
  });

  describe('negative cases - CHoCH', () => {
    it('should reject when no bullish CHoCH after sweep', () => {
      const data = createIdealAmdPatternData();
      data.structures = [];
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const data = createIdealAmdPatternData();
      data.structures[0].impulseFactor = new Decimal(1.0); // < 1.5
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH after Asian Low sweep displacement < 1.5 ATR');
    });
  });

  describe('negative cases - FVG', () => {
    it('should reject when no fresh bullish FVG after CHoCH', () => {
      const data = createIdealAmdPatternData();
      data.zones = [];
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('FVG');
    });
  });
});