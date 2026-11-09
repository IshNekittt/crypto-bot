import { Decimal } from 'decimal.js';
import { buildMonthlyBreakdown, generateReport } from '../src/backtest/reporter';
import { TradeResult } from '../src/backtest/executionSimulator';
import { parseMonthlyBreakdown, parseReportMetrics } from '../scripts/matrix_tester';

function trade(entryTime: number, exitTime: number, pnl: string, overrides: Partial<TradeResult> = {}): TradeResult {
  return {
    entryTime,
    exitTime,
    entryPrice: new Decimal('100'),
    exitPrice: new Decimal('101'),
    slPrice: new Decimal('95'),
    tpPrice: new Decimal('110'),
    qty: new Decimal('1'),
    side: 'Buy',
    pnl: new Decimal(pnl),
    pnlPercent: new Decimal('1'),
    feesPaid: new Decimal('0.5'),
    scenarioId: 1,
    scenarioName: 'HTF Continuation',
    closedBy: 'TP',
    ...overrides,
  };
}

describe('Monthly breakdown', () => {
  it('groups by exit month and keeps zero-trade months in the window', () => {
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const periodEnd = new Date(Date.UTC(2026, 3, 1));

    const monthly = buildMonthlyBreakdown(
      [
        trade(Date.UTC(2026, 0, 30), Date.UTC(2026, 1, 2), '50'), // exits in February
        trade(Date.UTC(2026, 1, 10), Date.UTC(2026, 1, 12), '-20'),
        trade(Date.UTC(2026, 2, 5), Date.UTC(2026, 2, 6), '10'),
      ],
      periodStart,
      periodEnd
    );

    expect(monthly.map((entry) => entry.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);

    // A position opened in January but closed in February is booked in February.
    expect(monthly[0].trades).toBe(0);
    expect(monthly[0].netPnl.toFixed(2)).toBe('0.00');

    expect(monthly[1].trades).toBe(2);
    expect(monthly[1].wins).toBe(1);
    expect(monthly[1].losses).toBe(1);
    expect(monthly[1].netPnl.toFixed(2)).toBe('30.00');
    expect(monthly[1].winRatePct.toFixed(2)).toBe('50.00');

    expect(monthly[2].netPnl.toFixed(2)).toBe('10.00');
    expect(monthly[3].trades).toBe(0);
  });

  it('includes a trade that closed outside the nominal window instead of dropping it', () => {
    const monthly = buildMonthlyBreakdown(
      [trade(Date.UTC(2026, 0, 31), Date.UTC(2026, 1, 1), '5')],
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 0, 31))
    );

    expect(monthly.map((entry) => entry.month)).toEqual(['2026-01', '2026-02']);
    expect(monthly[1].netPnl.toFixed(2)).toBe('5.00');
  });

  it('renders a parseable MONTHLY BREAKDOWN section in the text report', () => {
    const trades = [
      trade(Date.UTC(2026, 4, 10), Date.UTC(2026, 4, 11), '120.50'),
      trade(Date.UTC(2026, 4, 20), Date.UTC(2026, 4, 21), '-20.50'),
      trade(Date.UTC(2026, 5, 3), Date.UTC(2026, 5, 4), '80'),
    ];

    const report = generateReport(
      'BTCUSDT',
      new Decimal('1000'),
      new Decimal('1180'),
      trades,
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 5, 30)),
      60,
      new Decimal('5')
    );

    expect(report).toContain('📅 MONTHLY BREAKDOWN');
    expect(report).toContain('2026-05');
    expect(report).toContain('2026-06');
    expect(report).toContain('Profitable months: 2/2');

    const parsed = parseMonthlyBreakdown(report);
    expect(parsed).toEqual([
      { month: '2026-05', netUsd: new Decimal('100'), trades: 2, winRatePct: new Decimal('50') },
      { month: '2026-06', netUsd: new Decimal('80'), trades: 1, winRatePct: new Decimal('100') },
    ]);

    const metrics = parseReportMetrics(report, 'BTCUSDT');
    expect(metrics).not.toBeNull();
    expect(metrics!.monthly).toHaveLength(2);
    expect(metrics!.monthly[0].month).toBe('2026-05');
  });

  it('returns an empty list for reports written before the section existed', () => {
    expect(parseMonthlyBreakdown('BACKTEST REPORT: BTCUSDT\nNet Profit: $1 (0.1%)')).toEqual([]);
  });
});
