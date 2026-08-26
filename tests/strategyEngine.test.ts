import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import { BybitClient, OpenPosition } from '../src/api/bybitClient';
import { ExecutionEngine } from '../src/execution/executionEngine';
import { StrategyEngine, WAITING_ANTI_STUCK_CANDLES_4H } from '../src/engine/strategyEngine';
import { ReconciliationLoop } from '../src/bootstrap/reconciliation';
import { RiskManager } from '../src/risk/riskManager';
import { StateDatabase } from '../src/db/database';
import { TelegramNotifier } from '../src/telegram/notifier';
import { Candle, InstrumentInfo, StrategyState } from '../src/types';

const INSTRUMENT: InstrumentInfo = {
  symbol: 'SOLUSDT',
  tickSize: '0.01',
  qtyStep: '0.1',
  minOrderQty: '0.1',
  maxOrderQty: '10000',
};

let tsCounter = 0;

function candle(open: string, high: string, low: string, close: string): Candle {
  return {
    timestamp: ++tsCounter * 60_000,
    open,
    high,
    low,
    close,
    volume: '10',
  };
}

function kline(interval: string, candle: Candle) {
  return { symbol: 'SOLUSDT', interval, confirmed: true, candle };
}

function baseWithBullishBreak(sweepSetup: boolean): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) {
    if (sweepSetup && i === 4) {
      candles.push(candle('99.75', '100', '98', '100'));
    } else if (i === 5) {
      candles.push(candle('99.75', '105', '99', '100'));
    } else if (i === 8) {
      candles.push(candle('100.4', '100.5', sweepSetup ? '97.8' : '99.6', '100'));
    } else {
      candles.push(candle('99.75', '100', '99', '100'));
    }
  }
  candles.push(candle('104.5', '106', '104', '105.5'));
  return candles;
}

type FetchSpy = jest.Mock<Promise<Pick<Response, 'ok' | 'status' | 'text'>>>;

