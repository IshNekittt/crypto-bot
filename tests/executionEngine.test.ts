import { ExecutionEngine, OrderSubmitter } from '../src/execution/executionEngine';
import { PositionPlan } from '../src/risk/riskManager';
import { TelegramNotifier } from '../src/telegram/notifier';

type FetchMock = jest.Mock<Promise<Pick<Response, 'ok' | 'status' | 'text'>>>;

function plan(symbol = 'SOLUSDT'): PositionPlan {
  return {
    symbol,
    side: 'Buy',
    entryPrice: '100',
    stopLoss: '99',
    takeProfit: '103',
    qty: '2',
    slDistance: '1',
    riskAmount: '20',
    riskPercentApplied: '2',
    balanceUsdt: '1000',
  };
}

function makeEngine(submitImpl: () => Promise<string>) {
  const submitter: OrderSubmitter = { placeMarketOrderWithTpsl: jest.fn(submitImpl) };
  const fetchSpy: FetchMock = jest.fn();
  fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
  global.fetch = fetchSpy as unknown as typeof global.fetch;
  const notifier = new TelegramNotifier('123:TEST', '42');
  const engine = new ExecutionEngine(submitter, notifier);
  return {
    engine,
    notifier,
    submitMock: submitter.placeMarketOrderWithTpsl as jest.Mock,
    fetchSpy,
    sentTexts: () => fetchSpy.mock.calls.map(([, init]) => String((init as RequestInit).body)),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ExecutionEngine.execute', () => {
  it('submits market order with plan values and fires 🚀 alert on success', async () => {
    const { engine, submitMock, sentTexts } = makeEngine(async () => 'order-123');

    const result = await engine.execute(plan());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orderId).toBe('order-123');
    expect(submitMock).toHaveBeenCalledWith({
      symbol: 'SOLUSDT',
      side: 'Buy',
      qty: '2',
      stopLoss: '99',
      takeProfit: '103',
    });
    const rocket = sentTexts().find((t) => t.includes('🚀'));
    expect(rocket).toBeDefined();
  });

  it('returns failure and alerts critical error when order is rejected', async () => {
    const { engine, sentTexts } = makeEngine(async () => {
      throw new Error('[10001] invalid parameter');
    });

    const result = await engine.execute(plan());
    expect(result.ok).toBe(false);
    expect(sentTexts().some((t) => t.includes('ордер отклонён — [10001] invalid parameter'))).toBe(true);
  });

  it('trips circuit breaker after 3 consecutive rate/margin errors', async () => {
    let calls = 0;
    const { engine, sentTexts } = makeEngine(async () => {
      calls += 1;
      throw new Error(`[110007] Insufficient wallet balance (${calls})`);
    });

    await engine.execute(plan());
    await engine.execute(plan());
    expect(engine.isBlocked('SOLUSDT')).toBe(false);

    await engine.execute(plan());
    expect(engine.isBlocked('SOLUSDT')).toBe(true);
    expect(sentTexts().some((t) => t.includes('circuit breaker'))).toBe(true);

    calls = 0;
    const blockedResult = await engine.execute(plan());
    expect(blockedResult.ok).toBe(false);
    expect(calls).toBe(0);
    expect(sentTexts().filter((t) => t.includes('🚀'))).toHaveLength(0);
  });

  it('does not trip breaker when errors are interrupted by success', async () => {
    let fail = true;
    const { engine } = makeEngine(async () => {
      if (fail) throw new Error('[10006] Too many visits');
      return 'ok-id';
    });

    await engine.execute(plan());
    await engine.execute(plan());
    fail = false;
    await engine.execute(plan());
    fail = true;
    await engine.execute(plan());
    await engine.execute(plan());
    expect(engine.isBlocked('SOLUSDT')).toBe(false);
  });

  it('tracks circuit breakers per symbol independently', async () => {
    let fail = true;
    const { engine } = makeEngine(async () => {
      if (fail) throw new Error('[110007] insufficient margin');
      return 'ok';
    });

    await engine.execute(plan('BTCUSDT'));
    await engine.execute(plan('BTCUSDT'));
    await engine.execute(plan('BTCUSDT'));

    expect(engine.isBlocked('BTCUSDT')).toBe(true);
    expect(engine.isBlocked('ETHUSDT')).toBe(false);
  });
});
