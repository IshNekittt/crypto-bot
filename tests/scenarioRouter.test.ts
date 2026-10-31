import { ScenarioRouter, REGISTERED_SCENARIO_IDS } from '../src/engine/scenarioRouter';
import { IScenario } from '../src/types';
import { BotConfig } from '../src/config/env';
import { Decimal } from 'decimal.js';

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
  activeScenarios: [12],
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
    minNetRr: new Decimal(1),
    minVolatilityFeeRatio: new Decimal(1),
    minTpDistancePct: new Decimal('0.0035'),
    backtestDays: 60,
    useLocalCacheOnly: false,
    maxWorkingCapital: 0,
    preflightBufferPct: "0.05",
    enableHealthcheckServer: false,
    // All days allowed so deterministic router tests (Date.now()) never depend on the run day.
    // Day-of-week filtering itself is covered by dedicated tests below.
    allowedDaysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    enforceKillzones: true,
    enableTradeNotifications: true,
};

const mockNotifier = {
  enabled: true,
  sendMessage: jest.fn().mockResolvedValue(true),
};

const mockPatternRecognizer = {
  buildPatternData: jest.fn().mockResolvedValue({
    currentKillzone: 'LONDON',
    currentSession: 'LONDON',
    candles15m: [],
    candles4h: [],
    zones: [],
    structures: [],
    liquidityPools: [],
    sessionRanges: [],
    tradingRange: null,
    atr15m: 0.5,
    atr4h: 1.0,
    macroContext: {},
  }),
};

