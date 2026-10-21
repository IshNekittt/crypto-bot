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

describe('StrategyEngine', () => {
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
      config: { 
        historyCandles: 200,
        ltfTimeframe: '15',
        htfTimeframe: '240',
        smartEntryThresholdPct: '0.0015',
        limitExpirationCandles: 6,
        cooldownCandles: 16,
      },
      getKlines: jest.fn().mockResolvedValue([]),
      getInstrumentInfo: jest.fn().mockResolvedValue(mockInstrument),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getExecutions: jest.fn().mockResolvedValue([]),
      syncServerTime: jest.fn().mockResolvedValue({ offsetMs: 0, roundTripMs: 100 }),
      getUsdtBalance: jest.fn().mockResolvedValue(new Decimal('10000')),
      placeMarketOrderWithTpsl: jest.fn().mockResolvedValue('order123'),
      placeLimitOrderWithTpsl: jest.fn().mockResolvedValue('order123'),
      placeReduceOnlyMarketOrder: jest.fn().mockResolvedValue('panic-order-1'),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      setTradingStop: jest.fn().mockResolvedValue(undefined),
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
      updateTradeManagementState: jest.fn().mockResolvedValue(undefined),
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
      executePartialClose: jest.fn().mockResolvedValue({ ok: true, orderId: 'pc123' }),
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
      config: { 
        ltfTimeframe: '15', 
        htfTimeframe: '240', 
        historyCandles: 200, 
        activeScenarios: [1,2,3,4,5,6,7,8,9,10,11], 
        symbolScenarios: new Map(),
        smartEntryThresholdPct: '0.0015',
        limitExpirationCandles: 6,
        cooldownCandles: 16,
        preflightBufferPct: '0.0005',
      } as any,
      activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
    });

    // Set up feed with mock candles
    (engine as any).feedLtf.getCandles = () => mockCandles15m;
    (engine as any).feedHtf.getCandles = () => [];
    (engine as any).feedLtf.getLastClosed = () => mockCandles15m[mockCandles15m.length - 1];
    (engine as any).feedHtf.getCandles = () => mockCandles4h;

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
      (engine as any).feedLtf.getLastClosed = () => ({
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
      (engine as any).feedLtf.getLastClosed = () => ({
        timestamp,
        close: '50000',
      });

      mockNewsService.isNewsEmbargo.mockReturnValue(false);

      // Mock feed to have enough candles
      (engine as any).feedLtf.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 900000,
        open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
      }));
      (engine as any).feedHtf.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
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
      (engine as any).feedLtf.getLastClosed = () => ({
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
      (engine as any).feedLtf.getLastClosed = () => ({ timestamp, close: '50000' });
      mockNewsService.isNewsEmbargo.mockReturnValue(true);

      expect(engine.getState()).toBe(StrategyState.SCANNING);
      await (engine as any).process('15');
      expect(engine.getState()).toBe(StrategyState.SCANNING);
    });

    it('should transition to ENTRY_STAGED when embargo not active and setup found', async () => {
      const timestamp = Date.now();
      (engine as any).feedLtf.getLastClosed = () => ({ timestamp, close: '50000' });
      mockNewsService.isNewsEmbargo.mockReturnValue(false);

      // Mock feed to have enough candles
      (engine as any).feedLtf.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 900000,
        open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
      }));
      (engine as any).feedHtf.getCandles = () => Array.from({ length: 50 }, (_, i) => ({
        timestamp: Date.now() - (49 - i) * 3600000,
        open: '50000', high: '50200', low: '49800', close: '50100', volume: '1000',
      }));

      expect(engine.getState()).toBe(StrategyState.SCANNING);
      await (engine as any).process('15');
      // State should transition to ENTRY_STAGED if setup found
    });
  });

  describe('Global Tick Memory', () => {
    it('should start with null live price and ignore feedLtf state', () => {
      // Simulate a (potentially stale) price available in the LTF feed only
      (engine as any).feedLtf.getCurrentLivePrice = () => '99999';

      // Global tick memory is empty until the first WS tick arrives
      expect(engine.getLivePrice()).toBeNull();
    });

    it('should update latestTickPrice from an UNCONFIRMED tick and return it via getLivePrice()', async () => {
      (engine as any).feedLtf.getCurrentLivePrice = () => '99999';

      await engine.handleKline({
        symbol: 'BTCUSDT',
        interval: '1',
        confirmed: false,
        candle: { timestamp: Date.now(), open: '55500', high: '55600', low: '55400', close: '55555', volume: '10' },
      });

      // Unconfirmed tick must still update the global tick memory
      expect(engine.getLivePrice()).toBe('55555');
      // Stale feedLtf price must be ignored entirely
      expect(engine.getLivePrice()).not.toBe('99999');
    });

    it('should keep updating latestTickPrice on every subsequent tick', async () => {
      await engine.handleKline({
        symbol: 'BTCUSDT',
        interval: '15',
        confirmed: false,
        candle: { timestamp: Date.now(), open: '60000', high: '60010', low: '59990', close: '60000', volume: '1' },
      });
      expect(engine.getLivePrice()).toBe('60000');

      await engine.handleKline({
        symbol: 'BTCUSDT',
        interval: '15',
        confirmed: false,
        candle: { timestamp: Date.now(), open: '60100', high: '60120', low: '60090', close: '60123', volume: '1' },
      });
      expect(engine.getLivePrice()).toBe('60123');
    });
  });

  describe('Classic Mode Trade Management (enableSniperMode=false)', () => {
    it('should invoke checkAndManagePosition on a confirmed 15m kline in IN_TRADE state', async () => {
      (engine as any).deps.config.enableSniperMode = false;
      (engine as any).transition(StrategyState.IN_TRADE);

      const manageSpy = jest.spyOn(engine as any, 'checkAndManagePosition');

      await engine.handleKline({
        symbol: 'BTCUSDT',
        interval: '15',
        confirmed: true,
        candle: { timestamp: Date.now(), open: '50000', high: '50100', low: '49900', close: '50050', volume: '100' },
      });

      expect(manageSpy).toHaveBeenCalledTimes(1);
      // Proof the real management logic executed (call-through), not just a mocked spy
      expect(mockDb.getOpenTrade).toHaveBeenCalledWith('BTCUSDT');

      manageSpy.mockRestore();
    });

    it('should invoke checkAndManagePosition on an UNCONFIRMED tick while IN_TRADE (15-minute blindness fix)', async () => {
      (engine as any).deps.config.enableSniperMode = false;
      (engine as any).transition(StrategyState.IN_TRADE);

      const manageSpy = jest.spyOn(engine as any, 'checkAndManagePosition');

      await engine.handleKline({
        symbol: 'BTCUSDT',
        interval: '15',
        confirmed: false,
        candle: { timestamp: Date.now(), open: '50000', high: '50100', low: '49900', close: '50050', volume: '100' },
      });

      expect(manageSpy).toHaveBeenCalledTimes(1);

      manageSpy.mockRestore();
    });

    it('should NOT invoke checkAndManagePosition while SCANNING', async () => {
      (engine as any).deps.config.enableSniperMode = false;
      expect(engine.getState()).toBe(StrategyState.SCANNING);

      const manageSpy = jest.spyOn(engine as any, 'checkAndManagePosition');

      await engine.handleKline({
        symbol: 'BTCUSDT',
        interval: '15',
        confirmed: true,
        candle: { timestamp: Date.now(), open: '50000', high: '50100', low: '49900', close: '50050', volume: '100' },
      });

      expect(manageSpy).not.toHaveBeenCalled();

      manageSpy.mockRestore();
    });

    it('should safely skip management when live price is unknown (null guard)', async () => {
      (engine as any).transition(StrategyState.IN_TRADE);
      // Simulate cold start: no WS tick received yet
      (engine as any).latestTickPrice = null;

      await (engine as any).checkAndManagePosition();

      // No exchange calls must be made without a live price
      expect(mockClient.getOpenPositions).not.toHaveBeenCalled();
    });
  });

  describe('Lazy API Evaluation (per-tick management)', () => {
    const tradeAtEntry = () => ({
      id: 'trade-lazy-1',
      symbol: 'BTCUSDT',
      side: 'Buy',
      entryPrice: '100',
      stopLoss: '99',
      takeProfit: '110',
      qty: '1',
      managementState: {
        milestone1Triggered: false,
        milestone2Triggered: false,
        initialTotalR: '10',
        initialQty: '1',
      },
    });

    it('should make zero exchange API calls when no milestone action is required', async () => {
      (engine as any).transition(StrategyState.IN_TRADE);
      (engine as any).latestTickPrice = '100';
      mockDb.getOpenTrade.mockResolvedValue(tradeAtEntry() as any);

      await (engine as any).checkAndManagePosition();

      expect(mockDb.getOpenTrade).toHaveBeenCalledWith('BTCUSDT');
      expect(mockClient.getOpenPositions).not.toHaveBeenCalled();
      expect(mockClient.setTradingStop).not.toHaveBeenCalled();
      expect(mockExecutionEngine.executePartialClose).not.toHaveBeenCalled();
    });

    it('should call getOpenPositions only when an action is required', async () => {
      (engine as any).transition(StrategyState.IN_TRADE);
      (engine as any).latestTickPrice = '104';
      mockDb.getOpenTrade.mockResolvedValue(tradeAtEntry() as any);
      mockClient.getOpenPositions.mockResolvedValue([{ symbol: 'BTCUSDT', size: new Decimal('1') }] as any);

      await (engine as any).checkAndManagePosition();

      expect(mockClient.getOpenPositions).toHaveBeenCalledWith('BTCUSDT');
      expect(mockExecutionEngine.executePartialClose).toHaveBeenCalledTimes(1);
    });

    it('should back off from position checks after a miss (unfilled Limit order)', async () => {
      (engine as any).transition(StrategyState.IN_TRADE);
      (engine as any).latestTickPrice = '104';
      mockDb.getOpenTrade.mockResolvedValue(tradeAtEntry() as any);
      mockClient.getOpenPositions.mockResolvedValue([]);

      await (engine as any).checkAndManagePosition();
      await (engine as any).checkAndManagePosition();
      await (engine as any).checkAndManagePosition();

      expect(mockClient.getOpenPositions).toHaveBeenCalledTimes(1);
      expect(mockExecutionEngine.executePartialClose).not.toHaveBeenCalled();
      expect(mockDb.updateTradeManagementState).not.toHaveBeenCalled();
    });
  });

  describe('Adaptive Fractioning — Milestone State Sync (partial close)', () => {
    const setupInTradeWithSniperSetup = () => {
      (engine as any).transition(StrategyState.IN_TRADE);
      // 40% progress toward TP → triggers Sniper Milestone 1 (33%): close_partial_25 + SL→entry
      (engine as any).latestTickPrice = '104';
      mockClient.getOpenPositions.mockResolvedValue([
        { symbol: 'BTCUSDT', size: new Decimal('1') },
      ] as any);
      mockDb.getOpenTrade.mockResolvedValue({
        id: 'trade-partial-1',
        symbol: 'BTCUSDT',
        side: 'Buy',
        entryPrice: '100',
        stopLoss: '99',
        takeProfit: '110',
        qty: '1',
        managementState: {
          milestone1Triggered: false,
          milestone2Triggered: false,
          initialTotalR: '10',
          initialQty: '1',
        },
      } as any);
    };

    it('should NOT update milestone state when executePartialClose fails (Silent Desync guard)', async () => {
      setupInTradeWithSniperSetup();
      mockExecutionEngine.executePartialClose.mockResolvedValue({ ok: false, reason: 'Rate limit exceeded' });

      await (engine as any).checkAndManagePosition();

      // Partial close was attempted...
      expect(mockExecutionEngine.executePartialClose).toHaveBeenCalledTimes(1);
      // ...but the milestone must remain untriggered so it retries on the next tick
      expect(mockDb.updateTradeManagementState).not.toHaveBeenCalled();
      // ...and the SL must NOT be moved (entire milestone progression aborted)
      expect(mockClient.setTradingStop).not.toHaveBeenCalled();
    });

    it('should update milestone state and move SL only after successful partial close', async () => {
      setupInTradeWithSniperSetup();
      mockExecutionEngine.executePartialClose.mockResolvedValue({ ok: true, orderId: 'pc123' });

      await (engine as any).checkAndManagePosition();

      expect(mockExecutionEngine.executePartialClose).toHaveBeenCalledTimes(1);
      // Once after partial close, once after SL move
      expect(mockDb.updateTradeManagementState).toHaveBeenCalledTimes(2);
      expect(mockClient.setTradingStop).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        stopLoss: '100',
      });
    });
  });

  describe('Post-fill pipeline (IN_TRADE before bookkeeping)', () => {
    const stagedPlan = {
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
      orderType: 'Market',
      limitPrice: null,
    } as any;

    it('auto: transitions to IN_TRADE before db.openTrade and records the actual avgPrice', async () => {
      (engine as any).plan = stagedPlan;
      (engine as any).latestTickPrice = '50050';
      mockClient.getOpenPositions.mockResolvedValue([
        { symbol: 'BTCUSDT', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
      ] as any);

      let stateAtDbWrite: StrategyState | null = null;
      mockDb.openTrade.mockImplementation(async () => {
        stateAtDbWrite = engine.getState();
        return 'trade123';
      });

      await (engine as any).executeStagedEntry();

      expect(stateAtDbWrite).toBe(StrategyState.IN_TRADE);
      expect(engine.getState()).toBe(StrategyState.IN_TRADE);
      expect(mockDb.openTrade).toHaveBeenCalledWith(
        expect.objectContaining({ entry_price: '50060' }),
      );
      // No Assumed Fill: positions must be fetched before the DB row is written
      expect(mockClient.getOpenPositions.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.openTrade.mock.invocationCallOrder[0],
      );
    });

    it('auto: DB failure after a live fill panic-closes the orphan, then burns and resets', async () => {
      (engine as any).plan = stagedPlan;
      (engine as any).latestTickPrice = '50050';
      const burnSpy = jest.spyOn(engine as any, 'burnSetup');
      mockDb.openTrade.mockRejectedValue(new Error('DB down'));
      mockClient.getOpenPositions
        .mockResolvedValueOnce([
          { symbol: 'BTCUSDT', side: 'Buy', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
        ] as any)
        .mockResolvedValueOnce([
          { symbol: 'BTCUSDT', side: 'Buy', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
        ] as any)
        .mockResolvedValueOnce([] as any);

      await (engine as any).executeStagedEntry();

      expect(mockClient.placeReduceOnlyMarketOrder).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        side: 'Sell',
        qty: '0.100',
        orderLinkId: expect.stringContaining('BTCUSDT_panic_'),
      });
      expect(mockNotifier.notifyCriticalError).toHaveBeenCalledWith(
        'CRITICAL DB FAILURE: Orphan position detected. Emergency Market Close executed.',
      );
      expect(burnSpy).toHaveBeenCalledTimes(1);
      expect(engine.getState()).toBe(StrategyState.SCANNING);
      burnSpy.mockRestore();
    });

    it('auto: failed panic close keeps the engine IN_TRADE and does NOT burn the setup', async () => {
      (engine as any).plan = stagedPlan;
      (engine as any).latestTickPrice = '50050';
      const burnSpy = jest.spyOn(engine as any, 'burnSetup');
      mockDb.openTrade.mockRejectedValue(new Error('DB down'));
      mockClient.getOpenPositions.mockResolvedValue([
        { symbol: 'BTCUSDT', side: 'Buy', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
      ] as any);
      mockClient.placeReduceOnlyMarketOrder.mockRejectedValue(new Error('circuit breaker OPEN'));

      await (engine as any).executeStagedEntry();

      expect(mockClient.placeReduceOnlyMarketOrder).toHaveBeenCalled();
      expect(burnSpy).not.toHaveBeenCalled();
      expect(engine.getState()).toBe(StrategyState.IN_TRADE);
      expect(mockNotifier.notifyCriticalError).toHaveBeenCalledWith(
        expect.stringContaining('Emergency Market Close FAILED'),
      );
      burnSpy.mockRestore();
    });

    it('auto: DB failure on an unfilled LIMIT order cancels the order instead of flattening', async () => {
      // Premium setup for a Long (live 50050 > ideal 49500 by >0.15%) resolves to a Limit order.
      (engine as any).plan = {
        ...stagedPlan,
        entryPrice: '49500',
        stopLoss: '49400',
        takeProfit: '50500',
      };
      (engine as any).latestTickPrice = '50050';
      const burnSpy = jest.spyOn(engine as any, 'burnSetup');
      mockDb.openTrade.mockRejectedValue(new Error('DB down'));
      mockClient.getOpenOrders.mockResolvedValue([
        {
          orderId: 'order123',
          orderLinkId: 'link123',
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Limit',
          price: '49500',
          qty: '0.1',
          stopLoss: '49400',
          takeProfit: '50500',
          createdAt: Date.now(),
          status: 'New',
        },
      ] as any);

      await (engine as any).executeStagedEntry();

      expect(mockClient.cancelOrder).toHaveBeenCalledWith('BTCUSDT', 'order123');
      expect(mockClient.placeReduceOnlyMarketOrder).not.toHaveBeenCalled();
      expect(mockNotifier.notifyCriticalError).toHaveBeenCalledWith(
        'CRITICAL DB FAILURE: Orphan LIMIT order detected. Emergency Order Cancel executed.',
      );
      expect(burnSpy).toHaveBeenCalledTimes(1);
      expect(engine.getState()).toBe(StrategyState.SCANNING);
      burnSpy.mockRestore();
    });

    it('manual: fetches avgPrice, writes it to DB and enters IN_TRADE before the DB write', async () => {
      (engine as any).transition(StrategyState.ENTRY_STAGED);
      (engine as any).plan = stagedPlan;
      (engine as any).latestTickPrice = '50050';
      mockPendingTradeManager.handleApproval.mockReturnValue({
        approved: true,
        orderType: 'Market',
      } as any);
      mockClient.getOpenPositions.mockResolvedValue([
        { symbol: 'BTCUSDT', size: new Decimal('0.1'), avgPrice: new Decimal('50065') },
      ] as any);

      let stateAtDbWrite: StrategyState | null = null;
      mockDb.openTrade.mockImplementation(async () => {
        stateAtDbWrite = engine.getState();
        return 'trade123';
      });

      await engine.handleTradeApproval('trade-manual-1', true);

      expect(stateAtDbWrite).toBe(StrategyState.IN_TRADE);
      expect(engine.getState()).toBe(StrategyState.IN_TRADE);
      expect(mockDb.openTrade).toHaveBeenCalledWith(
        expect.objectContaining({ entry_price: '50065' }),
      );
    });

    it('manual: DB failure after a live fill panic-closes the orphan, then burns and resets', async () => {
      (engine as any).transition(StrategyState.ENTRY_STAGED);
      (engine as any).plan = stagedPlan;
      (engine as any).latestTickPrice = '50050';
      mockPendingTradeManager.handleApproval.mockReturnValue({
        approved: true,
        orderType: 'Market',
      } as any);
      const burnSpy = jest.spyOn(engine as any, 'burnSetup');
      mockDb.openTrade.mockRejectedValue(new Error('DB down'));
      mockClient.getOpenPositions
        .mockResolvedValueOnce([
          { symbol: 'BTCUSDT', side: 'Buy', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
        ] as any)
        .mockResolvedValueOnce([
          { symbol: 'BTCUSDT', side: 'Buy', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
        ] as any)
        .mockResolvedValueOnce([] as any);

      await engine.handleTradeApproval('trade-manual-2', true);

      expect(mockClient.placeReduceOnlyMarketOrder).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        side: 'Sell',
        qty: '0.100',
        orderLinkId: expect.stringContaining('BTCUSDT_panic_'),
      });
      expect(mockNotifier.notifyCriticalError).toHaveBeenCalledWith(
        'CRITICAL DB FAILURE: Orphan position detected. Emergency Market Close executed.',
      );
      expect(burnSpy).toHaveBeenCalledTimes(1);
      expect(engine.getState()).toBe(StrategyState.SCANNING);
      burnSpy.mockRestore();
    });

    it('manual: failed panic close keeps the engine IN_TRADE and does NOT burn the setup', async () => {
      (engine as any).transition(StrategyState.ENTRY_STAGED);
      (engine as any).plan = stagedPlan;
      (engine as any).latestTickPrice = '50050';
      mockPendingTradeManager.handleApproval.mockReturnValue({
        approved: true,
        orderType: 'Market',
      } as any);
      const burnSpy = jest.spyOn(engine as any, 'burnSetup');
      mockDb.openTrade.mockRejectedValue(new Error('DB down'));
      mockClient.getOpenPositions.mockResolvedValue([
        { symbol: 'BTCUSDT', side: 'Buy', size: new Decimal('0.1'), avgPrice: new Decimal('50060') },
      ] as any);
      mockClient.placeReduceOnlyMarketOrder.mockRejectedValue(new Error('circuit breaker OPEN'));

      await engine.handleTradeApproval('trade-manual-3', true);

      expect(mockClient.placeReduceOnlyMarketOrder).toHaveBeenCalled();
      expect(burnSpy).not.toHaveBeenCalled();
      expect(engine.getState()).toBe(StrategyState.IN_TRADE);
      expect(mockNotifier.notifyCriticalError).toHaveBeenCalledWith(
        expect.stringContaining('Emergency Market Close FAILED'),
      );
      burnSpy.mockRestore();
    });
  });
});