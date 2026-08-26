import { Decimal } from 'decimal.js';
import { RiskManager, TradeHistorySource } from '../src/risk/riskManager';
import { InstrumentInfo, TradeRecord } from '../src/types';

const INSTRUMENT: InstrumentInfo = {
  symbol: 'SOLUSDT',
  tickSize: '0.01',
  qtyStep: '0.1',
  minOrderQty: '0.1',
  maxOrderQty: '10000',
};

function tradeRecord(id: number, pnl: string | null): TradeRecord {
  return {
    id,
    symbol: 'SOLUSDT',
    side: 'Buy',
    entryPrice: '100',
    stopLoss: '90',
    takeProfit: '130',
    qty: '2',
    status: 'CLOSED',
    pnl,
    exitPrice: pnl === null ? null : '95',
    openedAt: id * 1000,
    closedAt: id * 1000 + 500,
    orderId: null,
  };
}

function historySource(pnls: (string | null)[]): TradeHistorySource {
  return {
    getRecentClosedTrades: (limit) =>
      pnls.slice(0, limit).map((pnl, i) => tradeRecord(i + 1, pnl)),
  };
}

const balanceSource = { getUsdtBalance: async () => new Decimal('1000') };

function riskManager(pnls: (string | null)[] = []): RiskManager {
  return new RiskManager(balanceSource, historySource(pnls), {
    baseRiskPercent: '2',
    reducedRiskPercent: '1',
  });
}

function planInput(overrides?: Partial<{ entry: string; sl: string; side: 'Buy' | 'Sell' }>) {
  const { entry = '100', sl = '90', side = 'Buy' as const } = overrides ?? {};
  return {
    symbol: 'SOLUSDT',
    side,
    entryPrice: new Decimal(entry),
    stopLossRaw: new Decimal(sl),
    instrument: INSTRUMENT,
  };
}

describe('RiskManager.getEffectiveRiskPercent', () => {
  it('returns base risk normally', async () => {
    await expect(riskManager().getEffectiveRiskPercent().then((d) => d.toNumber())).resolves.toBe(2);
  });

  it('cuts risk to reduced level after 3 consecutive losses', async () => {
    const rm = riskManager(['-5', '-5.5', '-0.01']);
    await expect(rm.getEffectiveRiskPercent().then((d) => d.toNumber())).resolves.toBe(1);
  });

  it('ignores fewer than 3 losses', async () => {
    const rm = riskManager(['-5', '-5']);
    await expect(rm.getEffectiveRiskPercent().then((d) => d.toNumber())).resolves.toBe(2);
  });

  it('returns to base risk after a profitable trade', async () => {
    const rm = riskManager(['5', '-5', '-5']);
    await expect(rm.getEffectiveRiskPercent().then((d) => d.toNumber())).resolves.toBe(2);
  });
});

describe('RiskManager.calculatePosition', () => {
  it('calculates lot from balance, risk percent and SL distance', async () => {
    const result = await riskManager().calculatePosition(planInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.balanceUsdt).toBe('1000');
    expect(result.plan.riskAmount).toBe('20');
    expect(result.plan.slDistance).toBe('10');
    expect(result.plan.qty).toBe('2');
    expect(result.plan.entryPrice).toBe('100');
    expect(result.plan.stopLoss).toBe('90');
    expect(result.plan.takeProfit).toBe('130');
  });

  it('halves the position under drawdown guard', async () => {
    const result = await riskManager(['-1', '-1', '-1']).calculatePosition(planInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.riskPercentApplied).toBe('1');
    expect(result.plan.riskAmount).toBe('10');
    expect(result.plan.qty).toBe('1');
  });

  it('rounds qty DOWN to qtyStep, never up', async () => {
    const rm = new RiskManager(
      { getUsdtBalance: async () => new Decimal('1000') },
      historySource([]),
      { baseRiskPercent: '2', reducedRiskPercent: '1' },
    );
    const result = await rm.calculatePosition(planInput({ entry: '103', sl: '100' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.slDistance).toBe('3');
    expect(result.plan.qty).toBe('6.6');
  });

  it('rounds prices to tickSize and derives TP strictly at 1:3 RR', async () => {
    const result = await riskManager().calculatePosition(planInput({
      entry: '100.123456',
      sl: '89.999999',
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.entryPrice).toBe('100.12');
    expect(result.plan.stopLoss).toBe('89.99');
    expect(result.plan.slDistance).toBe('10.13');
    expect(result.plan.takeProfit).toBe('130.51');
    expect(new Decimal(result.plan.takeProfit)
      .minus(result.plan.entryPrice)
      .div(result.plan.slDistance)
      .toNumber()).toBe(3);
  });

  it('derives TP for short side strictly at 1:3 RR below entry', async () => {
    const result = await riskManager().calculatePosition(planInput({ side: 'Sell', entry: '100', sl: '110' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.slDistance).toBe('10');
    expect(result.plan.takeProfit).toBe('70');
  });

  it('aborts when rounded qty is below minOrderQty', async () => {
    const rm = new RiskManager(
      { getUsdtBalance: async () => new Decimal('5') },
      historySource([]),
      { baseRiskPercent: '2', reducedRiskPercent: '1' },
    );
    const result = await rm.calculatePosition(planInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('minOrderQty');
  });

  it('aborts when qty exceeds maxOrderQty', async () => {
    const rm = new RiskManager(
      { getUsdtBalance: async () => new Decimal('100000000') },
      historySource([]),
      { baseRiskPercent: '2', reducedRiskPercent: '1' },
    );
    const result = await rm.calculatePosition(planInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('maxOrderQty');
  });

  it('aborts when SL is on the wrong side of entry for long', async () => {
    const result = await riskManager().calculatePosition(planInput({ sl: '110' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('invalid SL');
  });

  it('validates short side geometry correctly', async () => {
    const result = await riskManager().calculatePosition(planInput({ side: 'Sell', entry: '100', sl: '110' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.slDistance).toBe('10');
    expect(result.plan.qty).toBe('2');
  });
});
