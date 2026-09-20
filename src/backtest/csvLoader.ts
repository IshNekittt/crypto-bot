import { readFileSync } from 'fs';
import { Candle } from '../types';
import { Decimal } from 'decimal.js';

/**
 * Load candles from a CSV file.
 * Expected CSV format: timestamp,open,high,low,close[,volume]
 * timestamp can be Unix milliseconds (string), Unix seconds, or ISO 8601 string.
 * Volume is optional (defaults to '1000' if missing).
 */
export function loadCandlesFromCSV(filePath: string): Candle[] {
  const content = readFileSync(filePath, 'utf-8');
  const fileLines = content.trim().split('\n');
  
  if (fileLines.length < 2) {
    throw new Error(`CSV file ${filePath} is empty or has no data rows`);
  }

  // Parse header to determine column indices
  const header = fileLines[0].toLowerCase().split(',').map(h => h.trim());
  const colIndices = {
    timestamp: header.findIndex(h => ['timestamp', 'time', 'date', 'datetime'].includes(h)),
    open: header.findIndex(h => ['open', 'o'].includes(h)),
    high: header.findIndex(h => ['high', 'h'].includes(h)),
    low: header.findIndex(h => ['low', 'l'].includes(h)),
    close: header.findIndex(h => ['close', 'c'].includes(h)),
    volume: header.findIndex(h => ['volume', 'vol', 'v'].includes(h)),
  };

  // Validate required columns
  const required = ['timestamp', 'open', 'high', 'low', 'close'];
  for (const req of required) {
    if (colIndices[req as keyof typeof colIndices] === -1) {
      throw new Error(`CSV missing required column: ${req}. Header: ${fileLines[0]}`);
    }
  }

  const candles: Candle[] = [];
  
  for (let i = 1; i < fileLines.length; i++) {
    const line = fileLines[i].trim();
    if (!line) continue;
    
    const cols = line.split(',').map(c => c.trim());
    if (cols.length < 5) continue; // Skip malformed lines

    // Parse timestamp - clean string first to handle \r, quotes, spaces
    const tsCol = cols[colIndices.timestamp];
    const rawTs = tsCol;
    const cleanTs = String(rawTs).replace(/[^0-9]/g, '');
    const ts = parseInt(cleanTs, 10);
    const timestamp = ts;

    // Parse OHLCV using Decimal for precision
    const open = cols[colIndices.open];
    const high = cols[colIndices.high];
    const low = cols[colIndices.low];
    const close = cols[colIndices.close];
    const volume = colIndices.volume !== -1 && cols[colIndices.volume] 
      ? cols[colIndices.volume] 
      : '1000'; // Fallback if volume column missing

    // Validate numeric values
    for (const val of [open, high, low, close, volume]) {
      if (!/^-?\d+(\.\d+)?$/.test(val)) {
        throw new Error(`Invalid numeric value at line ${i + 1}: ${val}`);
      }
    }

    // Validate OHLC logic
    const o = new Decimal(open);
    const h = new Decimal(high);
    const l = new Decimal(low);
    const c = new Decimal(close);
    
    if (!o.isFinite() || !h.isFinite() || !l.isFinite() || !c.isFinite()) {
      throw new Error(`Non-finite OHLC values at line ${i + 1}`);
    }
    if (h.lt(l)) {
      throw new Error(`High < Low at line ${i + 1}`);
    }
    if (h.lt(o) || h.lt(c)) {
      throw new Error(`High < Open/Close at line ${i + 1}`);
    }
    if (l.gt(o) || l.gt(c)) {
      throw new Error(`Low > Open/Close at line ${i + 1}`);
    }

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Sort by timestamp ascending
  candles.sort((a, b) => a.timestamp - b.timestamp);

  // Remove duplicates (same timestamp)
  const uniqueCandles: Candle[] = [];
  let lastTs = -1;
  for (const c of candles) {
    if (c.timestamp !== lastTs) {
      uniqueCandles.push(c);
      lastTs = c.timestamp;
    }
  }

  return uniqueCandles;
}

/**
 * Aggregate 15m candles to higher timeframe (e.g., 4H, 1D)
 */
export function aggregateCandles(candles: Candle[], targetMinutes: number): Candle[] {
  if (candles.length === 0) return [];
  
  const aggregated: Candle[] = [];
  let currentBucket: Candle | null = null;
  let bucketStart = 0;
  const bucketMs = targetMinutes * 60 * 1000;

  for (const c of candles) {
    const bucket = Math.floor(c.timestamp / bucketMs) * bucketMs;
    
    if (bucket !== bucketStart) {
      // Close previous bucket
      if (currentBucket) {
        aggregated.push(currentBucket);
      }
      // Start new bucket
      bucketStart = bucket;
      currentBucket = {
        timestamp: bucketStart,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      // Update current bucket
      const nh = Decimal.max(new Decimal(currentBucket!.high), new Decimal(c.high));
      const nl = Decimal.min(new Decimal(currentBucket!.low), new Decimal(c.low));
      
      currentBucket = {
        ...currentBucket!,
        high: nh.toString(),
        low: nl.toString(),
        close: c.close,
        volume: new Decimal(currentBucket!.volume).plus(c.volume).toString(),
      };
    }
  }

  // Don't forget the last bucket
  if (currentBucket) {
    aggregated.push(currentBucket);
  }

  return aggregated;
}