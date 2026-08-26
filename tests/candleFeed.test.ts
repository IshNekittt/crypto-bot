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
});
