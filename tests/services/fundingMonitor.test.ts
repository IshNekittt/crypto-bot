import { FundingMonitorService } from '../../src/services/fundingMonitorService';
import { BybitClient } from '../../src/api/bybitClient';
import { TelegramNotifier } from '../../src/telegram/notifier';
import { Decimal } from 'decimal.js';
import { TickerInfo } from '../../src/api/bybitClient';

const mockBybitClient = {
  getTickers: jest.fn(),
} as unknown as jest.Mocked<BybitClient>;

const mockNotifier = {
  sendMessage: jest.fn().mockResolvedValue(true),
} as unknown as jest.Mocked<TelegramNotifier>;

describe('FundingMonitorService', () => {
  let service: FundingMonitorService;
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const alertThreshold = '0.0';
  const restoreThreshold = '0.0001';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    service = new FundingMonitorService(
      mockBybitClient,
      mockNotifier,
      symbols,
      alertThreshold,
      restoreThreshold
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    service.stop();
  });

  const createTickerArray = (rates: Record<string, string>): TickerInfo[] => 
    Object.entries(rates).map(([symbol, fundingRate]) => ({
      symbol,
      fundingRate,
      nextFundingTime: '0',
    }));

  it('should initialize with correct alert states', () => {
    const rates = service.getCurrentRates();
    expect(rates.size).toBe(0);
  });

  it('should trigger alert when funding rate <= threshold and not already alerted', async () => {
    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '-0.0001', ETHUSDT: '0.0001', SOLUSDT: '0.0002' })
    );

    await service['pollFundingRates']();

    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockNotifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('⚠️ <b>[FUNDING ALERT]</b>')
    );
    expect(mockNotifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('BTCUSDT')
    );
    expect(mockNotifier.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('-0.0100%')
    );

    const rates = service.getCurrentRates();
    expect(rates.get('BTCUSDT')).toEqual(new Decimal('-0.0001'));
    expect(rates.get('ETHUSDT')).toEqual(new Decimal('0.0001'));
    expect(rates.get('SOLUSDT')).toEqual(new Decimal('0.0002'));
  });

  it('should not trigger duplicate alert for same symbol', async () => {
    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '-0.0001', ETHUSDT: '0.0001', SOLUSDT: '0.0002' })
    );

    await service['pollFundingRates']();
    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(1);

    await service['pollFundingRates']();
    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('should trigger restore when funding rate >= restore threshold and was alerted', async () => {
    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '-0.0001', ETHUSDT: '0.0001', SOLUSDT: '0.0002' })
    );

    await service['pollFundingRates']();
    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(1);

    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '0.0002', ETHUSDT: '0.0001', SOLUSDT: '0.0002' })
    );

    await service['pollFundingRates']();

    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockNotifier.sendMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('🟢 <b>[FUNDING RESTORED]</b>')
    );
    expect(mockNotifier.sendMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('BTCUSDT')
    );
    expect(mockNotifier.sendMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('+0.0200%')
    );
  });

  it('should not trigger restore if not previously alerted', async () => {
    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '0.0002', ETHUSDT: '0.0001', SOLUSDT: '0.0002' })
    );

    await service['pollFundingRates']();

    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(0);
  });

  it('should handle multiple symbols independently', async () => {
    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '-0.0001', ETHUSDT: '-0.0002', SOLUSDT: '0.0002' })
    );

    await service['pollFundingRates']();

    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('should return cloned map from getCurrentRates', async () => {
    mockBybitClient.getTickers.mockResolvedValue(
      createTickerArray({ BTCUSDT: '0.0001' })
    );

    await service['pollFundingRates']();

    const rates1 = service.getCurrentRates();
    const rates2 = service.getCurrentRates();
    
    expect(rates1).not.toBe(rates2);
    expect(rates1.get('BTCUSDT')).toEqual(rates2.get('BTCUSDT'));
  });

  it('should handle API errors gracefully', async () => {
    mockBybitClient.getTickers.mockRejectedValue(new Error('Network error'));

    await expect(service['pollFundingRates']()).resolves.not.toThrow();
    
    expect(mockNotifier.sendMessage).toHaveBeenCalledTimes(0);
  });

  it('should start and stop polling timer', () => {
    service.start();
    expect(service['timer']).not.toBeNull();

    service.stop();
    expect(service['timer']).toBeNull();
  });

  it('should not start timer twice', () => {
    service.start();
    const firstTimer = service['timer'];
    
    service.start();
    expect(service['timer']).toBe(firstTimer);
  });
});