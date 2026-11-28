import { CandleFeed, mergeCandle } from '../src/feed/candleFeed';
import { Candle } from '../src/types';

function candle(timestamp: number): Candle {
  return { timestamp, open: '100', high: '101', low: '99', close: '100.5', volume: '10' };
}

function update(symbol: string, interval: string, confirmed: boolean, timestamp: number) {
  return {
    symbol,
    interval,
    confirmed,
    candle: candle(timestamp),
  };
}

describe('mergeCandle', () => {
  it('returns single-candle buffer when empty', () => {
    expect(mergeCandle([], candle(5), 3)).toEqual([candle(5)]);
  });

  it('appends newer candle', () => {
    const result = mergeCandle([candle(1), candle(2)], candle(3), 10);
    expect(result.map((c) => c.timestamp)).toEqual([1, 2, 3]);
  });

  it('replaces last candle on duplicate timestamp (reclose)', () => {
    const result = mergeCandle([candle(1), candle(2)], candle(2), 10);
    expect(result).toHaveLength(2);
    expect(result[1].open).toBe('100');
    expect(result).not.toBe([candle(1), candle(2)][0]);
  });

  it('ignores stale older candle', () => {
    const result = mergeCandle([candle(2)], candle(1), 10);
    expect(result.map((c) => c.timestamp)).toEqual([2]);
  });

  it('shifts oldest candle beyond capacity', () => {
    let buffer: Candle[] = [];
    for (let ts = 1; ts <= 4; ts++) {
      buffer = mergeCandle(buffer, candle(ts), 3);
    }
    expect(buffer.map((c) => c.timestamp)).toEqual([2, 3, 4]);
  });
});

describe('CandleFeed', () => {
  function feed(): CandleFeed {
    return new CandleFeed('SOLUSDT', '15', 200);
  }

  const historySource = {
    getKlines: async (): Promise<readonly Candle[]> => [candle(100), candle(200), candle(300)],
  };

  it('loads history preserving ascending order', async () => {
    const f = feed();
    await f.loadHistory(historySource);
    expect(f.getCandles().map((c) => c.timestamp)).toEqual([100, 200, 300]);
    expect(f.getLastClosed()?.timestamp).toBe(300);
  });

  it('does not preload the forming daily bar as a confirmed HTF close', async () => {
    const midnight = Date.UTC(2026, 10, 23);
    const now = jest.spyOn(Date, 'now').mockReturnValue(midnight + 4 * 3600_000);
    try {
      const f = new CandleFeed('SOLUSDT', 'D', 1);
      const source = { getKlines: jest.fn().mockResolvedValue([candle(midnight - 86_400_000), candle(midnight)]) };
      await f.loadHistory(source);
      expect(source.getKlines).toHaveBeenCalledWith('SOLUSDT', 'D', 2);
      expect(f.getCandles()).toEqual([candle(midnight - 86_400_000)]);
      f.applyKline(update('SOLUSDT', 'D', true, midnight));
      expect(f.getCandles()).toEqual([candle(midnight)]);
    } finally {
      now.mockRestore();
    }
  });

  it('applies only confirmed klines of its own symbol and interval', async () => {
    const f = feed();
    await f.loadHistory(historySource);

    f.applyKline(update('BTCUSDT', '15', true, 400));
    f.applyKline(update('SOLUSDT', '240', true, 400));
    f.applyKline(update('SOLUSDT', '15', false, 400));
    expect(f.getLastClosed()?.timestamp).toBe(300);

    f.applyKline(update('SOLUSDT', '15', true, 400));
    expect(f.getCandles().map((c) => c.timestamp)).toEqual([100, 200, 300, 400]);
  });

  it('starts with empty buffer', () => {
    expect(feed().getLastClosed()).toBeNull();
    expect(feed().getCandles()).toHaveLength(0);
  });

  it('enforces capacity limit by shifting oldest candles (FIFO)', () => {
    const capacity = 5;
    const f = new CandleFeed('TEST', '15', capacity);
    // Push 8 candles (capacity + 3)
    for (let i = 1; i <= 8; i++) {
      f.applyKline({ symbol: 'TEST', interval: '15', confirmed: true, candle: { timestamp: i * 1000, open: '100', high: '101', low: '99', close: '100.5', volume: '10' } });
    }
    const candles = f.getCandles();
    expect(candles).toHaveLength(capacity);
    // Oldest 3 should be dropped (1, 2, 3)
    expect(candles[0].timestamp).toBe(4 * 1000);
    expect(candles[candles.length - 1].timestamp).toBe(8 * 1000);
  });

  it('getCurrentFormingCandle returns unconfirmed candle', () => {
    const f = new CandleFeed('TEST', '15', 100);
    f.applyKline({ symbol: 'TEST', interval: '15', confirmed: false, candle: { timestamp: 1000, open: '100', high: '101', low: '99', close: '100.5', volume: '10' } });
    expect(f.getCurrentFormingCandle()?.timestamp).toBe(1000);
    // After confirmation, forming candle should be cleared
    f.applyKline({ symbol: 'TEST', interval: '15', confirmed: true, candle: { timestamp: 1000, open: '100', high: '101', low: '99', close: '100.5', volume: '10' } });
    expect(f.getCurrentFormingCandle()).toBeNull();
  });

  it('loadHistory replaces buffer with history data', async () => {
    const f = feed();
    await f.loadHistory(historySource);
    expect(f.getCandles()).toHaveLength(3);
    // Add more candles
    f.applyKline({ symbol: 'SOLUSDT', interval: '15', confirmed: true, candle: { timestamp: 400, open: '100', high: '101', low: '99', close: '100.5', volume: '10' } });
    f.applyKline({ symbol: 'SOLUSDT', interval: '15', confirmed: true, candle: { timestamp: 500, open: '100', high: '101', low: '99', close: '100.5', volume: '10' } });
    // loadHistory should replace, not append
    await f.loadHistory({ getKlines: async () => [candle(600), candle(700), candle(800), candle(900)] });
    expect(f.getCandles()).toHaveLength(4);
    expect(f.getCandles().map(c => c.timestamp)).toEqual([600, 700, 800, 900]);
  });
});
