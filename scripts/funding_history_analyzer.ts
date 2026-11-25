#!/usr/bin/env node

/**
 * Delta-Neutral Funding Yield Analyzer — Bybit V5 linear perpetuals.
 *
 * Phase 1 of the Delta-Neutral Funding Harvesting Engine: a pure, read-only
 * historical screener that answers one question per symbol —
 *
 *     "If I held spot long + perp short at 1:1 notional for 180 days,
 *      what would funding pay me AFTER round-trip execution costs?"
 *
 * Design boundaries (deliberate):
 *   • PUBLIC Bybit V5 endpoints only. No API key, no `src/config/env.ts`
 *     import, no Telegram, no database. The script cannot mutate strategy
 *     state and never touches the SMC scenarios (1, 5, 12, 14, 15).
 *   • All money/rate arithmetic is `decimal.js`. JS `number` is used ONLY for
 *     timestamps, record counts and array indexing — never for a rate, a sum,
 *     a yield or an APY.
 *   • History is cached at `data/funding_history/<SYMBOL>_funding.json` with
 *     rates serialized as strings, matching the repository-wide invariant.
 *
 * Funding sign convention for a SHORT perpetual:
 *     rate > 0  → longs pay shorts → the hedge RECEIVES funding
 *     rate < 0  → shorts pay longs → the hedge PAYS funding
 * Summing the signed rates over the window therefore IS the net funding
 * return on the hedged notional (funding accrues once per epoch regardless of
 * whether that epoch is 1h, 4h or 8h).
 *
 * Usage:
 *   npm run funding:analyze
 *   npm run funding:analyze -- --days=180 --refresh
 *   npm run funding:analyze -- --symbols=SOLUSDT,NEARUSDT --offline
 *   npx ts-node scripts/funding_history_analyzer.ts --fees=0.24%
 *
 * Exit codes: 0 = report written (even with per-symbol exclusions),
 *             1 = fatal error / no symbol produced a usable history.
 */

import { Decimal } from 'decimal.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

// ---------------------------------------------------------------------------
// Universe & constants
// ---------------------------------------------------------------------------

/** Requested top-20 liquid altcoin universe (spot + linear perp). */
const DEFAULT_UNIVERSE: readonly string[] = [
  'SOLUSDT',
  'NEARUSDT',
  'APTUSDT',
  'SUIUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'WLDUSDT',
  'OPUSDT',
  'ARBUSDT',
  'TIAUSDT',
  'SEIUSDT',
  'INJUSDT',
  'FETUSDT',
  'PEPEUSDT',
  'ENAUSDT',
  'TONUSDT',
  'KASUSDT',
  'AAVEUSDT',
  'RENDERUSDT',
];

/**
 * Requested symbol → Bybit perpetual symbol.
 *
 * Bybit quotes PEPE's perpetual as `1000PEPEUSDT` while spot trades as
 * `PEPEUSDT`. The hedge is still 1:1 in NOTIONAL terms (1000 spot units per
 * perp base unit), so the funding rate applies to the same hedged notional and
 * the yield math is unchanged.
 */
