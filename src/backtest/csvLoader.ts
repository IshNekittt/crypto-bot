import { readFileSync } from 'fs';
import { Decimal } from 'decimal.js';
import { Candle } from '../types';

/**
 * Volume is a hard requirement for every CSV row. The old loader silently
 * substituted `'1000'` when the column was missing, which corrupted every
 * volume-based filter (S5 sweep confirmation, S16 exhaustion) without any
 * signal to the operator. A backtest must fail loudly instead.
 */
const VOLUME_COLUMN_ERROR =
  'CSV must contain a valid positive volume column. Parsing aborted.';

/**
 * Numeric field guard. Accepts decimal and scientific notation but rejects
 * empty strings, `NaN`, `Infinity`, hex literals and other Decimal-parseable
 * garbage that would otherwise reach the simulator as a "valid" price.
 */
const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Unix seconds are below 1e11 until the year 5138; milliseconds crossed 1e11
 * in 1973. The split therefore separates sec from ms without guessing by
 * string length alone (11- and 12-digit values are already milliseconds).
 */
const UNIX_SECONDS_UPPER_BOUND = 1e11;

/** Trim, strip a leading BOM, then strip one layer of surrounding quotes. */
function cleanField(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * Parse a CSV timestamp into Unix milliseconds.
 *
 * Supported inputs:
 *  - numeric seconds (`1700000000`, quoted or not) → multiplied by 1000
 *  - numeric milliseconds (`1700000000000`) → used as-is
 *  - ISO-8601 / human date strings (`2023-11-14T22:13:20.000Z`,
 *    `2023-11-14 22:13:20`) → `Date.parse()`
 *
 * Anything that resolves to a non-finite or non-positive value is rejected
 * with the physical CSV line number so the operator can fix the file.
 */
export function parseCsvTimestamp(raw: string, lineNumber: number): number {
  const value = cleanField(raw);

  if (!value) {
    throw new Error(`Invalid timestamp at line ${lineNumber}: empty value`);
  }

  let timestamp: number;

  if (NUMERIC_RE.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(
        `Invalid timestamp at line ${lineNumber}: "${raw}" is not a finite number`,
      );
    }
    timestamp =
      Math.abs(numeric) < UNIX_SECONDS_UPPER_BOUND ? numeric * 1000 : numeric;
  } else {
    timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      throw new Error(
        `Invalid timestamp at line ${lineNumber}: "${raw}" is neither a Unix timestamp nor a parseable ISO-8601 date`,
      );
    }
  }

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(
      `Invalid timestamp at line ${lineNumber}: must be a positive finite value, got "${raw}"`,
    );
  }

  return timestamp;
}

function parseDecimalField(
  value: string,
  field: string,
  lineNumber: number,
): Decimal {
  if (!NUMERIC_RE.test(value)) {
    throw new Error(
      `Invalid numeric value for ${field} at line ${lineNumber}: "${value}"`,
    );
  }

  const decimal = new Decimal(value);
  if (!decimal.isFinite()) {
    throw new Error(`Non-finite ${field} value at line ${lineNumber}: "${value}"`);
  }

  return decimal;
}

/**
 * Load candles from a CSV file.
 *
 * Expected header: `timestamp,open,high,low,close,volume` (aliases such as
 * `time`/`date`, `o`/`h`/`l`/`c`, `vol`/`v` are accepted). Every row must
 * carry a non-negative volume — there is no implicit fallback.
 *
 * Rows are sorted ascending and deduplicated by timestamp (the last occurrence
 * wins, matching `historyLoader.mergeCandles()`).
 */
