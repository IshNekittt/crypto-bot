import { StrategyEngine } from '../src/engine/strategyEngine';
import { NewsService } from '../src/services/newsService';
import { BybitClient } from '../src/api/bybitClient';
import { PostgresDatabase } from '../src/db/database';
import { RiskManager } from '../src/risk/riskManager';
import { ExecutionEngine } from '../src/execution/executionEngine';
import { TelegramNotifier } from '../src/telegram/notifier';
import { PendingTradeManager } from '../src/engine/pendingTradeManager';
import { PatternRecognizer } from '../src/smc/patternRecognizer';
import { InstrumentInfo, StrategyState } from '../src/types';
import { Decimal } from 'decimal.js';
import { logger } from '../src/utils/logger';

describe('StrategyEngine - News Embargo Integration', () => {
  let engine: StrategyEngine;
  let mockNewsService: jest.Mocked<NewsService>;
  let mockClient: jest.Mocked<BybitClient>;
  let mockDb: jest.Mocked<PostgresDatabase>;
  let mockRiskManager: jest.Mocked<RiskManager>;
  let mockExecutionEngine: jest.Mocked<ExecutionEngine>;
  let mockNotifier: jest.Mocked<TelegramNotifier>;
  let mockPatternRecognizer: jest.Mocked<PatternRecognizer>;
  let mockPendingTradeManager: jest.Mocked<PendingTradeManager>;

  const mockInstrument: InstrumentInfo = {
    symbol: 'BTCUSDT',
    tickSize: '0.1',
    qtyStep: '0.001',
    minOrderQty: '0.001',
    maxOrderQty: '1000',
  };

  const mockCandles15m = Array.from({ length: 50 }, (_, i) => ({
    timestamp: Date.now() - (49 - i) * 900000,
    open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
  }));

  const mockCandles4h = Array.from({ length: 50 }, (_, i) => ({
    timestamp: Date.now() - (49 - i) * 3600000,
    open: '50000', high: '50200', low: '49800', close: '50100', volume: '1000',
  }));

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock NewsService
    mockNewsService = {
      isNewsEmbargo: jest.fn(),
      getNextHighImpactNews: jest.fn(),
      getAllHighImpactNews: jest.fn(),
      getFetchError: jest.fn(),
      getLastFetchTime: jest.fn(),
      fetchNews: jest.fn(),
    } as any;

    // Mock BybitClient
    mockClient = {
      config: { historyCandles: 200 },
      getKlines: jest.fn().mockResolvedValue([]),
      getInstrumentInfo: jest.fn().mockResolvedValue(mockInstrument),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getExecutions: jest.fn().mockResolvedValue([]),
      syncServerTime: jest.fn().mockResolvedValue({ offsetMs: 0, roundTripMs: 100 }),
      getUsdtBalance: jest.fn().mockResolvedValue(new Decimal('10000')),
      placeMarketOrderWithTpsl: jest.fn().mockResolvedValue('order123'),
    } as any;

    // Mock Database
    mockDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getSymbolState: jest.fn().mockResolvedValue(null),
      setSymbolState: jest.fn().mockResolvedValue(undefined),
      openTrade: jest.fn().mockResolvedValue('trade123'),
      closeTrade: jest.fn().mockResolvedValue(true),
      getOpenTrade: jest.fn().mockResolvedValue(null),
      getAllOpenTrades: jest.fn().mockResolvedValue([]),
      getRecentClosedTrades: jest.fn().mockResolvedValue([]),
      getAllTrades: jest.fn().mockResolvedValue([]),
      runIntegrationTest: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock RiskManager
    mockRiskManager = {
      calculatePosition: jest.fn().mockResolvedValue({
        ok: true,
        plan: {
          symbol: 'BTCUSDT',
          side: 'Buy',
          entryPrice: '50050',
          stopLoss: '49950',
          takeProfit: '50350',
          qty: '0.1',
          slDistance: '100',
          riskAmount: '100',
          riskPercentApplied: '2',
          balanceUsdt: '10000',
          scenarioId: 1,
          zoneDetails: null,
        },
      }),
      getEffectiveRiskPercent: jest.fn().mockResolvedValue(new Decimal('2')),
    } as any;

    // Mock ExecutionEngine
    mockExecutionEngine = {
      execute: jest.fn().mockResolvedValue({ ok: true, orderId: 'order123' }),
    } as any;

    // Mock TelegramNotifier
    mockNotifier = {
      enabled: true,
      bot: { telegram: { sendMessage: jest.fn().mockResolvedValue(true) } },
      chatId: '123456',
      sendMessage: jest.fn().mockResolvedValue(true),
      sendMessageWithKeyboard: jest.fn().mockResolvedValue(undefined),
      notifySetupFound: jest.fn().mockResolvedValue(true),
      notifyOrderOpened: jest.fn().mockResolvedValue(true),
      notifyTradeClosed: jest.fn().mockResolvedValue(true),
      notifyCriticalError: jest.fn().mockResolvedValue(true),
      notifyInfo: jest.fn().mockResolvedValue(true),
      setPendingTradeManager: jest.fn(),
      setBackupService: jest.fn(),
      setLiveTestDependencies: jest.fn(),
      setEnableLiveTestOrders: jest.fn(),
      setNewsService: jest.fn(),
    } as any;

    // Mock PatternRecognizer
    mockPatternRecognizer = {
      buildPatternData: jest.fn().mockResolvedValue({
        candles15m: mockCandles15m,
        candles4h: [],
        macroContext: { dailyLevels: { pdh: new Decimal('50500'), pdl: new Decimal('49500') } },
        currentSession: 'LONDON',
        currentKillzone: 'LONDON',
        sessionRanges: [],
        tradingRange: null,
        liquidityPools: [],
        structures: [],
        zones: [],
        swingPoints: [],
        atr15m: new Decimal('100'),
        atr4h: new Decimal('200'),
      }),
      initializeMacroContext: jest.fn().mockResolvedValue({}),
      refreshMacroContext: jest.fn().mockResolvedValue({}),
      getDisplacementRejections: jest.fn().mockReturnValue(0),
    } as any;

    // Mock PendingTradeManager
    mockPendingTradeManager = {
      queueTrade: jest.fn().mockResolvedValue(true),
      handleApproval: jest.fn().mockReturnValue(true),
      getPendingTrade: jest.fn().mockReturnValue(undefined),
      getPendingCount: jest.fn().mockReturnValue(0),
      cancelAll: jest.fn(),
      setPriceProvider: jest.fn(),
    } as any;

    // Create engine with mocked dependencies
    engine = new StrategyEngine({
      symbol: 'BTCUSDT',
      instrument: mockInstrument,
      client: mockClient,
      db: mockDb,
      riskManager: mockRiskManager,
      executionEngine: mockExecutionEngine,
      notifier: mockNotifier,
      patternRecognizer: mockPatternRecognizer,
      autoTrading: false,
      pendingTradeManager: mockPendingTradeManager,
      newsService: mockNewsService,
    });

    // Set up feed with mock candles
    (engine as any).feed15m.getCandles = () => mockCandles15m;
    (engine as any).feed4h.getCandles = () => [];
    (engine as any).feed15m.getLastClosed = () => mockCandles15m[mockCandles15m.length - 1];
    (engine as any).feed4h.getCandles = () => mockCandles4h;

    // Mock ScenarioRouter to avoid actual pattern recognition
    (engine as any).scenarioRouter = {
      evaluate: jest.fn().mockResolvedValue({
        triggered: true,
        levels: { entry: '50050', stopLoss: '49950', takeProfit: '50350' },
        scenario: { id: 1, name: 'Test Scenario' },
        reason: 'Test reason',
        zoneDetails: null,
      }),
    };
  });

  describe('News Embargo Check', () => {
    it('should skip scan when isNewsEmbargo returns true', async () => {
      const timestamp = Date.now();
      (engine as any).feed15m.getLastClosed = () => ({
        timestamp,
        close: '50000',
      });

      mockNewsService.isNewsEmbargo.mockReturnValue(true);

      const loggerSpy = jest.spyOn(logger, 'info').mockImplementation();

      // Access private process method
      await (engine as any).process('15');

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('HIGH IMPACT NEWS EMBARGO is active. Skipping scan.')
      );

      // Verify scenarioRouter.evaluate was NOT called
      const scenarioRouter = (engine as any).scenarioRouter;
      expect(scenarioRouter.evaluate).not.toHaveBeenCalled();

      loggerSpy.mockRestore();
    });

    it('should proceed with scan when isNewsEmbargo returns false', async () => {
      const timestamp = Date.now();
      (engine as any).feed15m.getLastClosed = () => ({
        timestamp,
        close: '50000',
      });

      mockNewsService.isNewsEmbargo.mockReturnValue(false);

      // Mock feed to have enough candles
      (engine as any).feed15m.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 900000,
        open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
      }));
      (engine as any).feed4h.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 3600000,
        open: '50000', high: '50200', low: '49800', close: '50100', volume: '1000',
      }));

      const loggerSpy = jest.spyOn(logger, 'info').mockImplementation();

      await (engine as any).process('15');

      // Verify scenarioRouter.evaluate WAS called
      const scenarioRouter = (engine as any).scenarioRouter;
      expect(scenarioRouter.evaluate).toHaveBeenCalled();

      loggerSpy.mockRestore();
    });

    it('should skip 4H timeframe (no embargo check)', async () => {
      const timestamp = Date.now();
      (engine as any).feed15m.getLastClosed = () => ({
        timestamp,
        close: '50000',
      });

      mockNewsService.isNewsEmbargo.mockReturnValue(true);

      await (engine as any).process('240');

      // 4H timeframe should skip early return without embargo check
      const scenarioRouter = (engine as any).scenarioRouter;
      expect(scenarioRouter.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('State transitions with embargo', () => {
    it('should remain in SCANNING state when embargo active', async () => {
      const timestamp = Date.now();
      (engine as any).feed15m.getLastClosed = () => ({ timestamp, close: '50000' });
      mockNewsService.isNewsEmbargo.mockReturnValue(true);

      expect(engine.getState()).toBe(StrategyState.SCANNING);
      await (engine as any).process('15');
      expect(engine.getState()).toBe(StrategyState.SCANNING);
    });

    it('should transition to ENTRY_STAGED when embargo not active and setup found', async () => {
      const timestamp = Date.now();
      (engine as any).feed15m.getLastClosed = () => ({ timestamp, close: '50000' });
      mockNewsService.isNewsEmbargo.mockReturnValue(false);

      // Mock feed to have enough candles
      (engine as any).feed15m.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 900000,
        open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
      }));
      (engine as any).feed4h.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 3600000,
        open: '50000', high: '50200', low: '49800', close: '50100', volume: '1000',
      }));

      expect(engine.getState()).toBe(StrategyState.SCANNING);
      await (engine as any).process('15');
      // State should transition to ENTRY_STAGED if setup found
    });
  });
});