const PERP_ALIASES: Readonly<Record<string, string>> = {
  PEPEUSDT: '1000PEPEUSDT',
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BYBIT_BASE_URL = 'https://api.bybit.com';

/** Funding history page size (Bybit V5 maximum). */
const PAGE_LIMIT = 200;
/** 80 × 200 = 16,000 epochs — comfortably beyond 180 days at a 1h interval. */
const MAX_PAGES = 80;

const MAX_ATTEMPTS = 6;
/**
 * Only these codes justify another attempt. Every other business code
 * (10001 parameter error, 10002 timestamp error, 10003/10004/10005 auth,
 * 10009/10010 permissions, …) is a caller bug and fails immediately instead
 * of burning ~30s of exponential backoff.
 */
const RETRYABLE_RET_CODES = new Set([
  10000, // server error
  10006, // too many requests
  10016, // service temporarily unavailable
]);

const DEFAULT_DAYS = 180;
/** Flat round-trip cost on capital for BOTH legs, entry + exit. */
const DEFAULT_ROUND_TRIP_FEE = new Decimal('0.0020');
const TOP_YIELD_THRESHOLD = new Decimal('0.20');
const VIABLE_THRESHOLD = new Decimal('0.10');
const DEFAULT_CACHE_DIR = 'data/funding_history';
const DEFAULT_REPORT_PATH = 'data/Funding_Yield_Report.md';
/** A cache younger than this is reused when it fully covers the window. */
const DEFAULT_CACHE_TTL_MS = 12 * HOUR_MS;
const DEFAULT_REQUEST_GAP_MS = 250;
const DEFAULT_CONCURRENCY = 3;

/** Structurally un-tradeable (delisted perp / missing spot) — not a failure. */
const EXCLUDED = 'EXCLUDED';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FundingRecord {
  readonly timestamp: number;
  readonly rate: Decimal;
}

interface FundingCacheFile {
  readonly symbol: string;
  readonly perpSymbol: string;
  readonly fetchedAt: number;
  readonly intervalHours: number;
  readonly records: ReadonlyArray<{
    readonly timestamp: number;
    readonly rate: string;
  }>;
}

type HistorySource = 'cache' | 'network' | 'cache+network' | 'cache-fallback';

interface AnalyzerOptions {
  symbols: readonly string[];
  days: number;
  roundTripFee: Decimal;
  cacheDir: string;
  reportPath: string;
  refresh: boolean;
  offline: boolean;
  requestGapMs: number;
  concurrency: number;
}

interface SymbolAnalysis {
  readonly symbol: string;
  readonly perpSymbol: string;
  readonly source: HistorySource;
  readonly records: number;
  readonly firstTimestamp: number;
  readonly lastTimestamp: number;
  readonly intervalHours: number;
  readonly coverageDays: Decimal;
  readonly annualizationDays: number;
  readonly gaps: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly positiveRatio: Decimal;
  readonly positiveSum: Decimal;
  readonly negativeSum: Decimal;
  readonly netFunding: Decimal;
  readonly fees: Decimal;
  readonly netProfit: Decimal;
  readonly projectedApy: Decimal;
  readonly bestRate: Decimal;
  readonly worstRate: Decimal;
  readonly longestNegativeStreak: number;
  readonly maxFundingDrawdown: Decimal;
  readonly verdict: string;
}

interface SymbolFailure {
  readonly symbol: string;
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Public Bybit V5 REST client (rate-limit aware, retry-safe)
// ---------------------------------------------------------------------------

class BybitApiError extends Error {
  public constructor(
    public readonly retCode: number,
    message: string,
    public readonly path: string,
  ) {
    super(`Bybit [${retCode}] ${message} for ${path}`);
    this.name = 'BybitApiError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

class PublicBybitClient {
  public requests = 0;
  public rateLimitHits = 0;

  public constructor(private readonly gapMs: number) {}

  /** Throttled GET with exponential backoff on 429 / 5xx / retryable codes. */
  public async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
    const url = `${BYBIT_BASE_URL}${path}?${query}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      this.requests += 1;
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' } });

        if (response.status === 429) {
          this.rateLimitHits += 1;
          if (attempt === MAX_ATTEMPTS) {
            throw new Error(`HTTP 429 rate limited after ${MAX_ATTEMPTS} attempts: ${path}`);
          }
          const pause = 1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
          console.warn(`  [429] rate limited on ${path} — retrying in ${pause}ms (${attempt}/${MAX_ATTEMPTS})`);
          await sleep(pause);
          continue;
        }

        if (!response.ok) {
          const retryable = response.status >= 500;
          if (retryable && attempt < MAX_ATTEMPTS) {
            const pause = 1_000 * 2 ** (attempt - 1);
            console.warn(
              `  [HTTP ${response.status}] ${path} — retrying in ${pause}ms (${attempt}/${MAX_ATTEMPTS})`,
            );
            await sleep(pause);
            continue;
          }
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${path}`);
        }

        const payload = (await response.json()) as {
          retCode: number;
          retMsg: string;
          result: T;
        };

        if (payload.retCode !== 0) {
          if (RETRYABLE_RET_CODES.has(payload.retCode) && attempt < MAX_ATTEMPTS) {
            const pause = 1_000 * 2 ** (attempt - 1);
            console.warn(
              `  [${payload.retCode}] ${payload.retMsg} on ${path} — retrying in ${pause}ms (${attempt}/${MAX_ATTEMPTS})`,
            );
            await sleep(pause);
            continue;
          }
          throw new BybitApiError(payload.retCode, payload.retMsg, path);
        }

        return payload.result;
      } catch (error) {
        // A classified business error is never retried here.
        if (error instanceof BybitApiError) {
          throw error;
        }
        if (attempt >= MAX_ATTEMPTS) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        const message = error instanceof Error ? error.message : String(error);
        const pause = 1_000 * 2 ** (attempt - 1);
        console.warn(`  [NET] ${message} — retrying in ${pause}ms (${attempt}/${MAX_ATTEMPTS})`);
        await sleep(pause);
      } finally {
        await sleep(this.gapMs);
      }
    }

    throw new Error(`Unreachable: exhausted attempts for ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Bybit payload helpers
// ---------------------------------------------------------------------------

/** Returns the instrument status (`Trading`, `Closed`, …) or `null` if absent. */
async function probeInstrument(
  client: PublicBybitClient,
  category: 'spot' | 'linear',
  symbol: string,
): Promise<string | null> {
  const result = await client.get<{ list?: unknown }>('/v5/market/instruments-info', {
    category,
    symbol,
  });
  const rows = Array.isArray(result.list) ? result.list : [];
  if (rows.length === 0) return null;
  const first = rows[0] as Record<string, unknown>;
  return typeof first.status === 'string' ? first.status : 'UNKNOWN';
}

async function fetchFundingRecords(
  client: PublicBybitClient,
  perpSymbol: string,
  fromMs: number,
  toMs: number,
): Promise<FundingRecord[]> {
  const byTimestamp = new Map<number, Decimal>();
  let cursor = toMs;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.get<{
      list?: ReadonlyArray<{ fundingRate?: string; fundingRateTimestamp?: string }>;
    }>('/v5/market/funding/history', {
      category: 'linear',
      symbol: perpSymbol,
      startTime: fromMs,
      endTime: cursor,
      limit: PAGE_LIMIT,
    });

    const list = Array.isArray(result.list) ? result.list : [];
    if (list.length === 0) break;

    let pageOldest = Number.POSITIVE_INFINITY;
    for (const item of list) {
      const timestamp = Number(item.fundingRateTimestamp);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < pageOldest) pageOldest = timestamp;
      if (timestamp < fromMs || timestamp > toMs) continue;
      if (typeof item.fundingRate !== 'string') continue;

      try {
        byTimestamp.set(timestamp, new Decimal(item.fundingRate));
      } catch {
        console.warn(`  [WARN] ${perpSymbol}: ignoring non-decimal funding rate "${item.fundingRate}"`);
      }
    }

    if (!Number.isFinite(pageOldest)) break;
    if (pageOldest <= fromMs) break;
    if (list.length < PAGE_LIMIT) break;
    if (pageOldest >= cursor) break; // no progress — protects against a bad server loop
    cursor = pageOldest - 1;
  }

  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rate]) => ({ timestamp, rate }));
}

// ---------------------------------------------------------------------------
// Cache — data/funding_history/<SYMBOL>_funding.json
// ---------------------------------------------------------------------------

function getCachePath(cacheDir: string, symbol: string): string {
  return resolve(process.cwd(), cacheDir, `${symbol}_funding.json`);
}

function readCache(
  cachePath: string,
  symbol: string,
  perpSymbol: string,
): { fetchedAt: number; intervalHours: number; records: FundingRecord[] } | null {
  if (!existsSync(cachePath)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('cache root is not an object');
    }

    const candidate = parsed as Partial<FundingCacheFile>;
    if (candidate.symbol !== symbol) {
      throw new Error(`cache symbol mismatch (expected ${symbol}, got ${String(candidate.symbol)})`);
    }
    if (candidate.perpSymbol !== perpSymbol) {
      throw new Error(
        `cache perp mismatch (expected ${perpSymbol}, got ${String(candidate.perpSymbol)})`,
      );
    }
    if (!Array.isArray(candidate.records)) {
      throw new Error('cache records is not an array');
    }
    if (typeof candidate.fetchedAt !== 'number' || !Number.isFinite(candidate.fetchedAt)) {
      throw new Error('cache fetchedAt is invalid');
    }
    if (
      typeof candidate.intervalHours !== 'number' ||
      !Number.isFinite(candidate.intervalHours)
    ) {
      throw new Error('cache intervalHours is invalid');
    }

    const byTimestamp = new Map<number, Decimal>();
    for (const row of candidate.records) {
      const timestamp = Number(row.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        console.warn(`  [WARN] ${symbol}: ignoring cache row with invalid timestamp`);
        continue;
      }
      try {
        byTimestamp.set(timestamp, new Decimal(row.rate));
      } catch {
        console.warn(`  [WARN] ${symbol}: ignoring cache row with invalid rate "${row.rate}"`);
      }
    }

    const records = [...byTimestamp.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, rate]) => ({ timestamp, rate }));

    return {
      fetchedAt: candidate.fetchedAt,
      intervalHours: candidate.intervalHours,
      records,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  [WARN] ${symbol}: ignoring unreadable cache (${message})`);
    return null;
  }
}

