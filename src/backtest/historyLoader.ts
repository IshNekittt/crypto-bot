import { BybitClient } from '../api/bybitClient';
import { Candle, Timeframe } from '../types';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data/backtest_cache');
const MAX_CANDLES_PER_REQUEST = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 3000;

export interface CachedData {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  from: number;
  to: number;
  savedAt: number;
}

async function fetchWithRetry(
  client: BybitClient,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  endTime: number
): Promise<Candle[]> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.getKlines(symbol, timeframe, limit, endTime);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetryable = err instanceof Error && (
        err.message.includes('EPIPE') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('timeout') ||
        err.message.includes('socket hang up')
      );
      
      if (!isRetryable || attempt === MAX_RETRIES) {
        throw lastError;
      }
      
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(`[${symbol} ${timeframe}] Fetch attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  throw lastError;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(symbol: string, timeframe: Timeframe): string {
  return path.join(CACHE_DIR, `${symbol}_${timeframe}.json`);
}

export async function loadCachedOrFetch(
  client: BybitClient,
  symbol: string,
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
  useLocalCacheOnly: boolean = false
): Promise<Candle[]> {
  ensureCacheDir();
  const cachePath = getCachePath(symbol, timeframe);

  let cached: CachedData | null = null;
  if (fs.existsSync(cachePath)) {
    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      cached = JSON.parse(raw) as CachedData;
      logger.info(`Loaded cached ${symbol} ${timeframe}: ${cached.candles.length} candles (${new Date(cached.from).toISOString()} - ${new Date(cached.to).toISOString()})`);
    } catch (e) {
      logger.warn(`Failed to read cache for ${symbol} ${timeframe}, will refetch`);
    }
  }

  if (cached && cached.from <= fromMs && cached.to >= toMs) {
    const filtered = cached.candles.filter(c => c.timestamp >= fromMs && c.timestamp <= toMs);
    logger.info(`Using cached data for ${symbol} ${timeframe}: ${filtered.length} candles in range`);
    return filtered;
  }

  if (useLocalCacheOnly) {
    if (cached) {
      logger.info(`[OFFLINE MODE] Loaded ${symbol} ${timeframe} strictly from cache.`);
      const filtered = cached.candles.filter(c => c.timestamp >= fromMs && c.timestamp <= toMs);
      return filtered;
    } else {
      throw new Error(`[OFFLINE MODE] Cache file not found for ${symbol} ${timeframe}: ${cachePath}`);
    }
  }

  logger.info(`Fetching ${symbol} ${timeframe} from Bybit: ${new Date(fromMs).toISOString()} - ${new Date(toMs).toISOString()}`);
  const allCandles: Candle[] = [];
  let currentEnd = toMs;

  while (currentEnd > fromMs) {
    const candles = await fetchWithRetry(client, symbol, timeframe, MAX_CANDLES_PER_REQUEST, currentEnd);
    if (candles.length === 0) break;

    allCandles.push(...candles);
    currentEnd = candles[0].timestamp - 1;

    await new Promise(r => setTimeout(r, 100));
  }

  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  const merged = cached ? mergeCandles(cached.candles, allCandles) : allCandles;

  const toSave: CachedData = {
    symbol,
    timeframe,
    candles: merged,
    from: merged[0]?.timestamp ?? fromMs,
    to: merged[merged.length - 1]?.timestamp ?? toMs,
    savedAt: Date.now(),
  };

  fs.writeFileSync(cachePath, JSON.stringify(toSave));
  logger.info(`Saved cache for ${symbol} ${timeframe}: ${merged.length} candles`);

  return merged.filter(c => c.timestamp >= fromMs && c.timestamp <= toMs);
}

function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.timestamp, c);
  for (const c of incoming) map.set(c.timestamp, c);
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Builds the historical window for a backtest.
 *
 * The window must come from `BACKTEST_DAYS` (config.backtestDays) — never from
 * a hardcoded 180-day / "six months" constant. Every candle loader (1m, LTF and
 * HTF) must be driven by the same range so the chart, the report and the
 * simulated period can never disagree with `.env`.
 */
export function getTimeRangeForDays(days: number): { fromMs: number; toMs: number } {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Backtest range requires a positive number of days, got: ${days}`);
  }

  const toMs = Date.now();
  const fromMs = toMs - Math.round(days * MS_PER_DAY);
  return { fromMs, toMs };
}