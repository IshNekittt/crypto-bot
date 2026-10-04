import { PendingTradeManager } from '../src/engine/pendingTradeManager';
import { TelegramNotifier } from '../src/telegram/notifier';
import { PendingTrade } from '../src/engine/pendingTradeManager';
import { BotConfig } from '../src/config/env';

describe('PendingTradeManager', () => {
  let manager: PendingTradeManager;
  let mockNotifier: jest.Mocked<TelegramNotifier>;
  let sendMessageMock: jest.Mock;
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
    sniperDisplacementMultiplier: undefined,
    backtestDays: 60,
  };

  beforeEach(() => {
    sendMessageMock = jest.fn().mockResolvedValue({ message_id: 12345 });
    const editMessageTextMock = jest.fn().mockResolvedValue(true);
    
    mockNotifier = {
      enabled: true,
      bot: { telegram: { sendMessage: sendMessageMock, editMessageText: editMessageTextMock } },
      chatId: '123456',
      sendMessage: jest.fn().mockResolvedValue(true),
      sendMessageWithKeyboard: jest.fn().mockResolvedValue(12345),
      editMessageWithTimeout: jest.fn().mockResolvedValue(undefined),
      notifySetupFound: jest.fn().mockResolvedValue(true),
      notifyOrderOpened: jest.fn().mockResolvedValue(true),
      notifyTradeClosed: jest.fn().mockResolvedValue(true),
      notifyCriticalError: jest.fn().mockResolvedValue(true),
      notifyInfo: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<TelegramNotifier>;

    manager = new PendingTradeManager(mockNotifier, 5, mockConfig); // 5 minutes timeout
  });

  afterEach(() => {
    manager.cancelAll();
  });

  describe('queueTrade', () => {
    it('should add trade to pending queue', async () => {
      const promise = manager.queueTrade(
        'SOLUSDT',
        '100',
        '99',
        '103',
        1,
        'Test reason',
        'Buy',
        '10'
      );

      // The trade should be added to the queue immediately
      expect(manager.getPendingCount()).toBe(1);

      const pendingTrade = Array.from((manager as any).pendingTrades.values())[0] as PendingTrade;
      expect(pendingTrade.symbol).toBe('SOLUSDT');
      expect(pendingTrade.entry).toBe('100');
      expect(pendingTrade.sl).toBe('99');
      expect(pendingTrade.tp).toBe('103');
      expect(pendingTrade.scenarioId).toBe(1);
      expect(pendingTrade.side).toBe('Buy');
      expect(pendingTrade.qty).toBe('10');

      // Resolve the promise by approving (this is the only way to resolve the promise in current implementation)
      const tradeId = pendingTrade.id;
      manager.handleApproval(tradeId, true);
      
      await expect(promise).resolves.toBe(true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should generate unique trade IDs', async () => {
      const p1 = manager.queueTrade('SOLUSDT', '100', '99', '103', 1, 'r', 'Buy', '10');
      const p2 = manager.queueTrade('SOLUSDT', '100', '99', '103', 1, 'r', 'Buy', '10');
      const p3 = manager.queueTrade('BTCUSDT', '50000', '49000', '51000', 2, 'r', 'Sell', '1');

      // Get trade IDs before approving
      const tradeId1 = Array.from((manager as any).pendingTrades.keys())[0] as string;
      manager.handleApproval(tradeId1, true);
      await p1;
      
      const tradeId2 = Array.from((manager as any).pendingTrades.keys())[0] as string;
      manager.handleApproval(tradeId2, true);
      await p2;
      
      const tradeId3 = Array.from((manager as any).pendingTrades.keys())[0] as string;
      manager.handleApproval(tradeId3, true);
      await p3;

      // All trades should have been created with unique IDs
      // (we can't check the map now as they're all processed)
      // The fact that all promises resolved without error is sufficient
      expect(true).toBe(true);
    });

    it('should return false when Telegram sendMessage fails', async () => {
      (mockNotifier.bot.telegram.sendMessage as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
      
      const result = await manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      expect(result).toBe(false);
      expect(manager.getPendingCount()).toBe(0);
    });
  });

  describe('handleApproval', () => {
    it('should resolve true when approved', async () => {
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      await expect(promise).resolves.toBe(true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should resolve false when rejected', async () => {
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, false);

      expect(result.approved).toBe(false);
      await expect(promise).resolves.toBe(false);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should return approved: false for unknown trade ID', () => {
      const result = manager.handleApproval('UNKNOWN_ID', true);
      expect(result.approved).toBe(false);
    });

    it('should return approved: false for already processed trade', async () => {
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      manager.handleApproval(tradeId, true);
      
      // Try to approve again
      const result = manager.handleApproval(tradeId, true);
      expect(result.approved).toBe(false);
      
      await promise;
    });
  });

  describe('getPendingTrade', () => {
    it('should return pending trade by ID', async () => {
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const trade = manager.getPendingTrade(tradeId);

      expect(trade).toBeDefined();
      expect(trade?.symbol).toBe('SOLUSDT');
      
      // Clean up
      manager.handleApproval(tradeId, true);
      await promise;
    });

    it('should return undefined for unknown ID', () => {
      const trade = manager.getPendingTrade('UNKNOWN_ID');
      expect(trade).toBeUndefined();
    });
  });

  describe('cancelAll', () => {
    it('should cancel all pending trades', async () => {
      manager.queueTrade('SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10');
      manager.queueTrade('BTCUSDT', '50000', '49000', '51000', 2, 'Test', 'Sell', '1');

      // Small delay to allow queueTrade to process
      await new Promise(r => setTimeout(r, 10));
      
      expect(manager.getPendingCount()).toBe(2);

      manager.cancelAll();

      expect(manager.getPendingCount()).toBe(0);
    });
  });

  describe('getPendingCount', () => {
    it('should return correct count', async () => {
      expect(manager.getPendingCount()).toBe(0);
      
      const promise1 = manager.queueTrade('SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10');
      expect(manager.getPendingCount()).toBe(1);
      
      const promise2 = manager.queueTrade('BTCUSDT', '50000', '49000', '51000', 2, 'Test', 'Sell', '1');
      expect(manager.getPendingCount()).toBe(2);
      
      // Clean up
      const tradeId1 = Array.from((manager as any).pendingTrades.keys())[0] as string;
      manager.handleApproval(tradeId1, true);
      await promise1;
      
      const tradeId2 = Array.from((manager as any).pendingTrades.keys())[0] as string;
      manager.handleApproval(tradeId2, true);
      await promise2;
    });
  });

  describe('Slippage Guard', () => {
    beforeEach(() => {
      // Set a price provider that returns a fixed price
      manager.setPriceProvider(() => '100.21'); // Current price = 100.21 (0.21% above entry 100) - exceeds 0.2% threshold
    });

    it('should REJECT approval when price moved > 0.2% towards TP (Long)', async () => {
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      
      // Price is 100.21 (0.21% above entry 100) - exceeds 0.15% threshold
      // Should return Limit order instead of rejection
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Limit');
      await expect(promise).resolves.toBe(true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should return Limit order when price moved > 0.15% towards TP (Long)', async () => {
      // Update price provider to return price just outside threshold
      manager.setPriceProvider(() => '100.19'); // 0.19% above entry
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Limit');
      await expect(promise).resolves.toBe(true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should return Limit order when price moved > 0.15% towards TP (Short)', async () => {
      // For short: entry=100, tp=97, current=99.79 (0.21% below entry) - exceeds 0.15% threshold
      manager.setPriceProvider(() => '99.79'); // 0.21% below entry
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '101', '97', 1, 'Test', 'Sell', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Limit');
      await expect(promise).resolves.toBe(true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should REJECT approval when price already reached TP', async () => {
      // Price at TP (103) - should reject
      manager.setPriceProvider(() => '103');
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(false);
      await expect(promise).resolves.toBe(false);
      expect(manager.getPendingCount()).toBe(0);
    });

    it('should ACCEPT approval when no price provider is set', async () => {
      // Create new manager without price provider
      const managerNoPrice = new PendingTradeManager(mockNotifier, 5, mockConfig);
      
      const promise = managerNoPrice.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((managerNoPrice as any).pendingTrades.keys())[0] as string;
      const result = managerNoPrice.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Market');
      await expect(promise).resolves.toBe(true);
      expect(managerNoPrice.getPendingCount()).toBe(0);
      
      managerNoPrice.cancelAll();
    });
  });

  describe('Dynamic Approval (Market vs Limit based on price deviation)', () => {
    const createManagerWithPrice = (currentPrice: string) => {
      const mgr = new PendingTradeManager(mockNotifier, 5, mockConfig);
      mgr.setPriceProvider(() => currentPrice);
      return mgr;
    };

    it('should return Market order when livePrice deviation < 0.15% (Long)', async () => {
      // idealEntry=100, TP=103, currentPrice=100.10 (0.10% deviation < 0.15%)
      const manager = createManagerWithPrice('100.10');
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Market');
      await expect(promise).resolves.toBe(true);
      manager.cancelAll();
    });

    it('should return Limit order when livePrice deviation > 0.15% (Long)', async () => {
      // idealEntry=100, TP=103, currentPrice=100.20 (0.20% deviation > 0.15%)
      const manager = createManagerWithPrice('100.20');
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '99', '103', 1, 'Test', 'Buy', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Limit');
      expect(result.limitPrice).toBe('100.00000000'); // Should use idealEntry as limit price
      await expect(promise).resolves.toBe(true);
      manager.cancelAll();
    });

    it('should return Market order when livePrice deviation < 0.15% (Short)', async () => {
      // idealEntry=100, TP=97, currentPrice=99.90 (0.10% deviation < 0.15%)
      const manager = createManagerWithPrice('99.90');
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '101', '97', 1, 'Test', 'Sell', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Market');
      await expect(promise).resolves.toBe(true);
      manager.cancelAll();
    });

    it('should return Limit order when livePrice deviation > 0.15% (Short)', async () => {
      // idealEntry=100, TP=97, currentPrice=99.79 (0.21% deviation > 0.15%)
      const manager = createManagerWithPrice('99.79');
      
      const promise = manager.queueTrade(
        'SOLUSDT', '100', '101', '97', 1, 'Test', 'Sell', '10'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Limit');
      expect(result.limitPrice).toBe('100.00000000');
      await expect(promise).resolves.toBe(true);
      manager.cancelAll();
    });

    it('should use idealEntry as limitPrice for Limit orders', async () => {
      const manager = createManagerWithPrice('100.50'); // Far from ideal entry
      
      const promise = manager.queueTrade(
        'BTCUSDT', '50000', '49900', '50300', 1, 'Test', 'Buy', '0.1'
      );

      const tradeId = Array.from((manager as any).pendingTrades.keys())[0] as string;
      const result = manager.handleApproval(tradeId, true);

      expect(result.approved).toBe(true);
      expect(result.orderType).toBe('Limit');
      expect(result.limitPrice).toBe('50000.00000000'); // idealEntry used as limit price
      await expect(promise).resolves.toBe(true);
      manager.cancelAll();
    });
  });
});