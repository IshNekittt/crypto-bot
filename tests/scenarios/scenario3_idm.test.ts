import { Scenario3_IDM } from '../../src/engine/scenarios/Scenario3_IDM';
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
};

describe('Scenario3: Inducement (IDM)', () => {
  let scenario: Scenario3_IDM;

  beforeEach(() => {
    scenario = new Scenario3_IDM(mockConfig);
  });

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasIdmSweep: boolean;
    hasRealOb: boolean;
    priceTestsOb: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasIdmSweep: overrides.hasIdmSweep !== false,
      hasRealOb: overrides.hasRealOb !== false,
      priceTestsOb: overrides.priceTestsOb !== false,
    };

    const now = Date.now();
    const recentLowSweep = config.hasIdmSweep ? {
      type: 'CHOCH', direction: 'BULLISH',
      brokenSwing: { type: 'LOW', price: new Decimal(100), timestamp: now - 2 * 60 * 60 * 1000, index: 10, isSwept: false },
    } : null;

    const realOb = config.hasRealOb ? {
      type: 'OB', direction: 'BULLISH', top: new Decimal(99.5), bottom: new Decimal(99),
      timestamp: now - 100000, mitigated: false, invalidated: false,
    } : null;

    const lastCandle = {
      timestamp: now,
      close: config.priceTestsOb ? '99.2' : '95',
      high: config.priceTestsOb ? '100' : '96',
      low: config.priceTestsOb ? '98.5' : '94',
      open: '99', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      currentSession: 'LONDON',
      candles15m: [lastCandle],
      zones: realOb ? [realOb] : [],
      structures: recentLowSweep ? [recentLowSweep] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario3_IDM(mockConfig);
  });

  describe('positive cases', () => {
    it('should trigger when all conditions are met', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('IDM');
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

  describe('negative cases - IDM sweep', () => {
    it('should reject when no IDM sweep detected', () => {
      const result = scenario.evaluate(createMockPatternData({ hasIdmSweep: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No IDM sweep detected');
    });
  });

  describe('negative cases - real OB', () => {
    it('should reject when no real OB below swept low', () => {
      const result = scenario.evaluate(createMockPatternData({ hasRealOb: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No real OB below swept low');
    });
  });

  describe('negative cases - OB test', () => {
    it('should reject when price not testing real OB', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTestsOb: false }));
      expect(result).toBe(false);
      // The real OB exists, so the rejection should be about price not testing
      expect(scenario.getReason()).toBe('Price not testing real OB after IDM sweep');
    });
  });
});