export function loadCandlesFromCSV(filePath: string): Candle[] {
  const content = readFileSync(filePath, 'utf-8');
  const fileLines = content.split('\n');

  if (fileLines.length < 2) {
    throw new Error(`CSV file ${filePath} is empty or has no data rows`);
  }

  const header = fileLines[0].split(',').map((h) => cleanField(h).toLowerCase());
  const colIndices = {
    timestamp: header.findIndex((h) =>
      ['timestamp', 'time', 'date', 'datetime'].includes(h),
    ),
    open: header.findIndex((h) => ['open', 'o'].includes(h)),
    high: header.findIndex((h) => ['high', 'h'].includes(h)),
    low: header.findIndex((h) => ['low', 'l'].includes(h)),
    close: header.findIndex((h) => ['close', 'c'].includes(h)),
    volume: header.findIndex((h) => ['volume', 'vol', 'v'].includes(h)),
  };

  const required = ['timestamp', 'open', 'high', 'low', 'close'] as const;
  for (const column of required) {
    if (colIndices[column] === -1) {
      throw new Error(
        `CSV missing required column: ${column}. Header: ${fileLines[0]}`,
      );
    }
  }

  if (colIndices.volume === -1) {
    throw new Error(VOLUME_COLUMN_ERROR);
  }

  const candles: Candle[] = [];

  for (let i = 1; i < fileLines.length; i++) {
    const line = fileLines[i].trim();
    const lineNumber = i + 1;

    // Blank lines and comment lines are tolerated; data integrity is not.
    if (!line || line.startsWith('#')) continue;

    const cols = line.split(',').map((c) => cleanField(c));

    if (cols.length < header.length) {
      throw new Error(
        `Malformed CSV row at line ${lineNumber}: expected ${header.length} columns, got ${cols.length}`,
      );
    }

    const timestamp = parseCsvTimestamp(cols[colIndices.timestamp], lineNumber);

    const open = cols[colIndices.open];
    const high = cols[colIndices.high];
    const low = cols[colIndices.low];
    const close = cols[colIndices.close];

    const o = parseDecimalField(open, 'open', lineNumber);
    const h = parseDecimalField(high, 'high', lineNumber);
    const l = parseDecimalField(low, 'low', lineNumber);
    const c = parseDecimalField(close, 'close', lineNumber);

    if (h.lt(l)) {
      throw new Error(`High < Low at line ${lineNumber}`);
    }
    if (h.lt(o) || h.lt(c)) {
      throw new Error(`High < Open/Close at line ${lineNumber}`);
    }
    if (l.gt(o) || l.gt(c)) {
      throw new Error(`Low > Open/Close at line ${lineNumber}`);
    }

    const rawVolume = cols[colIndices.volume];
    if (!rawVolume || !NUMERIC_RE.test(rawVolume)) {
      throw new Error(VOLUME_COLUMN_ERROR);
    }

    const volume = new Decimal(rawVolume);
    if (!volume.isFinite() || volume.lt(0)) {
      throw new Error(VOLUME_COLUMN_ERROR);
    }

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume: rawVolume,
    });
  }

  if (candles.length === 0) {
    throw new Error(`CSV file ${filePath} contains no data rows`);
  }

  // Sort ascending, then deduplicate by timestamp. Map preserves insertion
  // order, and re-setting an existing key keeps the LAST occurrence — the same
  // "freshest wins" rule used by the history-cache merge.
  const byTimestamp = new Map<number, Candle>();
  for (const candle of [...candles].sort((a, b) => a.timestamp - b.timestamp)) {
    byTimestamp.set(candle.timestamp, candle);
  }

  return Array.from(byTimestamp.values());
}

/**
 * Detect the candle interval in minutes from the first 10 candles.
 *
 * The median delta is used instead of the first delta so a single weekend gap,
 * session break or malformed first pair cannot misreport the timeframe.
 */
export function detectCsvIntervalMinutes(candles: Candle[]): number {
  if (candles.length < 2) {
    throw new Error(
      'Cannot detect CSV interval: at least 2 candles are required',
    );
  }

  const window = candles.slice(0, 10);
  const deltas: number[] = [];

  for (let i = 1; i < window.length; i++) {
    const delta = window[i].timestamp - window[i - 1].timestamp;
    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    throw new Error(
      'Cannot detect CSV interval: no positive timestamp delta in the first 10 candles',
    );
  }

  deltas.sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  const medianMs =
    deltas.length % 2 === 0
      ? (deltas[middle - 1] + deltas[middle]) / 2
      : deltas[middle];

  // Round to a millisecond of precision to avoid binary-float noise.
  return Math.round((medianMs / 60000) * 1000) / 1000;
}

/**
 * Aggregate candles into fixed UTC-epoch buckets (e.g. 15m → 4H).
 *
 * Each output candle opens at the first source candle, closes at the last,
 * takes the max high / min low and sums volume. Bucket alignment is strictly
 * `floor(timestamp / bucketMs) * bucketMs` so sessions never drift with local
 * time. Empty input yields an empty output; a non-positive target is an error
 * (it would divide by zero) rather than a silent no-op.
 */
export function aggregateCandles(
  candles: Candle[],
  targetMinutes: number,
): Candle[] {
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0) {
    throw new Error(
      `aggregateCandles requires a positive finite targetMinutes, got: ${targetMinutes}`,
    );
  }

  if (candles.length === 0) return [];

  const bucketMs = targetMinutes * 60 * 1000;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new Error(
      `aggregateCandles computed an invalid bucket size for ${targetMinutes} minutes`,
    );
  }

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const aggregated: Candle[] = [];

  let bucketStart: number | null = null;
  let bucketOpen = '';
  let bucketHigh = new Decimal(0);
  let bucketLow = new Decimal(0);
  let bucketClose = '';
  let bucketVolume = new Decimal(0);

  const flush = (): void => {
    if (bucketStart === null) return;
    aggregated.push({
      timestamp: bucketStart,
      open: bucketOpen,
      high: bucketHigh.toString(),
      low: bucketLow.toString(),
      close: bucketClose,
      volume: bucketVolume.toString(),
    });
  };

  for (const candle of sorted) {
    if (!Number.isFinite(candle.timestamp)) {
      throw new Error(
        `aggregateCandles received a candle with a non-finite timestamp: ${candle.timestamp}`,
      );
    }

    const bucket = Math.floor(candle.timestamp / bucketMs) * bucketMs;

    if (bucketStart === null || bucket !== bucketStart) {
      flush();
      bucketStart = bucket;
      bucketOpen = candle.open;
      bucketHigh = new Decimal(candle.high);
      bucketLow = new Decimal(candle.low);
      bucketClose = candle.close;
      bucketVolume = new Decimal(candle.volume);
      continue;
    }

    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);

    if (high.gt(bucketHigh)) bucketHigh = high;
    if (low.lt(bucketLow)) bucketLow = low;

    bucketClose = candle.close;
    bucketVolume = bucketVolume.plus(candle.volume);
  }

  flush();
  return aggregated;
}
