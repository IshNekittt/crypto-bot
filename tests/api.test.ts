import { BybitClient, parseRestKlines } from '../src/api/bybitClient';
import type { RestClientV5 } from 'bybit-api';

function makeRest(): Record<string, jest.Mock> {
  return {
    getServerTime: jest.fn(),
    getInstrumentsInfo: jest.fn(),
    getKline: jest.fn(),
    getWalletBalance: jest.fn(),
    submitOrder: jest.fn(),
    getPositionInfo: jest.fn(),
    setLeverage: jest.fn(),
    switchIsolatedMargin: jest.fn(),
  };
}

function makeClient(rest: Record<string, jest.Mock> = makeRest()): { client: BybitClient; rest: Record<string, jest.Mock> } {
  const config = {
    apiKey: 'test',
    apiSecret: 'test',
    testnet: true,
    demoTrading: false,
    symbols: ['BTCUSDT'],
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
  };
  return { client: new BybitClient(rest as unknown as RestClientV5, config), rest };
}

describe('parseRestKlines', () => {
  it('converts descending Bybit rows into ascending candles', () => {
    const rows = [
      ['1700003600000', '101', '102', '100', '101.5', '10', '1000'],
      ['1700000000000', '99', '101', '98', '100', '20', '2000'],
    ];
    const candles = parseRestKlines(rows as never);
    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(1700000000000);
    expect(candles[0]).toMatchObject({ open: '99', high: '101', low: '98', close: '100', volume: '20' });
    expect(candles[1].close).toBe('101.5');
  });
});

describe('BybitClient.syncServerTime', () => {
  it('computes offset against local midpoint and reports rtt', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150);
    const { client, rest } = makeClient();
    rest.getServerTime.mockResolvedValue({
      retCode: 0,
      retMsg: 'OK',
      result: { timeSecond: '1700000000', timeNano: '1700000000123456789' },
    });

    const result = await client.syncServerTime();

    expect(result.roundTripMs).toBe(50);
    expect(result.offsetMs).toBe(Math.round(1700000000123.456789 - 125));
    expect(nowSpy).toHaveBeenCalledTimes(2);
  });

  it('throws on non-zero retCode', async () => {
    const { client, rest } = makeClient();
    rest.getServerTime.mockResolvedValue({ retCode: 10001, retMsg: 'error', result: {} });
    await expect(client.syncServerTime()).rejects.toThrow(/\[10001\] error/);
  });
});

describe('BybitClient.getInstrumentInfo', () => {
  const instrumentPayload = (list: unknown[]) => ({
    retCode: 0,
    retMsg: 'OK',
    result: { list },
  });

  it('extracts tick/lot filters for the requested symbol', async () => {
    const { client, rest } = makeClient();
    rest.getInstrumentsInfo.mockResolvedValue(instrumentPayload([{
      symbol: 'SOLUSDT',
      priceFilter: { tickSize: '0.010' },
      lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1', maxOrderQty: '96000' },
    }, {
      symbol: 'BTCUSDT',
      priceFilter: { tickSize: '0.1' },
      lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100' },
    }]));

    const info = await client.getInstrumentInfo('BTCUSDT');
    expect(info).toEqual({
      symbol: 'BTCUSDT',
      tickSize: '0.1',
      qtyStep: '0.001',
      minOrderQty: '0.001',
      maxOrderQty: '100',
    });
  });

  it('throws when symbol is absent from instruments list', async () => {
    const { client, rest } = makeClient();
    rest.getInstrumentsInfo.mockResolvedValue(instrumentPayload([]));
    await expect(client.getInstrumentInfo('BADUSDT')).rejects.toThrow(/not found in Bybit linear instruments/);
  });

  it('throws when lot filters are incomplete', async () => {
    const { client, rest } = makeClient();
    rest.getInstrumentsInfo.mockResolvedValue(instrumentPayload([{
      symbol: 'SOLUSDT',
      priceFilter: { tickSize: '0.01' },
      lotSizeFilter: {},
    }]));
    await expect(client.getInstrumentInfo('SOLUSDT')).rejects.toThrow(/Incomplete lot\/price filters/);
  });
});

describe('BybitClient.getKlines', () => {
  it('returns ascending parsed candles', async () => {
    const { client, rest } = makeClient();
    rest.getKline.mockResolvedValue({
      retCode: 0,
      retMsg: 'OK',
      result: { list: [['2000', '2', '2', '2', '2', '2', '2'], ['1000', '1', '1', '1', '1', '1', '1']] },
    });

    const candles = await client.getKlines('SOLUSDT', '15', 200);
    expect(rest.getKline).toHaveBeenCalledWith({ category: 'linear', symbol: 'SOLUSDT', interval: '15', limit: 200 });
    expect(candles.map((c) => c.timestamp)).toEqual([1000, 2000]);
  });

  it('throws descriptive error on API failure', async () => {
    const { client, rest } = makeClient();
    rest.getKline.mockResolvedValue({ retCode: 10001, retMsg: 'params error', result: {} });
    await expect(client.getKlines('SOLUSDT', '240', 200)).rejects.toThrow(/Kline fetch failed.*\[10001\]/);
  });
});