function writeCache(
  cachePath: string,
  symbol: string,
  perpSymbol: string,
  intervalHours: number,
  records: readonly FundingRecord[],
): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const file: FundingCacheFile = {
      symbol,
      perpSymbol,
      fetchedAt: Date.now(),
      intervalHours,
      records: records.map((record) => ({
        timestamp: record.timestamp,
        rate: record.rate.toString(),
      })),
    };
    const temporaryPath = `${cachePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    renameSync(temporaryPath, cachePath);
  } catch (error) {
    // Cache writes are helpful, never fatal — the network data is in memory.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  [WARN] ${symbol}: failed to write cache (${message})`);
  }
}

function filterWindow(
  records: readonly FundingRecord[],
  fromMs: number,
  toMs: number,
): FundingRecord[] {
  return records.filter(
    (record) => record.timestamp >= fromMs && record.timestamp <= toMs,
  );
}

function mergeRecords(
  cached: readonly FundingRecord[],
  fetched: readonly FundingRecord[],
): FundingRecord[] {
  const byTimestamp = new Map<number, Decimal>();
  for (const record of cached) byTimestamp.set(record.timestamp, record.rate);
  // Fresh exchange data wins on duplicate timestamps.
  for (const record of fetched) byTimestamp.set(record.timestamp, record.rate);
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rate]) => ({ timestamp, rate }));
}

// ---------------------------------------------------------------------------
// Math (Decimal only)
// ---------------------------------------------------------------------------

