import { ReconciliationLoop, CLOCK_DRIFT_SYNC_INTERVAL_MS } from '../src/bootstrap/reconciliation';
import { PositionListSource, TimeSyncResult } from '../src/api/bybitClient';
import { PostgresDatabase } from '../src/db/database';
import { ReconcilableEngine } from '../src/bootstrap/reconciliation';
import { StrategyState } from '../src/types';
import { BotConfig } from '../src/config/env';
import { Decimal } from 'decimal.js';

jest.useFakeTimers();

describe('ReconciliationLoop', () => {
  let mockSource: jest.Mocked<PositionListSource>;
  let mockDb: jest.Mocked<PostgresDatabase>;
  let mockEngines: jest.Mocked<ReconcilableEngine>[];
  let mockEngine: jest.Mocked<ReconcilableEngine>;
  let reconciliation: ReconciliationLoop;

  const mockTimeSync: TimeSyncResult = { offsetMs: 5, roundTripMs: 100 };

  beforeEach(() => {
    mockSource = {
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      syncServerTime: jest.fn().mockResolvedValue(mockTimeSync),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      setTradingStop: jest.fn().mockResolvedValue(undefined),
    } as jest.Mocked<PositionListSource>;

    mockDb = {
      getAllOpenTrades: jest.fn().mockResolvedValue([]),
      closeTrade: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PostgresDatabase>;

    mockEngine = {
      symbol: 'SOLUSDT',
      getState: jest.fn().mockReturnValue(StrategyState.SCANNING),
      reconcile: jest.fn().mockResolvedValue(false),
      reconcileWithTrade: jest.fn().mockResolvedValue(false),
    } as jest.Mocked<ReconcilableEngine>;

    mockEngines = [mockEngine];

    const mockConfig: BotConfig = {
      apiKey: '',
      apiSecret: '',
      testnet: false,
      demoTrading: true,
      symbols: ['SOLUSDT'],
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

    reconciliation = new ReconciliationLoop(mockSource, mockDb, mockEngines, mockConfig);
  });

  afterEach(() => {
    reconciliation.stop();
  });

  describe('Clock Drift Prevention', () => {
    it('should call syncServerTime on first tick', async () => {
      await reconciliation.tick();
      
      expect(mockSource.syncServerTime).toHaveBeenCalledTimes(1);
    });

    it('should NOT call syncServerTime again within 1 hour', async () => {
      await reconciliation.tick();
      expect(mockSource.syncServerTime).toHaveBeenCalledTimes(1);
      
      // Advance time by 30 minutes (less than 1 hour)
      jest.advanceTimersByTime(30 * 60 * 1000);
      
      await reconciliation.tick();
      expect(mockSource.syncServerTime).toHaveBeenCalledTimes(1);
    });

    it('should call syncServerTime again after 1 hour', async () => {
      await reconciliation.tick();
      expect(mockSource.syncServerTime).toHaveBeenCalledTimes(1);
      
      // Advance time by 1 hour + 1 minute
      jest.advanceTimersByTime(CLOCK_DRIFT_SYNC_INTERVAL_MS + 60000);
      
      await reconciliation.tick();
      expect(mockSource.syncServerTime).toHaveBeenCalledTimes(2);
    });

    it('should continue when syncServerTime fails', async () => {
      mockSource.syncServerTime.mockRejectedValueOnce(new Error('Network error'));
      
      // Should not throw
      await expect(reconciliation.tick()).resolves.not.toThrow();
    });
  });

  describe('Reconciliation', () => {
    it('should check engines with IN_TRADE state', async () => {
      mockEngine.getState.mockReturnValue(StrategyState.IN_TRADE);
      
      await reconciliation.tick();
      
      expect(mockEngine.reconcile).toHaveBeenCalledWith([]);
    });

    it('should NOT check engines NOT in IN_TRADE state', async () => {
      mockEngine.getState.mockReturnValue(StrategyState.SCANNING);
      
      await reconciliation.tick();
      
      expect(mockEngine.reconcile).not.toHaveBeenCalled();
    });

    it('should audit open trades from DB', async () => {
      const mockTrade = {
        id: 'trade_1',
        symbol: 'SOLUSDT',
        entryPrice: '100',
        qty: '10',
        side: 'Buy' as const,
        openedAt: Date.now(),
        orderId: 'order_1',
        zoneDetails: null,
      };
      
      mockDb.getAllOpenTrades.mockResolvedValueOnce([mockTrade as any]);
      mockSource.getOpenPositions.mockResolvedValueOnce([]); // No position on exchange
      
      await reconciliation.tick();
      
      expect(mockEngine.reconcileWithTrade).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trade_1', symbol: 'SOLUSDT' })
      );
    });

    it('should NOT call reconcileWithTrade when position exists on exchange', async () => {
      const mockTrade = {
        id: 'trade_1',
        symbol: 'SOLUSDT',
        entryPrice: '100',
        qty: '10',
        side: 'Buy' as const,
        openedAt: Date.now(),
        orderId: 'order_1',
        zoneDetails: null,
      };
      
      mockDb.getAllOpenTrades.mockResolvedValueOnce([mockTrade as any]);
      mockSource.getOpenPositions.mockResolvedValueOnce([
        { symbol: 'SOLUSDT', side: 'Buy', size: new Decimal('10'), avgPrice: new Decimal('100') }
      ]); // Position exists
      
      await reconciliation.tick();
      
      expect(mockEngine.reconcileWithTrade).not.toHaveBeenCalled();
    });
  });

  describe('Limit order expiration safety', () => {
    const expiredLimit = (status: 'New' | 'PartiallyFilled') => ({
      orderId: 'limit_1',
      orderLinkId: 'link_1',
      symbol: 'SOLUSDT',
      side: 'Buy' as const,
      orderType: 'Limit' as const,
      price: '100',
      qty: '10',
      stopLoss: '99',
      takeProfit: '103',
      createdAt: Date.now() - 400 * 60 * 1000, // far beyond 6 × 15m
      status,
    });

    it('cancels an expired NEW limit order and closes it in DB as CANCELLED', async () => {
      mockEngine.getState.mockReturnValue(StrategyState.IN_TRADE);
      mockSource.getOpenOrders
        .mockResolvedValueOnce([expiredLimit('New')])
        .mockResolvedValue([]);

      await reconciliation.tick();

      expect(mockSource.cancelOrder).toHaveBeenCalledWith('SOLUSDT', 'limit_1');
      expect(mockDb.closeTrade).toHaveBeenCalledWith(
        'limit_1', '0', '100', expect.any(Number), 'CANCELLED',
      );
      expect(mockEngine.reconcile).toHaveBeenCalled();
    });

    it('cancels only the resting portion of a PARTIALLY FILLED limit and keeps it IN_TRADE', async () => {
      mockEngine.getState.mockReturnValue(StrategyState.IN_TRADE);
      mockSource.getOpenOrders
        .mockResolvedValueOnce([expiredLimit('PartiallyFilled')])
        .mockResolvedValue([]);

      await reconciliation.tick();

      expect(mockSource.cancelOrder).toHaveBeenCalledWith('SOLUSDT', 'limit_1');
      // The filled portion is real exposure — it must NOT be closed as CANCELLED.
      expect(mockDb.closeTrade).not.toHaveBeenCalled();
      expect(mockEngine.reconcile).not.toHaveBeenCalled();
    });
  });
});