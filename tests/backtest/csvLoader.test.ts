import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  aggregateCandles,
  detectCsvIntervalMinutes,
  loadCandlesFromCSV,
  parseCsvTimestamp,
} from '../../src/backtest/csvLoader';
import { resolveOfflineInstrument } from '../../src/backtest/offlineInstruments';
import { Candle } from '../../src/types';

const HEADER = 'timestamp,open,high,low,close,volume';
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

describe('CSV loader', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'smc-csv-loader-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCsv(name: string, lines: string[]): string {
    const filePath = join(dir, name);
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  }

  describe('timestamp parsing', () => {
    it('accepts Unix milliseconds as-is', () => {
      const file = writeCsv('ms.csv', [
        HEADER,
        '1700000000000,100,101,99,100.5,10',
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(1);
      expect(candles[0].timestamp).toBe(1700000000000);
    });

    it('converts Unix seconds to milliseconds', () => {
      const file = writeCsv('seconds.csv', [
        HEADER,
        '1700000000,100,101,99,100.5,10',
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(1);
      expect(candles[0].timestamp).toBe(1700000000000);
    });

    it('parses ISO-8601 strings', () => {
      const file = writeCsv('iso.csv', [
        HEADER,
        '2023-11-14T22:13:20.000Z,100,101,99,100.5,10',
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(1);
      expect(candles[0].timestamp).toBe(Date.parse('2023-11-14T22:13:20.000Z'));
      expect(candles[0].timestamp).toBe(1700000000000);
    });

    it('parses date strings with a space separator', () => {
      const file = writeCsv('space-date.csv', [
        HEADER,
        '2023-11-14 22:13:20,100,101,99,100.5,10',
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(1);
      expect(candles[0].timestamp).toBe(
        Date.parse('2023-11-14 22:13:20'),
      );
    });

    it('rejects an unparseable timestamp with the physical line number', () => {
      const file = writeCsv('bad-time.csv', [
        HEADER,
        'not-a-date,100,101,99,100.5,10',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(
        /Invalid timestamp at line 2/,
      );
    });

    it('rejects non-positive timestamps', () => {
      expect(() => parseCsvTimestamp('0', 7)).toThrow(
        /positive finite value/,
      );
      expect(() => parseCsvTimestamp('-1700000000', 7)).toThrow(
        /positive finite value/,
      );
    });
  });

  describe('field cleaning', () => {
    it('strips surrounding double and single quotes', () => {
      const file = writeCsv('quoted.csv', [
        HEADER,
        '"1700000000","1.2340","1.2350","1.2330","1.2345","123.45"',
        "'1700000900','2.0000','2.1000','1.9000','2.0500','50'",
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(2);
      expect(candles[0]).toEqual({
        timestamp: 1700000000000,
        open: '1.2340',
        high: '1.2350',
        low: '1.2330',
        close: '1.2345',
        volume: '123.45',
      });
      expect(candles[1].open).toBe('2.0000');
      expect(candles[1].close).toBe('2.0500');
    });

    it('tolerates CRLF, a BOM and blank lines', () => {
      const file = join(dir, 'crlf.csv');
      writeFileSync(
        file,
        `\uFEFF${HEADER}\r\n1700000000,100,101,99,100.5,10\r\n\r\n1700000900,101,102,100,101.5,11\r\n`,
        'utf-8',
      );

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(2);
      expect(candles[0].timestamp).toBe(1700000000000);
      expect(candles[1].timestamp).toBe(1700000900000);
    });
  });

  describe('volume policy', () => {
    it('rejects a file without a volume column', () => {
      const file = writeCsv('no-volume.csv', [
        'timestamp,open,high,low,close',
        '1700000000,100,101,99,100.5',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(
        'CSV must contain a valid positive volume column. Parsing aborted.',
      );
    });

    it('rejects an empty volume value', () => {
      const file = writeCsv('empty-volume.csv', [
        HEADER,
        '1700000000,100,101,99,100.5,',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(
        /CSV must contain a valid positive volume column/,
      );
    });

    it('rejects a negative volume value', () => {
      const file = writeCsv('negative-volume.csv', [
        HEADER,
        '1700000000,100,101,99,100.5,-1',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(
        /CSV must contain a valid positive volume column/,
      );
    });

    it('rejects a non-numeric volume value', () => {
      const file = writeCsv('garbage-volume.csv', [
        HEADER,
        '1700000000,100,101,99,100.5,abc',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(
        'CSV must contain a valid positive volume column. Parsing aborted.',
      );
    });

    it('accepts a zero volume value', () => {
      const file = writeCsv('zero-volume.csv', [
        HEADER,
        '1700000000,100,101,99,100.5,0',
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(1);
      expect(candles[0].volume).toBe('0');
    });
  });

  describe('OHLC validation and deduplication', () => {
    it('rejects high < low', () => {
      const file = writeCsv('high-low.csv', [
        HEADER,
        '1700000000,100,98,99,100.5,10',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(/High < Low at line 2/);
    });

    it('rejects high below open or close', () => {
      const file = writeCsv('high-open.csv', [
        HEADER,
        '1700000000,102,101,99,100.5,10',
      ]);

      expect(() => loadCandlesFromCSV(file)).toThrow(
        /High < Open\/Close at line 2/,
      );
    });

    it('sorts rows ascending and removes duplicate timestamps (last wins)', () => {
      const file = writeCsv('duplicates.csv', [
        HEADER,
        '1700000900,101,102,100,101.5,11',
        '1700000000,100,101,99,100.5,10',
        '1700000000,100,101,99,100.9,12',
      ]);

      const candles = loadCandlesFromCSV(file);

      expect(candles).toHaveLength(2);
      expect(candles.map((c) => c.timestamp)).toEqual([
        1700000000000,
        1700000900000,
      ]);
      expect(candles[0].close).toBe('100.9');
      expect(candles[0].volume).toBe('12');
    });
  });
});

describe('detectCsvIntervalMinutes', () => {
  function buildCandles(count: number, stepMs: number): Candle[] {
    const base = Date.UTC(2024, 0, 1, 0, 0, 0);
    return Array.from({ length: count }, (_, i) => ({
      timestamp: base + i * stepMs,
      open: '100',
      high: '101',
      low: '99',
      close: '100.5',
      volume: '10',
    }));
  }

  it('detects a 15m interval', () => {
    expect(detectCsvIntervalMinutes(buildCandles(10, FIFTEEN_MIN_MS))).toBe(15);
  });

  it('detects a 1m interval', () => {
    expect(detectCsvIntervalMinutes(buildCandles(10, 60 * 1000))).toBe(1);
  });

  it('uses the median so a single gap cannot distort the result', () => {
    const candles = buildCandles(10, FIFTEEN_MIN_MS);
    candles[3] = {
      ...candles[3],
      timestamp: candles[2].timestamp + 3 * FIFTEEN_MIN_MS,
    };

    expect(detectCsvIntervalMinutes(candles)).toBe(15);
  });

  it('rejects fewer than two candles', () => {
    expect(() => detectCsvIntervalMinutes(buildCandles(1, FIFTEEN_MIN_MS))).toThrow(
      /at least 2 candles/,
    );
  });
});

describe('aggregateCandles', () => {
  const base = Date.UTC(2024, 0, 1, 0, 0, 0);

  function fifteenMinuteCandles(): Candle[] {
    return Array.from({ length: 16 }, (_, i) => ({
      timestamp: base + i * FIFTEEN_MIN_MS,
      open: String(100 + i),
      high: String(101 + i),
      low: String(99 + i),
      close: String(100.5 + i),
      volume: '10',
    }));
  }

  it('aggregates 15m candles into UTC-aligned 4H buckets with OHLCV economics', () => {
    const candles = fifteenMinuteCandles();
    candles.push({
      timestamp: base + 4 * 60 * 60 * 1000,
      open: '200',
      high: '205',
      low: '195',
      close: '201',
      volume: '5',
    });

    const result = aggregateCandles(candles, 240);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      timestamp: base,
      open: '100',
      high: '116',
      low: '99',
      close: '115.5',
      volume: '160',
    });
    expect(result[1]).toEqual({
      timestamp: base + 4 * 60 * 60 * 1000,
      open: '200',
      high: '205',
      low: '195',
      close: '201',
      volume: '5',
    });
  });

  it('sorts unsorted input before aggregating', () => {
    const candles = fifteenMinuteCandles().reverse();

    const result = aggregateCandles(candles, 240);

    expect(result).toHaveLength(1);
    expect(result[0].open).toBe('100');
    expect(result[0].close).toBe('115.5');
    expect(result[0].high).toBe('116');
    expect(result[0].low).toBe('99');
  });

  it('aggregates 4H candles to daily buckets at UTC midnight', () => {
    const day = Date.UTC(2026, 10, 23);
    const seed = fifteenMinuteCandles()[0];
    const bars = [
      { ...seed, timestamp: day - 4 * 3600_000, high: '120' },
      { ...seed, timestamp: day, open: '105', high: '110' },
      { ...seed, timestamp: day + 4 * 3600_000, high: '108' },
    ];
    const result = aggregateCandles(bars, 'D');
    expect(result.map(c => c.timestamp)).toEqual([day - 86_400_000, day]);
    expect(result[1]).toMatchObject({ open: '105', high: '110', volume: '20' });
  });

  it('aligns weekly and monthly CSV buckets to the calendar', () => {
    const seed = fifteenMinuteCandles()[0];
    const bars = [Date.UTC(2026, 0, 31), Date.UTC(2026, 1, 1), Date.UTC(2026, 1, 2)]
      .map(timestamp => ({ ...seed, timestamp }));
    expect(aggregateCandles(bars, 'W').map(c => c.timestamp))
      .toEqual([Date.UTC(2026, 0, 26), Date.UTC(2026, 1, 2)]);
    expect(aggregateCandles(bars, 'M').map(c => c.timestamp))
      .toEqual([Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1)]);
  });

  it('handles multiple source candles missing from the middle of a bucket', () => {
    const candles = fifteenMinuteCandles().filter((_, i) => i % 2 === 0);

    const result = aggregateCandles(candles, 240);

    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(base);
    expect(result[0].volume).toBe('80');
  });

  it('returns an empty array for empty input', () => {
    expect(aggregateCandles([], 240)).toEqual([]);
  });

  it('rejects a non-positive target interval instead of dividing by zero', () => {
    expect(() => aggregateCandles(fifteenMinuteCandles(), 0)).toThrow(
      /positive finite targetMinutes/,
    );
    expect(() => aggregateCandles(fifteenMinuteCandles(), -15)).toThrow(
      /positive finite targetMinutes/,
    );
    expect(() => aggregateCandles(fifteenMinuteCandles(), Number.NaN)).toThrow(
      /positive finite targetMinutes/,
    );
  });
});

describe('resolveOfflineInstrument', () => {
  it('resolves gold aliases to the canonical XAUUSD specification', () => {
    const expected = {
      symbol: 'XAUUSD',
      tickSize: '0.01',
      qtyStep: '0.01',
      minOrderQty: '0.01',
      maxOrderQty: '1000',
    };

    expect(resolveOfflineInstrument('XAUUSD')).toEqual(expected);
    expect(resolveOfflineInstrument('xauusd')).toEqual(expected);
    expect(resolveOfflineInstrument('GOLD')).toEqual(expected);
    expect(resolveOfflineInstrument('XAU/USD')).toEqual(expected);
  });

  it('resolves FX pairs with 5-decimal precision', () => {
    expect(resolveOfflineInstrument('EURUSD')).toEqual({
      symbol: 'EURUSD',
      tickSize: '0.00001',
      qtyStep: '1000',
      minOrderQty: '1000',
      maxOrderQty: '10000000',
    });
    expect(resolveOfflineInstrument('gbpusd')).toEqual({
      symbol: 'GBPUSD',
      tickSize: '0.00001',
      qtyStep: '1000',
      minOrderQty: '1000',
      maxOrderQty: '10000000',
    });
  });

  it('falls back to the generic specification for unknown symbols', () => {
    expect(resolveOfflineInstrument('TSLA')).toEqual({
      symbol: 'TSLA',
      tickSize: '0.01',
      qtyStep: '0.01',
      minOrderQty: '0.01',
      maxOrderQty: '100000',
    });
  });
});