function inferIntervalHours(records: readonly FundingRecord[]): number {
  if (records.length < 2) return 8;

  const differences: number[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const difference = records[i].timestamp - records[i - 1].timestamp;
    if (difference > 0) differences.push(difference);
  }
  if (differences.length === 0) return 8;

  differences.sort((a, b) => a - b);
  const median = differences[Math.floor(differences.length / 2)];
  return Math.max(1, Math.min(24, Math.round(median / HOUR_MS)));
}

function countGaps(records: readonly FundingRecord[], intervalHours: number): number {
  if (records.length < 2) return 0;

  const intervalMs = intervalHours * HOUR_MS;
  const toleranceMs = Math.max(60_000, intervalMs * 0.05);
  let gaps = 0;
  for (let i = 1; i < records.length; i += 1) {
    const difference = records[i].timestamp - records[i - 1].timestamp;
    if (difference > 2 * intervalMs + toleranceMs) gaps += 1;
  }
  return gaps;
}

function verdictFor(projectedApy: Decimal): string {
  if (projectedApy.gt(TOP_YIELD_THRESHOLD)) return '🏆 TOP YIELD';
  if (projectedApy.gte(VIABLE_THRESHOLD)) return '✅ VIABLE';
  if (projectedApy.gt(0)) return '⚪ MARGINAL';
  return '❌ REJECT';
}

function analyzeRecords(
  symbol: string,
  perpSymbol: string,
  source: HistorySource,
  records: readonly FundingRecord[],
  options: AnalyzerOptions,
  windowDays: number,
): SymbolAnalysis {
  if (records.length === 0) {
    throw new Error('no funding records in the requested window');
  }

  const intervalHours = inferIntervalHours(records);
  const gaps = countGaps(records, intervalHours);

  let positiveCount = 0;
  let negativeCount = 0;
  let positiveSum = new Decimal(0);
  let negativeSum = new Decimal(0);
  let bestRate = records[0].rate;
  let worstRate = records[0].rate;
  let longestNegativeStreak = 0;
  let currentNegativeStreak = 0;

  // Max peak-to-trough decline of the cumulative funding curve: the real
  // "pain" a holder would have sat through, independent of the final sign.
  let cumulative = new Decimal(0);
  let cumulativePeak = new Decimal(0);
  let maxFundingDrawdown = new Decimal(0);

  for (const record of records) {
    const rate = record.rate;

    if (rate.gt(0)) {
      positiveCount += 1;
      positiveSum = positiveSum.plus(rate);
      currentNegativeStreak = 0;
    } else if (rate.lt(0)) {
      negativeCount += 1;
      negativeSum = negativeSum.plus(rate);
      currentNegativeStreak += 1;
      if (currentNegativeStreak > longestNegativeStreak) {
        longestNegativeStreak = currentNegativeStreak;
      }
    } else {
      // A zero epoch is neither paid nor received and breaks the losing run.
      currentNegativeStreak = 0;
    }

    if (rate.gt(bestRate)) bestRate = rate;
    if (rate.lt(worstRate)) worstRate = rate;

    cumulative = cumulative.plus(rate);
    if (cumulative.gt(cumulativePeak)) cumulativePeak = cumulative;
    const drawdown = cumulativePeak.minus(cumulative);
    if (drawdown.gt(maxFundingDrawdown)) maxFundingDrawdown = drawdown;
  }

  const netFunding = positiveSum.plus(negativeSum);
  const fees = options.roundTripFee;
  const netProfit = netFunding.minus(fees);

  const coverageDays = new Decimal(records[records.length - 1].timestamp - records[0].timestamp)
    .div(DAY_MS);
  const coverageNumber = coverageDays.toNumber();
  // A pair that listed mid-window must not be annualized as if it had traded
  // for the full nominal window. Full coverage keeps the documented 365/180.
  const annualizationDays =
    coverageNumber >= windowDays * 0.95 ? windowDays : Math.max(coverageNumber, 1);

  const projectedApy = netProfit.mul(new Decimal(365).div(annualizationDays));

  return {
    symbol,
    perpSymbol,
    source,
    records: records.length,
    firstTimestamp: records[0].timestamp,
    lastTimestamp: records[records.length - 1].timestamp,
    intervalHours,
    coverageDays,
    annualizationDays,
    gaps,
    positiveCount,
    negativeCount,
    positiveRatio: new Decimal(positiveCount).div(records.length),
    positiveSum,
    negativeSum,
    netFunding,
    fees,
    netProfit,
    projectedApy,
    bestRate,
    worstRate,
    longestNegativeStreak,
    maxFundingDrawdown,
    verdict: verdictFor(projectedApy),
  };
}