describe('StrategyEngine lifecycle', () => {
  let db: StateDatabase;
  let dir: string;
  let submitMock: jest.Mock;
  let fetchSpy: FetchSpy;
  let engine: StrategyEngine;
  let positionsOnExchange: OpenPosition[];

  function buildEngine(): StrategyEngine {
    const notifier = new TelegramNotifier('123:TEST', '42');
    const riskManager = new RiskManager(
      { getUsdtBalance: async () => new Decimal('1000') },
      db,
      { baseRiskPercent: '2', reducedRiskPercent: '1' },
    );
    const executionEngine = new ExecutionEngine(
      { placeMarketOrderWithTpsl: submitMock },
      notifier,
    );
    const fakeClient = {
      getKlines: async (_symbol: string, interval: string): Promise<readonly Candle[]> =>
        interval === '240' ? baseWithBullishBreak(true) : baseWithBullishBreak(true),
      getOpenPositions: async (): Promise<readonly OpenPosition[]> => positionsOnExchange,
    };
    return new StrategyEngine({
      symbol: 'SOLUSDT',
      instrument: INSTRUMENT,
      client: fakeClient as unknown as BybitClient,
      db,
      riskManager,
      executionEngine,
      notifier,
    });
  }

  async function driveToInTrade(): Promise<void> {
    await engine.handleKline(kline('240', candle('101', '101.5', '101', '101.3')));
    expect(engine.getState()).toBe(StrategyState.WAITING);
    await engine.handleKline(kline('240', candle('101', '101.5', '100.2', '100.8')));
    expect(engine.getState()).toBe(StrategyState.CONFIRMATION);
    await engine.handleKline(kline('15', candle('105.6', '106.2', '105.1', '105.4')));
    expect(engine.getState()).toBe(StrategyState.ENTRY_STAGED);
    await engine.handleKline(kline('15', candle('103.9', '104.05', '102.5', '102.8')));
    expect(engine.getState()).toBe(StrategyState.IN_TRADE);
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-engine-'));
    db = new StateDatabase(dir);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tsCounter = 1_000;
    submitMock = jest.fn();
    fetchSpy = jest.fn();
    fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    positionsOnExchange = [];
    db.setSymbolState('SOLUSDT', StrategyState.SCANNING);
    engine = buildEngine();
    await engine.initialize();
    expect(engine.getState()).toBe(StrategyState.SCANNING);
  });

  afterEach(() => {
    const leftover = db.getOpenTrade('SOLUSDT');
    if (leftover) db.closeTrade(leftover.id, null, null, Date.now());
    jest.restoreAllMocks();
  });

  it('walks SCANNING → WAITING → CONFIRMATION → ENTRY_STAGED → IN_TRADE and alerts Telegram', async () => {
    submitMock.mockResolvedValue('order-777');

    await driveToInTrade();

    expect(submitMock).toHaveBeenCalledTimes(1);
    const submitted = submitMock.mock.calls[0][0] as {
      symbol: string;
      side: string;
      qty: string;
      stopLoss: string;
      takeProfit: string;
    };
    expect(submitted.symbol).toBe('SOLUSDT');
    expect(submitted.side).toBe('Buy');
    expect(submitted.qty).toBe('2.7');
    expect(submitted.stopLoss).toMatch(/^97\.7(0)?$/);
    expect(submitted.takeProfit).toMatch(/^127\.3(0)?$/);

    const bodies = fetchSpy.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(bodies.some((t) => t.includes('👀 Найден сетап по SOLUSDT'))).toBe(true);
    expect(bodies.some((t) => t.includes(`Вход: 105.1, SL: ${submitted.stopLoss}, TP: ${submitted.takeProfit}`))).toBe(true);
    expect(bodies.some((t) => t.includes('🚀'))).toBe(true);

    const openTrade = db.getOpenTrade('SOLUSDT');
    expect(openTrade?.status).toBe('OPEN');
    expect(openTrade?.orderId).toBe('order-777');
    expect(openTrade?.qty).toBe('2.7');
  });

  it('closes trade and returns to SCANNING on private WS position close event', async () => {
    submitMock.mockResolvedValue('order-778');
    await driveToInTrade();
    const tradeId = db.getOpenTrade('SOLUSDT')?.id;
    expect(tradeId).toBeDefined();

    await engine.handlePositionPayload({
      topic: 'position',
      data: [{ symbol: 'SOLUSDT', side: 'Buy', size: '0' }],
    });

    expect(engine.getState()).toBe(StrategyState.SCANNING);
    expect(db.getOpenTrade('SOLUSDT')).toBeNull();
    const closed = db.getRecentClosedTrades(1);
    expect(closed[0].id).toBe(tradeId);
    expect(closed[0].pnl).toBeNull();
    expect(fetchSpy.mock.calls.map(([, init]) => String((init as RequestInit).body)))
      .not.toContain(expect.stringContaining('Позиция закрыта'));
  });

  it('anti-stuck: returns to SCANNING after 30 untouched 4H candles in WAITING', async () => {
    await engine.handleKline(kline('240', candle('101', '101.5', '101', '101.3')));
    expect(engine.getState()).toBe(StrategyState.WAITING);

    for (let i = 0; i < WAITING_ANTI_STUCK_CANDLES_4H - 1; i++) {
      await engine.handleKline(kline('240', candle('110', '110.5', '109.5', '110')));
      expect(engine.getState()).toBe(StrategyState.WAITING);
    }
    await engine.handleKline(kline('240', candle('110', '110.5', '109.5', '110')));
    expect(engine.getState()).toBe(StrategyState.SCANNING);
  });

  describe('reconciliation', () => {
    it('keeps IN_TRADE while exchange still reports the position', async () => {
      submitMock.mockResolvedValue('order-779');
      await driveToInTrade();

      positionsOnExchange = [{ symbol: 'SOLUSDT', side: 'Buy', size: new Decimal('2.7'), avgPrice: new Decimal('105.1') }];
      const loop = new ReconciliationLoop(
        { getOpenPositions: async () => positionsOnExchange },
        [engine],
      );
      expect(await loop.tick()).toBe(0);
      expect(engine.getState()).toBe(StrategyState.IN_TRADE);
    });

    it('force-resets to SCANNING when position vanished on exchange (Блок 7)', async () => {
      submitMock.mockResolvedValue('order-780');
      await driveToInTrade();
      const tradeId = db.getOpenTrade('SOLUSDT')?.id;

      positionsOnExchange = [];
      const loop = new ReconciliationLoop(
        { getOpenPositions: async () => positionsOnExchange },
        [engine],
      );
      expect(await loop.tick()).toBe(1);

      expect(engine.getState()).toBe(StrategyState.SCANNING);
      expect(db.getOpenTrade('SOLUSDT')).toBeNull();
      expect(db.getRecentClosedTrades(1)[0].id).toBe(tradeId);
    });

    it('ignores symbols that are not IN_TRADE', async () => {
      const loop = new ReconciliationLoop(
        { getOpenPositions: async () => [] },
        [engine],
      );
      expect(await loop.tick()).toBe(0);
      expect(engine.getState()).toBe(StrategyState.SCANNING);
    });
  });
});
