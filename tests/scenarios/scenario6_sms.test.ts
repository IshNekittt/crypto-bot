import { Scenario6_SMS } from '../../src/engine/scenarios/Scenario6_SMS';
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
  sniperLimitExpirationCandles: 15,
  smcSweepMinWickRatio: new Decimal('0.25'),
  smartEntryThresholdPct: '0.0015',
    enableSniperMode: false,
    enableDynamicTp: false,
    fixedTpRr: new Decimal(3),
    dynamicTpMinRr: new Decimal('1.5'),
    dynamicTpMaxRr: new Decimal(6),
    dynamicTpRequireTarget: false,
    minTpDistancePct: new Decimal('0.0035'),
    backtestDays: 60,
    useLocalCacheOnly: false,
    maxWorkingCapital: 0,
    preflightBufferPct: "0.05",
    enableHealthcheckServer: false,
    allowedDaysOfWeek: [1, 2, 3, 4, 5],
    enforceKillzones: true,
    enableTradeNotifications: true,
};

describe('Scenario6: Failure Swing (SMS)', () => {
  let scenario: Scenario6_SMS;

  beforeEach(() => {
    scenario = new Scenario6_SMS(mockConfig);
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(97.5);
      const zone = { top: new Decimal(103), bottom: new Decimal(102), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(102.5);
      const zone = { top: new Decimal(103), bottom: new Decimal(102), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(97.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(99), bottom: new Decimal(101), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);
      
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(102.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(101), bottom: new Decimal(103), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');
      
      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);
      
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });

  describe('killzone bypass (ENFORCE_KILLZONES=false)', () => {
    const emptyPatternData = { currentKillzone: 'NONE', candles15m: [], structures: [], zones: [] };

    it('should reject outside killzone when enforcement is enabled (default)', () => {
      const result = scenario.evaluate(emptyPatternData);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('killzone');
    });

    it('should bypass the killzone gate when enforceKillzones=false', () => {
      const bypassScenario = new Scenario6_SMS({ ...mockConfig, enforceKillzones: false });
      const result = bypassScenario.evaluate(emptyPatternData);
      // Proceeds PAST the killzone gate and fails later on missing data — not on killzone
      expect(result).toBe(false);
      expect(bypassScenario.getReason()).not.toContain('killzone');
    });
  });
});