// ---------------------------------------------------------------------------
// Per-symbol pipeline
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof BybitApiError) return `[${error.retCode}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function analyzeSymbol(
  client: PublicBybitClient,
  symbol: string,
  options: AnalyzerOptions,
  fromMs: number,
  toMs: number,
): Promise<SymbolAnalysis> {
  const perpSymbol = PERP_ALIASES[symbol] ?? symbol;

  // A hedge needs BOTH legs live. Funding history can still be returned for a
  // delisted perp (Bybit keeps the archive), so status must be checked first.
  const perpStatus = await probeInstrument(client, 'linear', perpSymbol);
  if (perpStatus !== 'Trading') {
    throw new Error(`${EXCLUDED}: perp ${perpSymbol} status is ${perpStatus ?? 'MISSING'}`);
  }

  const spotStatus = await probeInstrument(client, 'spot', symbol);
  if (spotStatus !== 'Trading') {
    throw new Error(`${EXCLUDED}: spot ${symbol} status is ${spotStatus ?? 'MISSING'}`);
  }

  const cachePath = getCachePath(options.cacheDir, symbol);
  const cache = readCache(cachePath, symbol, perpSymbol);
  const cachedRecords = cache ? cache.records : [];
  const cachedIntervalHours = cache?.intervalHours ?? 8;
  const cachedIntervalMs = cachedIntervalHours * HOUR_MS;

  if (options.offline) {
    if (!cache || cachedRecords.length === 0) {
      throw new Error(`[OFFLINE] no cache at ${cachePath}`);
    }
    return analyzeRecords(
      symbol,
      perpSymbol,
      'cache',
      filterWindow(cachedRecords, fromMs, toMs),
      options,
      options.days,
    );
  }

  const cacheFresh =
    cache !== null && Date.now() - cache.fetchedAt <= DEFAULT_CACHE_TTL_MS;
  if (!options.refresh && cacheFresh && cachedRecords.length > 0) {
    const first = cachedRecords[0].timestamp;
    const last = cachedRecords[cachedRecords.length - 1].timestamp;
    const coversWindow =
      first <= fromMs + cachedIntervalMs && last >= toMs - 2 * cachedIntervalMs;
    if (coversWindow) {
      return analyzeRecords(
        symbol,
        perpSymbol,
        'cache',
        filterWindow(cachedRecords, fromMs, toMs),
        options,
        options.days,
      );
    }
  }

  try {
    const fetched = await fetchFundingRecords(client, perpSymbol, fromMs, toMs);
    if (fetched.length === 0) {
      if (cachedRecords.length > 0) {
        console.warn(`  [WARN] ${symbol}: empty response, falling back to cache`);
        return analyzeRecords(
          symbol,
          perpSymbol,
          'cache-fallback',
          filterWindow(cachedRecords, fromMs, toMs),
          options,
          options.days,
        );
      }
      throw new Error('Bybit returned no funding history');
    }

    const merged = mergeRecords(cachedRecords, fetched);
    const intervalHours = inferIntervalHours(merged);
    writeCache(cachePath, symbol, perpSymbol, intervalHours, merged);

    const windowRecords = filterWindow(merged, fromMs, toMs);

    return analyzeRecords(
      symbol,
      perpSymbol,
      cachedRecords.length > 0 ? 'cache+network' : 'network',
      windowRecords,
      options,
      options.days,
    );
  } catch (error) {
    if (cachedRecords.length > 0) {
      console.warn(
        `  [WARN] ${symbol}: network fetch failed (${describeError(error)}); using cache`,
      );
      return analyzeRecords(
        symbol,
        perpSymbol,
        'cache-fallback',
        filterWindow(cachedRecords, fromMs, toMs),
        options,
        options.days,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPercent(value: Decimal, decimals: number, signed = true): string {
  const percent = value.mul(100).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const body = `${percent.abs().toFixed(decimals)}%`;
  if (percent.lt(0)) return `-${body}`;
  if (!signed || percent.isZero()) return body;
  return `+${body}`;
}

function formatUtcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatSource(source: HistorySource): string {
  switch (source) {
    case 'cache':
      return 'cache';
    case 'network':
      return 'network';
    case 'cache+network':
      return 'cache+network';
    case 'cache-fallback':
      return 'cache-fallback';
    default:
      return String(source);
  }
}

function symbolCell(analysis: SymbolAnalysis, windowDays: number): string {
  const partial = analysis.coverageDays.toNumber() < windowDays * 0.95;
  return partial ? `${analysis.symbol} ⚠` : analysis.symbol;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildMainTable(
  analyses: readonly SymbolAnalysis[],
  windowDays: number,
): string {
  const lines: string[] = [
    '| Rank | Symbol | Records | Positive % | Gross Yield (180d) | Fees | Net Profit (180d) | Projected Net APY | Verdict |',
    '| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |',
  ];

  analyses.forEach((analysis, index) => {
    lines.push(
      `| ${index + 1} | ${symbolCell(analysis, windowDays)} | ${analysis.records} | ` +
        `${formatPercent(analysis.positiveRatio, 1, false)} | ` +
        `${formatPercent(analysis.netFunding, 3)} | ` +
        `-${formatPercent(analysis.fees, 3, false)} | ` +
        `${formatPercent(analysis.netProfit, 3)} | ` +
        `${formatPercent(analysis.projectedApy, 2)} | ` +
        `${analysis.verdict} |`,
    );
  });

  return lines.join('\n');
}

function buildRiskTable(analyses: readonly SymbolAnalysis[]): string {
  const lines: string[] = [
    '| Symbol | Coverage | Interval | Gaps | Epochs paid | Epochs received | Best epoch | Worst epoch | Longest negative streak | Max funding DD |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const analysis of analyses) {
    const streakHours =
      analysis.longestNegativeStreak * analysis.intervalHours;
    const streak =
      analysis.longestNegativeStreak === 0
        ? '0'
        : `${analysis.longestNegativeStreak} (${streakHours}h)`;

    lines.push(
      `| ${analysis.symbol} | ${analysis.coverageDays.toFixed(0)}d | ${analysis.intervalHours}h | ` +
        `${analysis.gaps} | ${analysis.negativeCount} | ${analysis.positiveCount} | ` +
        `${formatPercent(analysis.bestRate, 4, false)} | ` +
        `${formatPercent(analysis.worstRate, 4, false)} | ${streak} | ` +
        `${formatPercent(analysis.maxFundingDrawdown, 3, false)} |`,
    );
  }

  return lines.join('\n');
}

function buildReportMarkdown(
  analyses: readonly SymbolAnalysis[],
  failures: readonly SymbolFailure[],
  excluded: readonly SymbolFailure[],
  options: AnalyzerOptions,
  fromMs: number,
  toMs: number,
): string {
  const sorted = [...analyses].sort((a, b) => b.projectedApy.comparedTo(a.projectedApy));
  const topYield = sorted.filter((analysis) => analysis.projectedApy.gt(TOP_YIELD_THRESHOLD));
  const medianApy =
    sorted.length === 0
      ? new Decimal(0)
      : (() => {
          const middle = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 0
            ? sorted[middle - 1].projectedApy.plus(sorted[middle].projectedApy).div(2)
            : sorted[middle].projectedApy;
        })();

  const sections: string[] = [];

  sections.push('# 💰 Delta-Neutral Funding Yield Report — Bybit V5');
  sections.push('');
  sections.push(`**Generated:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  sections.push(
    `**Window:** ${formatUtcDate(fromMs)} → ${formatUtcDate(toMs)} (${options.days} days)`,
  );
  sections.push(
    `**Universe:** ${options.symbols.length} requested · ${sorted.length} analyzed · ` +
      `${excluded.length} excluded · ${failures.length} failed`,
  );
  sections.push('**Strategy:** spot long + perpetual short, 1:1 notional, continuous hold (no rebalancing)');
  sections.push(
    `**Cost model:** ${formatPercent(options.roundTripFee, 3, false)} round trip on capital (both legs, entry + exit)`,
  );
  sections.push('**Data source:** Bybit V5 `GET /v5/market/funding/history` (linear, public)');
  sections.push('');
  sections.push(
    `**Top yield (Net APY > 20%):** ${topYield.length === 0 ? 'none' : topYield.map((analysis) => analysis.symbol).join(', ')} · ` +
      `**Median Net APY:** ${formatPercent(medianApy, 2)}`,
  );
  sections.push('');
  sections.push('## 📊 Yield Ranking');
  sections.push('');
  sections.push(buildMainTable(sorted, options.days));
  sections.push('');
  sections.push(
    '*Gross Yield and Net Profit are cumulative over the window, as a % of the hedged notional. ' +
      '`⚠` marks a pair with less than 95% of the window covered by real history — its APY is ' +
      'annualized from the available days, not from the nominal 180.*',
  );
  sections.push('');
  sections.push('## 📉 Risk & Data Quality');
  sections.push('');
  sections.push(buildRiskTable(sorted));
  sections.push('');
  sections.push(
    '**Reading the table:** `Longest negative streak` is the longest uninterrupted run of epochs ' +
      'where the short pays. `Max funding DD` is the deepest peak-to-trough decline of the cumulative ' +
      'funding curve — the worst paper loss a holder would have sat through, even if the final sum is positive.',
  );
  sections.push('');
  sections.push('## 🚫 Excluded Symbols');
  sections.push('');
  if (excluded.length === 0) {
    sections.push('None — every requested pair has a live spot market and a live linear perpetual.');
  } else {
    for (const item of excluded) {
      sections.push(`- **${item.symbol}** — ${item.error.replace(`${EXCLUDED}: `, '')}`);
    }
  }
  sections.push('');
  sections.push('## ⚠️ Failed Symbols');
  sections.push('');
  if (failures.length === 0) {
    sections.push('None — every eligible pair produced usable history.');
  } else {
    for (const item of failures) {
      sections.push(`- **${item.symbol}** — ${item.error}`);
    }
  }
  sections.push('');
  sections.push('## 🧮 Methodology');
  sections.push('');
  sections.push(
    '1. **Fetch.** `GET /v5/market/funding/history` (`category=linear`, `limit=200`), paginated ' +
      'backwards by `endTime` in 200-record pages over the requested window, deduped by timestamp ' +
      'and cached at `data/funding_history/<SYMBOL>_funding.json`.',
  );
  sections.push(
    '2. **Sign convention.** A positive rate is paid by longs to shorts, so the short leg receives it; ' +
      'a negative rate is paid by the short leg. `Net Funding = Σ positive + Σ negative`.',
  );
  sections.push(
    '3. **Interval agnosticism.** Funding settles once per epoch (1h, 4h or 8h depending on the pair). ' +
      'Because every rate is charged on notional once, summing the signed rates yields the cumulative ' +
      'return regardless of interval — no per-epoch normalization is needed.',
  );
  sections.push(
    `4. **Fees.** A flat ${formatPercent(options.roundTripFee, 3, false)} round-trip charge on capital ` +
      'covers both legs at entry and exit. Override with `--fees`.',
  );
  sections.push(
    '5. **Net Profit** = `Net Funding − Fees`. **Projected Net APY** = `Net Profit × 365 / days` ' +
      '(simple extrapolation, not compounded), per the Phase 1 specification.',
  );
  sections.push(
    '6. **Positive %** counts epochs with `rate > 0` strictly. Zero-rate epochs are neither paid nor received.',
  );
  sections.push('');
  sections.push('## ⚠️ Caveats');
  sections.push('');
  sections.push(
    '- **Historical funding is not a forecast.** Altcoin funding is regime-dependent: it is high while ' +
      'perp longs crowd in and can stay negative for days during capitulation. Read `Longest negative streak` ' +
      'and `Max funding DD` before sizing anything.',
  );
  sections.push(
    '- **Basis is not modeled.** This screener isolates funding. Spot/perp basis convergence, borrow cost, ' +
      'slippage beyond the fee, margin/liquidation mechanics and exchange outages are out of scope — they are ' +
      'the live engine\'s job, not the screener\'s.',
  );
  sections.push(
    '- **No leverage.** `Net Profit` and `APY` are on capital equal to the hedged notional. Leverage changes ' +
      'the return on equity, and with it the liquidation risk, which Phase 1 deliberately does not model.',
  );
  sections.push(
    '- **Cache reuse.** A cache younger than 12h that fully covers the window is reused; `--refresh` forces a ' +
      'network refetch and `--offline` forbids one.',
  );
  sections.push('');

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
Delta-Neutral Funding Yield Analyzer — Bybit V5

