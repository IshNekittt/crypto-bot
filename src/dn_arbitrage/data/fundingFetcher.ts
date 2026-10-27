import { RestClientV5 } from 'bybit-api';
import { Decimal } from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { DN_HOUR_MS, DnConfig } from '../config';
import {
  FundingCacheFile,
  FundingEvent,
  FundingHistory,
  FundingHistorySource,
} from '../types';

/**
 * Historical funding fetcher for the delta-neutral backtester.
 *
 * Bybit V5 endpoint: `GET /v5/market/funding/history` (public, no API key).
 * Pagination is backwards by `endTime` with `limit=200`; each page has its own
 * exponential-backoff retry budget (8 attempts, 1s → 30s cap). A permanent
 * failure never fabricates data: the caller either falls back to a non-empty
 * cache or reports the symbol as failed.
 *
 * Cache layout: `<cacheDir>/funding/<SYMBOL>.json` — matches the Phase 1
 * requirement (`data/dn_cache/`). Rates are stored as strings, never numbers.
 */

const PAGE_LIMIT = 200;
const MAX_PAGES = 30; // 6,000 events > 180 days at a 1h interval
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_SPACING_MS = 250;

/** Parameter/auth failures should not burn ~90s of retries. */
const NON_RETRYABLE_RET_CODES = new Set([
  10001, // parameter error
  10002, // timestamp error
  10003, // invalid API key
  10004, // signature error
  10005, // permission denied
  10009, // IP not allowed
  10010, // insufficient permissions
]);

export interface FundingFetchOptions {
  readonly config: DnConfig;
  /** Cache-only mode. Missing cache is a per-symbol failure. */
  readonly offline: boolean;
  /** Ignore a fresh cache and hit the network. */
  readonly refresh: boolean;
}

export interface BasketFundingResult {
  readonly histories: ReadonlyMap<string, FundingHistory>;
  readonly failures: ReadonlyArray<{ readonly symbol: string; readonly error: string }>;
}

