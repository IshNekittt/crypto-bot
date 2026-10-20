import { Decimal } from 'decimal.js';
import {
  buildTradingViewCandles,
  buildTradingViewMarkers,
  describeCandleInterval,
  generateEquityCurveHtml,
} from '../src/backtest/reporter';
import { TradeResult } from '../src/backtest/executionSimulator';

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const MINUTE = 60 * 1000;

function candle(timestamp: number, open: string, high: string, low: string, close: string) {
  return { timestamp, open, high, low, close, volume: '1' };
}

function trade(overrides: Partial<TradeResult> = {}): TradeResult {
  return {
    entryTime: BASE_MS,
    exitTime: BASE_MS + 15 * MINUTE,
    entryPrice: new Decimal('100'),
    exitPrice: new Decimal('110'),
    slPrice: new Decimal('95'),
    tpPrice: new Decimal('110'),
    qty: new Decimal('1'),
    side: 'Buy',
    pnl: new Decimal('10'),
    pnlPercent: new Decimal('10'),
    feesPaid: new Decimal('0.5'),
    scenarioId: 6,
    scenarioName: 'SMS',
    closedBy: 'TP',
    ...overrides,
  };
}

describe('TradingView candle conversion', () => {
  it('converts string OHLC to numbers and ms timestamps to seconds', () => {
    const result = buildTradingViewCandles([
      candle(BASE_MS, '100.5', '101.25', '99.75', '100.125'),
    ]);

    expect(result).toEqual([
      { time: BASE_MS / 1000, open: 100.5, high: 101.25, low: 99.75, close: 100.125 },
    ]);
  });

  it('sorts candles ascending and keeps one candle per timestamp', () => {
    const result = buildTradingViewCandles([
      candle(BASE_MS + 15 * MINUTE, '2', '3', '1', '2.5'),
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS, '1', '2.5', '0.5', '2'),
    ]);

    expect(result.map((c) => c.time)).toEqual([BASE_MS / 1000, (BASE_MS + 15 * MINUTE) / 1000]);
    // Duplicate timestamp: the last candle wins.
    expect(result[0].close).toBe(2);
  });

  it('drops malformed candles instead of poisoning the series with NaN', () => {
    const result = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + MINUTE, 'abc', '2', '0.5', '1.5'),
      { timestamp: Number.NaN, open: '1', high: '2', low: '0.5', close: '1.5' },
      null,
    ]);

    expect(result).toHaveLength(1);
  });
});

describe('TradingView trade markers', () => {
  it('snaps entry/exit times to the latest candle at or before the event', () => {
    const candles = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + 15 * MINUTE, '2', '3', '1', '2.5'),
      candle(BASE_MS + 30 * MINUTE, '3', '4', '2', '3.5'),
    ]);

    const markers = buildTradingViewMarkers(
      [trade({ entryTime: BASE_MS + 7 * MINUTE, exitTime: BASE_MS + 16 * MINUTE })],
      candles
    );

    expect(markers.map((m) => m.time)).toEqual([
      BASE_MS / 1000,
      (BASE_MS + 15 * MINUTE) / 1000,
    ]);
  });

  it('always produces times that exist in the candle series', () => {
    const candles = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + 15 * MINUTE, '2', '3', '1', '2.5'),
    ]);
    const candleTimes = new Set(candles.map((c) => c.time));

    const markers = buildTradingViewMarkers(
      [
        trade({ entryTime: BASE_MS - 60 * MINUTE, exitTime: BASE_MS + 60 * MINUTE }),
        trade({ entryTime: BASE_MS + 3 * MINUTE, exitTime: BASE_MS + 21 * MINUTE, side: 'Sell' }),
      ],
      candles
    );

    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(candleTimes.has(marker.time)).toBe(true);
    }
  });

  it('sorts markers ascending by time so Lightweight Charts accepts them', () => {
    const candles = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + 15 * MINUTE, '2', '3', '1', '2.5'),
      candle(BASE_MS + 30 * MINUTE, '3', '4', '2', '3.5'),
    ]);

    // Unsorted trades on purpose.
    const markers = buildTradingViewMarkers(
      [
        trade({ entryTime: BASE_MS + 30 * MINUTE, exitTime: BASE_MS + 40 * MINUTE }),
        trade({ entryTime: BASE_MS, exitTime: BASE_MS + 15 * MINUTE }),
      ],
      candles
    );

    const times = markers.map((m) => m.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('orients markers by side and outcome', () => {
    const candles = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + 15 * MINUTE, '2', '3', '1', '2.5'),
    ]);

    const [entry, exit] = buildTradingViewMarkers(
      [trade({ entryTime: BASE_MS, exitTime: BASE_MS + 15 * MINUTE, pnl: new Decimal('-3'), closedBy: 'SL' })],
      candles
    );

    expect(entry.position).toBe('belowBar');
    expect(entry.shape).toBe('arrowUp');
    expect(exit.position).toBe('belowBar');
    expect(exit.shape).toBe('circle');
    expect(exit.text).toBe('SL');
  });

  it('returns no markers when there are no candles to anchor them to', () => {
    expect(buildTradingViewMarkers([trade()], [])).toEqual([]);
  });
});

describe('Candle interval label', () => {
  it('derives the timeframe from the candle spacing', () => {
    const fifteenMinutes = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + 15 * MINUTE, '2', '3', '1', '2.5'),
      candle(BASE_MS + 30 * MINUTE, '3', '4', '2', '3.5'),
    ]);
    expect(describeCandleInterval(fifteenMinutes)).toBe('15m');

    const fourHours = buildTradingViewCandles([
      candle(BASE_MS, '1', '2', '0.5', '1.5'),
      candle(BASE_MS + 240 * MINUTE, '2', '3', '1', '2.5'),
    ]);
    expect(describeCandleInterval(fourHours)).toBe('4H');
  });

  it('returns an empty label for insufficient data', () => {
    expect(describeCandleInterval([])).toBe('');
    expect(describeCandleInterval(buildTradingViewCandles([candle(BASE_MS, '1', '2', '0.5', '1.5')]))).toBe('');
  });
});

describe('HTML artifact with trade overlay', () => {
  it('embeds the Lightweight Charts CDN, the chart container and the candle data', () => {
    const html = generateEquityCurveHtml(
      'BTCUSDT',
      new Decimal('1000'),
      new Decimal('1100'),
      [trade()],
      new Date(BASE_MS),
      new Date(BASE_MS + 24 * 60 * MINUTE),
      new Decimal('5'),
      [candle(BASE_MS, '100', '110', '90', '105'), candle(BASE_MS + 15 * MINUTE, '105', '115', '95', '110')]
    );

    expect(html).toContain('lightweight-charts.standalone.production.js');
    expect(html).toContain('id="tvchart"');
    expect(html).toContain('Asset Price &amp; Trade Overlay (15m)');
    expect(html).toContain(`"time":${BASE_MS / 1000}`);
    expect(html).toContain('"open":100');
  });

  it('still renders without candle data', () => {
    const html = generateEquityCurveHtml(
      'BTCUSDT',
      new Decimal('1000'),
      new Decimal('1100'),
      [trade()],
      new Date(BASE_MS),
      new Date(BASE_MS + 24 * 60 * MINUTE),
      new Decimal('5'),
      []
    );

    expect(html).toContain('id="tvchart"');
    expect(html).toContain('const CANDLE_DATA = [];');
    expect(html).toContain('const MARKER_DATA = [];');
  });
});