Usage: npm run funding:analyze [-- options]

Options:
  --days=<n>          Window length in days (default ${DEFAULT_DAYS})
  --symbols=<list>    Comma-separated symbols (default: top-20 altcoin universe)
  --fees=<rate|pct>   Round-trip cost on capital (default ${DEFAULT_ROUND_TRIP_FEE.toString()} = 0.20%)
  --cache-dir=<path>  Cache root (default ${DEFAULT_CACHE_DIR})
  --out=<path>        Markdown report path (default ${DEFAULT_REPORT_PATH})
  --concurrency=<n>   Concurrent symbol fetches (default ${DEFAULT_CONCURRENCY})
  --delay=<ms>        Delay between REST calls (default ${DEFAULT_REQUEST_GAP_MS})
  --refresh           Ignore a fresh cache and refetch
  --offline           Cache only; never hit the network
  -h, --help          Show this help

Verdicts: 🏆 TOP YIELD (APY > 20%) · ✅ VIABLE (10–20%) · ⚪ MARGINAL (0–10%) · ❌ REJECT (<= 0)
`);
}

function parseDecimalRate(raw: string, flag: string): Decimal {
  const trimmed = raw.trim();
  try {
    if (trimmed.endsWith('%')) return new Decimal(trimmed.slice(0, -1)).div(100);
    return new Decimal(trimmed);
  } catch {
    throw new Error(`${flag}: invalid decimal or percentage "${raw}"`);
  }
}

function parsePositiveInteger(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${flag}: expected an integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${flag}: integer out of range: ${raw}`);
  }
  return value;
}