describe('BybitClient.getUsdtBalance', () => {
  it('reads USDT walletBalance from UNIFIED account', async () => {
    const { client, rest } = makeClient();
    rest.getWalletBalance.mockResolvedValue({
      retCode: 0,
      result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '1234.56' }] }] },
    });

    const balance = await client.getUsdtBalance();
    expect(balance.toFixed(2)).toBe('1234.56');
    expect(rest.getWalletBalance).toHaveBeenCalledWith({ accountType: 'UNIFIED', coin: 'USDT' });
  });

  it('falls back to CONTRACT when UNIFIED fails', async () => {
    const { client, rest } = makeClient();
    rest.getWalletBalance
      .mockRejectedValueOnce(new Error('not unified'))
      .mockResolvedValueOnce({
        retCode: 0,
        result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '777' }] }] },
      });

    const balance = await client.getUsdtBalance();
    expect(balance.toNumber()).toBe(777);
    expect(rest.getWalletBalance).toHaveBeenCalledWith({ accountType: 'CONTRACT', coin: 'USDT' });
  });

  it('throws when both account types fail', async () => {
    const { client, rest } = makeClient();
    rest.getWalletBalance.mockResolvedValue({ retCode: 10001, result: {} });
    await expect(client.getUsdtBalance()).rejects.toThrow(/Failed to fetch USDT balance/);
  });
});

describe('BybitClient.placeMarketOrderWithTpsl', () => {
  it('submits Market IOC order with Full tpsl mode and returns orderId', async () => {
    const { client, rest } = makeClient();
    rest.submitOrder.mockResolvedValue({ retCode: 0, retMsg: 'OK', result: { orderId: 'abc-123' } });

    const orderId = await client.placeMarketOrderWithTpsl({
      symbol: 'SOLUSDT',
      side: 'Buy',
      qty: '2.4',
      stopLoss: '97.70',
      takeProfit: '122.90',
    });

    expect(orderId).toBe('abc-123');
    expect(rest.submitOrder).toHaveBeenCalledWith({
      category: 'linear',
      symbol: 'SOLUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: '2.4',
      timeInForce: 'IOC',
      tpslMode: 'Full',
      stopLoss: '97.70',
      takeProfit: '122.90',
    });
  });

  it('throws formatted error when exchange rejects the order', async () => {
    const { client, rest } = makeClient();
    rest.submitOrder.mockResolvedValue({ retCode: 110007, retMsg: 'Insufficient balance', result: {} });
    await expect(client.placeMarketOrderWithTpsl({
      symbol: 'SOLUSDT', side: 'Buy', qty: '1', stopLoss: '1', takeProfit: '2',
    })).rejects.toThrow(/\[110007\] Insufficient balance/);
  });

  it('throws when response has no orderId', async () => {
    const { client, rest } = makeClient();
    rest.submitOrder.mockResolvedValue({ retCode: 0, retMsg: 'OK', result: {} });
    await expect(client.placeMarketOrderWithTpsl({
      symbol: 'SOLUSDT', side: 'Sell', qty: '1', stopLoss: '1', takeProfit: '2',
    })).rejects.toThrow();
  });
});

describe('BybitClient.setupMarginAndLeverage', () => {
  it('treats leverage-not-modified (110043) as success', async () => {
    const { client, rest } = makeClient();
    rest.switchIsolatedMargin.mockResolvedValue({ retCode: 0, retMsg: 'ok' });
    rest.setLeverage.mockResolvedValue({ retCode: 110043, retMsg: 'leverage not modified' });

    await expect(client.setupMarginAndLeverage('SOLUSDT', '10')).resolves.toBeUndefined();
    expect(rest.setLeverage).toHaveBeenCalledWith({
      category: 'linear', symbol: 'SOLUSDT', buyLeverage: '10', sellLeverage: '10',
    });
  });

  it('throws on genuine leverage failure', async () => {
    const { client, rest } = makeClient();
    rest.switchIsolatedMargin.mockResolvedValue({ retCode: 0, retMsg: 'ok' });
    rest.setLeverage.mockResolvedValue({ retCode: 10001, retMsg: 'invalid leverage' });

    await expect(client.setupMarginAndLeverage('SOLUSDT', '999')).rejects.toThrow(/Set leverage failed/);
  });

  it('does not fail flow when isolated margin switch errors', async () => {
    const { client, rest } = makeClient();
    rest.switchIsolatedMargin.mockRejectedValue(new Error('network down'));
    rest.setLeverage.mockResolvedValue({ retCode: 0, retMsg: 'OK' });

    await expect(client.setupMarginAndLeverage('SOLUSDT', '5')).resolves.toBeUndefined();
  });
});

describe('BybitClient.getOpenPositions', () => {
  it('filters out zero-size and None-side entries', async () => {
    const { client, rest } = makeClient();
    rest.getPositionInfo.mockResolvedValue({
      retCode: 0,
      result: {
        list: [
          { symbol: 'SOLUSDT', side: 'Buy', size: '2.4', avgPrice: '105.1' },
          { symbol: 'SOLUSDT', side: 'None', size: '0', avgPrice: '0' },
          { symbol: 'SOLUSDT', side: 'Sell', size: '0', avgPrice: '0' },
        ],
      },
    });

    const positions = await client.getOpenPositions('SOLUSDT');
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe('Buy');
    expect(positions[0].size.toNumber()).toBe(2.4);
  });

  it('throws on API failure', async () => {
    const { client, rest } = makeClient();
    rest.getPositionInfo.mockResolvedValue({ retCode: 10001, retMsg: 'err', result: {} });
    await expect(client.getOpenPositions('SOLUSDT')).rejects.toThrow(/Position list failed/);
  });
});