class BybitFundingError extends Error {
  constructor(
    readonly retCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'BybitFundingError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof BybitFundingError) {
    return `[${error.retCode}] ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof BybitFundingError) {
    return !NON_RETRYABLE_RET_CODES.has(error.retCode);
  }
  // Network / transport / timeout errors carry no Bybit retCode and are retried.
  return true;
}

export function getFundingCachePath(cacheDir: string, symbol: string): string {
  return path.resolve(process.cwd(), cacheDir, 'funding', `${symbol}.json`);
}

function parseCacheEvents(file: FundingCacheFile, symbol: string): FundingEvent[] {
  const byTimestamp = new Map<number, Decimal>();
  for (const raw of file.events) {
    const timestamp = Number(raw.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      logger.warn(`[DN][${symbol}] Ignoring cache event with invalid timestamp: ${String(raw.timestamp)}`);
      continue;
    }
    try {
      byTimestamp.set(timestamp, new Decimal(raw.rate));
    } catch {
      logger.warn(`[DN][${symbol}] Ignoring cache event with invalid rate at ${timestamp}: ${raw.rate}`);
    }
  }
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rate]) => ({ timestamp, rate }));
}

function readCache(cachePath: string, symbol: string): FundingCacheFile | null {
  if (!fs.existsSync(cachePath)) return null;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('cache root is not an object');
    }
    const candidate = parsed as Partial<FundingCacheFile>;
    if (candidate.symbol !== symbol) {
      throw new Error(`cache symbol mismatch (expected ${symbol}, got ${String(candidate.symbol)})`);
    }
    if (!Array.isArray(candidate.events)) {
      throw new Error('cache events is not an array');
    }
    if (typeof candidate.fetchedAt !== 'number' || !Number.isFinite(candidate.fetchedAt)) {
      throw new Error('cache fetchedAt is invalid');
    }
    if (typeof candidate.intervalHours !== 'number' || !Number.isFinite(candidate.intervalHours)) {
      throw new Error('cache intervalHours is invalid');
    }
    return {
      symbol,
      fetchedAt: candidate.fetchedAt,
      intervalHours: candidate.intervalHours,
      events: candidate.events,
    };
  } catch (error) {
    logger.warn(`[DN][${symbol}] Ignoring unreadable funding cache ${cachePath}: ${describeError(error)}`);
    return null;
  }
}

function writeCache(cachePath: string, file: FundingCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, cachePath);
  } catch (error) {
    // Cache writes are helpful, never fatal. The network data is already in memory.
    logger.warn(`[DN][${file.symbol}] Failed to write funding cache ${cachePath}: ${describeError(error)}`);
  }
}

function cacheCoversWindow(
  events: readonly FundingEvent[],
  fromMs: number,
  toMs: number,
  intervalMs: number,
): boolean {
  if (events.length === 0) return false;
  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;
  // Funding settles at discrete timestamps; allow one interval of slack on the
  // left edge and two on the right (the newest epoch may not have printed yet).
  return first <= fromMs + intervalMs && last >= toMs - 2 * intervalMs;
}

export function inferFundingIntervalHours(
  events: readonly FundingEvent[],
  fallbackHours: number,
): number {
  if (events.length < 2) return fallbackHours;

  const diffs: number[] = [];
  for (let i = 1; i < events.length; i++) {
    const diff = events[i].timestamp - events[i - 1].timestamp;
    if (diff > 0) diffs.push(diff);
  }
  if (diffs.length === 0) return fallbackHours;

  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const hours = Math.round(median / DN_HOUR_MS);
  return Math.max(1, Math.min(24, hours));
}

export function countFundingGaps(
  events: readonly FundingEvent[],
  intervalHours: number,
): number {
  if (events.length < 2) return 0;
  const intervalMs = intervalHours * DN_HOUR_MS;
  // 5% tolerance absorbs exchange timestamp jitter; a real missing epoch is
  // always at least one full interval wider than 2× the expected spacing.
  const toleranceMs = Math.max(60_000, intervalMs * 0.05);
  let gaps = 0;
  for (let i = 1; i < events.length; i++) {
    const diff = events[i].timestamp - events[i - 1].timestamp;
    if (diff > 2 * intervalMs + toleranceMs) gaps += 1;
  }
  return gaps;
}

async function fetchPageWithRetry(
  client: RestClientV5,
  symbol: string,
  fromMs: number,
  endMs: number,
): Promise<ReadonlyArray<{ fundingRate: string; fundingRateTimestamp: string }>> {
  let lastError: unknown = new Error('unknown funding fetch failure');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.getFundingRateHistory({
        category: 'linear',
        symbol,
        startTime: fromMs,
        endTime: endMs,
        limit: PAGE_LIMIT,
      });

      if (response.retCode !== 0) {
        throw new BybitFundingError(response.retCode, response.retMsg);
      }

      return response.result.list ?? [];
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }

      const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      logger.warn(
        `[DN][${symbol}] Funding fetch attempt ${attempt}/${MAX_ATTEMPTS} failed: ${describeError(error)}. Retrying in ${backoffMs}ms...`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchAllPages(
  client: RestClientV5,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<FundingEvent[]> {
  const byTimestamp = new Map<number, Decimal>();
  let cursor = toMs;

  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await fetchPageWithRetry(client, symbol, fromMs, cursor);
    if (list.length === 0) break;

    let pageOldest = Number.POSITIVE_INFINITY;
    for (const item of list) {
      const timestamp = Number(item.fundingRateTimestamp);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < pageOldest) pageOldest = timestamp;
      if (timestamp < fromMs || timestamp > toMs) continue;

      try {
        byTimestamp.set(timestamp, new Decimal(item.fundingRate));
      } catch {
        logger.warn(`[DN][${symbol}] Ignoring funding record with invalid rate: ${item.fundingRate}`);
      }
    }

    if (!Number.isFinite(pageOldest) || pageOldest <= fromMs) break;
    if (list.length < PAGE_LIMIT) break;
    if (pageOldest >= cursor) break; // no progress; protects against a bad server loop
    cursor = pageOldest - 1;

    await sleep(REQUEST_SPACING_MS);
  }

  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rate]) => ({ timestamp, rate }));
}

function mergeEvents(
  cached: readonly FundingEvent[],
  fetched: readonly FundingEvent[],
): FundingEvent[] {
  const byTimestamp = new Map<number, Decimal>();
  for (const event of cached) byTimestamp.set(event.timestamp, event.rate);
  // Fresh exchange data wins on duplicate timestamps.
  for (const event of fetched) byTimestamp.set(event.timestamp, event.rate);
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rate]) => ({ timestamp, rate }));
}

function buildHistory(
  symbol: string,
  allEvents: readonly FundingEvent[],
  intervalHours: number,
  fromMs: number,
  toMs: number,
  fetchedAt: number,
  source: FundingHistorySource,
): FundingHistory {
  const events = allEvents.filter(
    (event) => event.timestamp >= fromMs && event.timestamp <= toMs,
  );
  if (events.length === 0) {
    throw new Error(
      `No funding events for ${symbol} in the requested window ` +
        `(${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()})`,
    );
  }

  const dataGaps = countFundingGaps(events, intervalHours);
  if (dataGaps > 0) {
    logger.warn(
      `[DN][${symbol}] ${dataGaps} funding gap(s) larger than 2× the ${intervalHours}h interval; missing epochs are not fabricated`,
    );
  }

  return {
    symbol,
    events,
    intervalHours,
    dataGaps,
    fetchedAt,
    source,
  };
}

/**
 * Fetch (or load from cache) one symbol's funding history.
 *
 * Precedence:
 * 1. `--offline` → cache only, throw if absent.
 * 2. fresh + complete cache and no `--refresh` → cache.
 * 3. network → merge with cache → write cache.
 * 4. network failure with a non-empty cache → cache fallback (with a warning).
 */
export async function fetchFundingHistory(
  symbol: string,
  fromMs: number,
  toMs: number,
  options: FundingFetchOptions,
  injectedClient?: RestClientV5,
): Promise<FundingHistory> {
  const { config } = options;
  const cachePath = getFundingCachePath(config.cacheDir, symbol);
  const cache = readCache(cachePath, symbol);
  const cachedEvents = cache ? parseCacheEvents(cache, symbol) : [];
  const cachedInterval = cache?.intervalHours ?? config.expectedIntervalHours;
  const intervalMs = cachedInterval * DN_HOUR_MS;

  if (options.offline) {
    if (!cache) {
      throw new Error(`[OFFLINE] No funding cache for ${symbol} at ${cachePath}`);
    }
    if (!cacheCoversWindow(cachedEvents, fromMs, toMs, intervalMs)) {
      logger.warn(
        `[DN][${symbol}] [OFFLINE] Cache does not fully cover the requested window; simulating available history only`,
      );
    }
    return buildHistory(
      symbol,
      cachedEvents,
      cachedInterval,
      fromMs,
      toMs,
      cache.fetchedAt,
      'cache',
    );
  }

  const cacheFresh = cache !== null && Date.now() - cache.fetchedAt <= config.cacheTtlMs;
  if (!options.refresh && cacheFresh && cacheCoversWindow(cachedEvents, fromMs, toMs, intervalMs)) {
    logger.info(`[DN][${symbol}] Using fresh funding cache (${cachedEvents.length} events)`);
    return buildHistory(
      symbol,
      cachedEvents,
      cachedInterval,
      fromMs,
      toMs,
      cache.fetchedAt,
      'cache',
    );
  }

  const client = injectedClient ?? new RestClientV5({ testnet: false, keepAlive: true });

  try {
    const fetched = await fetchAllPages(client, symbol, fromMs, toMs);
    if (fetched.length === 0) {
      if (cachedEvents.length > 0) {
        logger.warn(`[DN][${symbol}] Empty funding response; keeping the existing cache unchanged`);
        return buildHistory(
          symbol,
          cachedEvents,
          cachedInterval,
          fromMs,
          toMs,
          cache?.fetchedAt ?? Date.now(),
          'cache-fallback',
        );
      }
      throw new Error(`Bybit returned no funding history for ${symbol}`);
    }

    const merged = mergeEvents(cachedEvents, fetched);
    const intervalHours = inferFundingIntervalHours(merged, config.expectedIntervalHours);
    const fetchedAt = Date.now();
    writeCache(cachePath, {
      symbol,
      fetchedAt,
      intervalHours,
      events: merged.map((event) => ({
        timestamp: event.timestamp,
        rate: event.rate.toString(),
      })),
    });

    logger.info(
      `[DN][${symbol}] Fetched ${fetched.length} funding events (${intervalHours}h interval, ${merged.length} cached)`,
    );

    return buildHistory(
      symbol,
      merged,
      intervalHours,
      fromMs,
      toMs,
      fetchedAt,
      cachedEvents.length > 0 ? 'cache+network' : 'network',
    );
  } catch (error) {
    if (cachedEvents.length > 0) {
      logger.warn(
        `[DN][${symbol}] Funding fetch failed (${describeError(error)}); falling back to cache`,
      );
      return buildHistory(
        symbol,
        cachedEvents,
        cachedInterval,
        fromMs,
        toMs,
        cache?.fetchedAt ?? Date.now(),
        'cache-fallback',
      );
    }
    throw error;
  }
}

/**
 * Fetch the basket with bounded concurrency. Per-symbol failures are collected
 * rather than aborting the run, so one delisted/invalid pair cannot hide the
 * other nineteen results.
 */
export async function loadBasketFunding(
  symbols: readonly string[],
  fromMs: number,
  toMs: number,
  options: FundingFetchOptions,
): Promise<BasketFundingResult> {
  const client = options.offline ? null : new RestClientV5({ testnet: false, keepAlive: true });
  const histories = new Map<string, FundingHistory>();
  const failures: Array<{ symbol: string; error: string }> = [];
  let nextIndex = 0;

  const workerCount = Math.min(
    options.config.fetchConcurrency,
    Math.max(1, symbols.length),
  );

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= symbols.length) return;

      const symbol = symbols[index];
      try {
        const history = await fetchFundingHistory(
          symbol,
          fromMs,
          toMs,
          options,
          client ?? undefined,
        );
        histories.set(symbol, history);
      } catch (error) {
        const message = describeError(error);
        failures.push({ symbol, error: message });
        logger.error(`[DN][${symbol}] Funding history unavailable: ${message}`);
      }
    }
  });

  await Promise.all(workers);
  return { histories, failures };
}