function parseSymbols(raw: string): readonly string[] {
  const symbols = raw
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  if (symbols.length === 0) {
    throw new Error('--symbols must contain at least one symbol');
  }
  return [...new Set(symbols)];
}

function parseOptions(argv: string[]): AnalyzerOptions | null {
  const options: AnalyzerOptions = {
    symbols: DEFAULT_UNIVERSE,
    days: DEFAULT_DAYS,
    roundTripFee: DEFAULT_ROUND_TRIP_FEE,
    cacheDir: DEFAULT_CACHE_DIR,
    reportPath: DEFAULT_REPORT_PATH,
    refresh: false,
    offline: false,
    requestGapMs: DEFAULT_REQUEST_GAP_MS,
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      printUsage();
      return null;
    }
    if (arg === '--refresh') {
      options.refresh = true;
      continue;
    }
    if (arg === '--offline') {
      options.offline = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg} (use --help)`);
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    let value: string;

    if (equalsIndex !== -1) {
      value = arg.slice(equalsIndex + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${key} requires a value`);
      }
      value = next;
      i += 1;
    }

    switch (key) {
      case 'days':
        options.days = parsePositiveInteger(value, '--days');
        break;
      case 'symbols':
        options.symbols = parseSymbols(value);
        break;
      case 'fees':
        options.roundTripFee = parseDecimalRate(value, '--fees');
        break;
      case 'cache-dir':
        options.cacheDir = value;
        break;
      case 'out':
        options.reportPath = value;
        break;
      case 'concurrency':
        options.concurrency = parsePositiveInteger(value, '--concurrency');
        break;
      case 'delay':
        options.requestGapMs = parsePositiveInteger(value, '--delay');
        break;
      default:
        throw new Error(`Unknown option: --${key} (use --help)`);
    }
  }

  if (options.days < 7 || options.days > 3650) {
    throw new Error(`--days must be in [7, 3650], got ${options.days}`);
  }
  if (!options.roundTripFee.gte(0) || options.roundTripFee.gt(0.1)) {
    throw new Error('--fees must be in [0, 0.1] (0%–10%)');
  }
  if (options.concurrency < 1 || options.concurrency > 10) {
    throw new Error('--concurrency must be in [1, 10]');
  }
  if (options.requestGapMs > 10_000) {
    throw new Error('--delay must be <= 10000 ms');
  }
  if (options.offline && options.refresh) {
    throw new Error('--offline and --refresh are mutually exclusive');
  }

  return options;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) return;

  const toMs = Date.now();
  const fromMs = toMs - options.days * DAY_MS;

  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  DELTA-NEUTRAL FUNDING YIELD ANALYZER — BYBIT V5 (PHASE 1)');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`Window      : ${formatUtcDate(fromMs)} → ${formatUtcDate(toMs)} (${options.days} days)`);
  console.log(`Universe    : ${options.symbols.length} symbols`);
  console.log(
    `Cost model  : ${formatPercent(options.roundTripFee, 3, false)} round trip on capital`,
  );
  console.log(
    `Mode        : ${options.offline ? 'offline cache' : options.refresh ? 'refresh (network)' : 'network + cache'}`,
  );
  console.log('');

  const client = new PublicBybitClient(options.requestGapMs);
  const analyses: SymbolAnalysis[] = [];
  const failures: SymbolFailure[] = [];
  const excluded: SymbolFailure[] = [];

  let nextIndex = 0;
  const workerCount = Math.min(options.concurrency, options.symbols.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.symbols.length) return;

      const symbol = options.symbols[index];
      try {
        const analysis = await analyzeSymbol(client, symbol, options, fromMs, toMs);
        analyses.push(analysis);
        console.log(
          `  [${symbol}] ${analysis.records} records (${analysis.intervalHours}h) | ` +
            `gross ${formatPercent(analysis.netFunding, 3)} | ` +
            `net ${formatPercent(analysis.netProfit, 3)} | ` +
            `APY ${formatPercent(analysis.projectedApy, 2)} | ` +
            `${analysis.verdict} [${formatSource(analysis.source)}]`,
        );
      } catch (error) {
        const message = describeError(error);
        if (message.startsWith(EXCLUDED)) {
          const reason = message.slice(EXCLUDED.length + 1).trim();
          excluded.push({ symbol, error: reason });
          console.log(`  [${symbol}] ⏭  excluded — ${reason}`);
        } else {
          failures.push({ symbol, error: message });
          console.error(`  [${symbol}] ✖ failed — ${message}`);
        }
      }
    }
  });

  await Promise.all(workers);

  if (analyses.length === 0) {
    console.error('');
    console.error('No symbol produced a usable funding history. Nothing to report.');
    process.exitCode = 1;
    return;
  }

  const sorted = [...analyses].sort((a, b) => b.projectedApy.comparedTo(a.projectedApy));
  const report = buildReportMarkdown(analyses, failures, excluded, options, fromMs, toMs);

  const reportPath = resolve(process.cwd(), options.reportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report, 'utf-8');

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(buildMainTable(sorted, options.days));

  if (excluded.length > 0) {
    console.log('');
    console.log('Excluded (not tradeable as a delta-neutral hedge):');
    for (const item of excluded) {
      console.log(`  - ${item.symbol}: ${item.error}`);
    }
  }
  if (failures.length > 0) {
    console.log('');
    console.log('Failed (data unavailable):');
    for (const item of failures) {
      console.log(`  - ${item.symbol}: ${item.error}`);
    }
  }

  const topYield = sorted.filter((analysis) => analysis.projectedApy.gt(TOP_YIELD_THRESHOLD));
  console.log('');
  console.log(
    `Top yield (APY > 20%): ${topYield.length === 0 ? 'none' : topYield.map((analysis) => analysis.symbol).join(', ')}`,
  );
  console.log(
    `API usage: ${client.requests} requests${client.rateLimitHits > 0 ? `, ${client.rateLimitHits} rate-limit hits` : ''}`,
  );
  console.log(`Report: ${options.reportPath}`);
  console.log(`Cache:  ${options.cacheDir}/<SYMBOL>_funding.json`);
  console.log('');
  console.log('Notes:');
  console.log('  • Funding sum is interval-agnostic (1h / 4h / 8h epochs are all one charge on notional).');
  console.log('  • APY is a simple 365/days extrapolation, not compounded; no leverage, no basis PnL.');
  console.log('  • Historical funding is regime-dependent — read the risk table before sizing.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exitCode = 1;
});