describe('ScenarioRouter', () => {
  let router: ScenarioRouter;

  beforeEach(() => {
    process.env.ACTIVE_SCENARIOS = '12,14,15';
    router = new ScenarioRouter({
      symbol: 'SOLUSDT',
      patternRecognizer: mockPatternRecognizer,
      notifier: mockNotifier,
      activeScenarios: [12, 14, 15],
      config: mockConfig,
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ACTIVE_SCENARIOS;
  });

  describe('scenario registration', () => {
    it('registers the five live scenarios in registry order', () => {
      const defaultRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: mockPatternRecognizer,
        notifier: mockNotifier,
        activeScenarios: [],
        config: mockConfig,
      });
      const scenarios = (defaultRouter as any).scenarios;
      expect(scenarios.length).toBe(5);
      expect(scenarios.map((s: IScenario) => s.id)).toEqual([1, 5, 12, 14, 15]);
      expect(scenarios.map((s: IScenario) => s.name)).toEqual([
        'HTF Continuation',
        'HTF Liquidity Sweep',
        'Sniper Touch (1m Macro)',
        'Trend Following Alpha (Donchian / Volume Breakout)',
        'Volatility Compression Squeeze (BB/KC)',
      ]);
    });

    it('exposes the registry as the single source of truth', () => {
      expect(REGISTERED_SCENARIO_IDS).toEqual([1, 5, 12, 14, 15]);
    });

    it('does not register the archived Scenarios 2–4, 6–11 or 13', () => {
      const archivedRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: mockPatternRecognizer,
        notifier: mockNotifier,
        activeScenarios: [13],
        config: { ...mockConfig, activeScenarios: [13] },
      });

      // Scenario 13 was archived: the router simply has nothing to evaluate.
      expect((archivedRouter as any).scenarios).toHaveLength(0);
    });

    it('ignores archived ids without dropping the registered scenarios', () => {
      // A stale .env listing a partially archived profile must not silently
      // disarm a live process: the ids that still exist are kept, the rest are
      // reported. `loadConfig()` rejects the same input outright; this branch is
      // the router-level backstop for callers that skip config validation.
      const mixedRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: mockPatternRecognizer,
        notifier: mockNotifier,
        activeScenarios: [1, 4, 5, 9, 12],
        config: { ...mockConfig, activeScenarios: [1, 4, 5, 9, 12] },
      });

      expect((mixedRouter as any).scenarios.map((s: IScenario) => s.id)).toEqual([1, 5, 12]);
    });

    it('defaults to the full registered registry when no ids are configured', () => {
      const defaultRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: mockPatternRecognizer,
        notifier: mockNotifier,
        activeScenarios: [],
        config: mockConfig,
      });

      expect((defaultRouter as any).scenarios.map((s: IScenario) => s.id)).toEqual([1, 5, 12, 14, 15]);
    });
  });

  describe('evaluation order and priority', () => {
    it('should evaluate scenarios in registration order', async () => {
      
      const mockScenarios = [
        { id: 1, name: 'Test1', evaluate: jest.fn().mockReturnValue(false), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test1 reason', getZoneDetails: () => null, getStructureDetails: () => null },
        { id: 2, name: 'Test2', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test2 reason', getZoneDetails: () => null, getStructureDetails: () => null },
        { id: 3, name: 'Test3', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test3 reason', getZoneDetails: () => null, getStructureDetails: () => null },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockResolvedValue({
            structures: [
              { type: 'CHoCH', direction: 'BULLISH', timestamp: Date.now(), price: '100', isValidated: true, impulseFactor: 2 },
              { type: 'SMS', direction: 'BEARISH', timestamp: Date.now() - 3600000, price: '105' },
            ],
            zones: [],
            liquidityPools: [{ type: 'PDH', priceLevel: '105' }, { type: 'PDL', priceLevel: '95' }],
            currentKillzone: 'NY',
          }),
        },
        notifier: mockNotifier,
        activeScenarios: [12],
        config: mockConfig,
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(true);
      expect(result.scenario?.id).toBe(2);
      expect(mockScenarios[0].evaluate).toHaveBeenCalledTimes(1);
      expect(mockScenarios[1].evaluate).toHaveBeenCalledTimes(1);
      expect(mockScenarios[2].evaluate).not.toHaveBeenCalled();
    });

    it('should return first matching scenario when multiple match', async () => {
      const mockScenarios = [
        { id: 5, name: 'Scenario5', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Scenario5 reason', getZoneDetails: () => null, getStructureDetails: () => null },
        { id: 1, name: 'Scenario1', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Scenario1 reason', getZoneDetails: () => null, getStructureDetails: () => null },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockResolvedValue({
            structures: [
              { type: 'CHoCH', direction: 'BULLISH', timestamp: Date.now(), price: '100', isValidated: true, impulseFactor: 2 },
              { type: 'SMS', direction: 'BEARISH', timestamp: Date.now() - 3600000, price: '105' },
            ],
            zones: [],
            liquidityPools: [{ type: 'PDH', priceLevel: '105' }, { type: 'PDL', priceLevel: '95' }],
            currentKillzone: 'NY',
          }),
        },
        notifier: mockNotifier,
        activeScenarios: [12],
        config: mockConfig,
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(true);
      expect(result.scenario?.id).toBe(5);
    });
  });

  describe('no match scenarios', () => {
    it('should return null scenario when no scenario matches', async () => {
      const mockScenarios = [
        { id: 1, name: 'Test1', evaluate: jest.fn().mockReturnValue(false) },
        { id: 2, name: 'Test2', evaluate: jest.fn().mockReturnValue(false) },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: { buildPatternData: jest.fn().mockResolvedValue({}) },
        notifier: mockNotifier,
        activeScenarios: [12],
        config: mockConfig,
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(false);
      expect(result.scenario).toBeNull();
      expect(result.reason).toBe('No scenario matched');
    });

    it('should return error when pattern recognition fails', async () => {
      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockRejectedValue(new Error('API Error')),
        },
        notifier: mockNotifier,
        activeScenarios: [12],
        config: mockConfig,
      });

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('Pattern recognition error');
    });
  });

  describe('pattern recognizer integration', () => {
    it('should call buildPatternData with correct parameters', async () => {
      const candles15m = [{ timestamp: 1, open: '100', high: '101', low: '99', close: '100', volume: '100' }];
      const candles4h = [{ timestamp: 1, open: '100', high: '101', low: '99', close: '100', volume: '100' }];

      await router.evaluate(candles15m, candles4h, Date.now());

      expect(mockPatternRecognizer.buildPatternData).toHaveBeenCalledWith('SOLUSDT', candles15m, candles4h, expect.any(Number));
    });
  });

  describe('day-of-week filter', () => {
    // Fixed UTC timestamps: Saturday 2026-10-17 12:00 UTC / Sunday 2026-10-18 12:00 UTC / Monday 2026-10-19 12:00 UTC
    const SATURDAY_TS = 1792238400000;
    const SUNDAY_TS = 1792324800000;
    const MONDAY_TS = 1792411200000;

    const buildRouter = (allowedDays: number[]) => {
      const dayConfig: BotConfig = { ...mockConfig, allowedDaysOfWeek: allowedDays };
      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: { buildPatternData: jest.fn().mockResolvedValue({}) },
        notifier: mockNotifier,
        activeScenarios: [12],
        config: dayConfig,
      });
      const mockScenarios = [
        { id: 1, name: 'Test1', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test1 reason', getZoneDetails: () => null, getStructureDetails: () => null },
      ] as unknown as IScenario[];
      (testRouter as any).scenarios = mockScenarios;
      return { testRouter, mockScenarios };
    };

    it('should block new entries on Saturday when only weekdays are allowed', async () => {
      const { testRouter, mockScenarios } = buildRouter([1, 2, 3, 4, 5]);

      const result = await testRouter.evaluate([], [], SATURDAY_TS);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('Day-of-week filter');
      expect(mockScenarios[0].evaluate).not.toHaveBeenCalled();
    });

    it('should block new entries on Sunday when only weekdays are allowed', async () => {
      const { testRouter, mockScenarios } = buildRouter([1, 2, 3, 4, 5]);

      const result = await testRouter.evaluate([], [], SUNDAY_TS);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('Day-of-week filter');
      expect(mockScenarios[0].evaluate).not.toHaveBeenCalled();
    });

    it('should evaluate scenarios normally on allowed weekdays', async () => {
      const { testRouter, mockScenarios } = buildRouter([1, 2, 3, 4, 5]);

      const result = await testRouter.evaluate([], [], MONDAY_TS);

      expect(result.triggered).toBe(true);
      expect(mockScenarios[0].evaluate).toHaveBeenCalledTimes(1);
    });

    it('should allow weekend entries when all 7 days are configured', async () => {
      const { testRouter, mockScenarios } = buildRouter([1, 2, 3, 4, 5, 6, 7]);

      const result = await testRouter.evaluate([], [], SATURDAY_TS);

      expect(result.triggered).toBe(true);
      expect(mockScenarios[0].evaluate).toHaveBeenCalledTimes(1);
    });
  });
});
describe('ScenarioRouter — per-symbol calibration', () => {
  const buildRouter = (symbol: string, config: BotConfig) =>
    new ScenarioRouter({
      symbol,
      patternRecognizer: mockPatternRecognizer,
      notifier: mockNotifier,
      activeScenarios: [12],
      config,
    });

  it('hands the symbol-resolved config to the scenarios it owns', () => {
    // The router is the single resolution point: whatever it holds is what
    // Scenario 12 reads for MIN_TP_DISTANCE_PCT, wick ratio, SL offset and the
    // dynamic-TP floor.
    const config: BotConfig = {
      ...mockConfig,
      symbolOverrides: new Map([
        [
          'APTUSDT',
          {
            minTpDistancePct: new Decimal('0.006'),
            minNetRr: new Decimal('1.2'),
            minVolatilityFeeRatio: new Decimal('1.3'),
            smcSweepMinWickRatio: new Decimal('0.18'),
            smcSlAtrOffset: '0.75',
            dynamicTpMinRr: new Decimal('2'),
            sniperLimitExpirationCandles: 25,
          },
        ],
      ]),
    };

    const apt = (buildRouter('APTUSDT', config) as any).config;
    expect(apt.minTpDistancePct.toString()).toBe('0.006');
    expect(apt.minNetRr.toString()).toBe('1.2');
    expect(apt.minVolatilityFeeRatio.toString()).toBe('1.3');
    expect(apt.smcSweepMinWickRatio.toString()).toBe('0.18');
    expect(apt.smcSlAtrOffset).toBe('0.75');
    expect(apt.dynamicTpMinRr.toString()).toBe('2');
    expect(apt.sniperLimitExpirationCandles).toBe(25);

    // A sibling symbol keeps the global calibration — no cross-asset bleed.
    const near = (buildRouter('NEARUSDT', config) as any).config;
    expect(near.minTpDistancePct.toString()).toBe('0.0035');
    expect(near.smcSweepMinWickRatio.toString()).toBe('0.25');
    expect(near.smcSlAtrOffset).toBe('0.5');
    expect(near.dynamicTpMinRr.toString()).toBe('1.5');
    expect(near.sniperLimitExpirationCandles).toBe(15);
  });
});
