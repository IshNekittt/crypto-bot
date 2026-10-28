#!/usr/bin/env node

/**
 * Bybit V5 Market Screener — "Asset DNA" for the two production engines.
 *
 * Pure read-only diagnostic. It talks exclusively to PUBLIC Bybit V5 REST
 * endpoints and never imports `src/config/env.ts`, so it does not require any
 * credential and cannot mutate strategy state or `.env`.
 *
 * Two independent fits are scored:
 *
 *   V5 Sniper (Emilia, 1m)  — needs 1m ATR wide enough to out-earn the
 *                             round-trip taker fee (0.110%).
 *                             viabilityRatio = atr1m% / 0.110%  (target >= 2.0)
 *
 *   V4 Tank (Subaru, 15m/4H) — needs persistent directional flow and depth.
 *                             KER_4H (Kaufman Efficiency Ratio, 20) >= 0.30
 *                             ADR% (24h projected from 4H ATR14)  >= 3.5%
 *                             turnover24h                          >= $50M
 *
 * Usage:
 *   npx ts-node scripts/screener.ts
 *   npx ts-node scripts/screener.ts --top=50 --delay=200
 *   npx ts-node scripts/screener.ts --out=data/screener_results.json --md=data/screener_report.md
 *
 * Exit codes: 0 = report written, 1 = fatal error (network / no universe).
 */

import { Decimal } from 'decimal.js';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

// ---------------------------------------------------------------------------
// Constants — fee model mirrors src/config/fees.ts (TAKER_FEE_RATE * 2)
// ---------------------------------------------------------------------------

/** Round-trip taker fee as a percentage: 0.055% * 2 = 0.110%. */
const ROUND_TRIP_TAKER_FEE_PCT = new Decimal('0.11');

const SNIPER_MIN_VIABILITY = new Decimal('2.0');
const SNIPER_MIN_TURNOVER_USD = new Decimal(15_000_000);

const TANK_MIN_KER = new Decimal('0.30');
const TANK_MIN_ADR_PCT = new Decimal('3.5');
const TANK_MIN_TURNOVER_USD = new Decimal(50_000_000);

/** Reference instrument used to compare every candidate against NEAR's DNA. */
const BENCHMARK_SYMBOL = 'NEARUSDT';

const ATR_PERIOD = 14;
const KER_PERIOD = 20;
/** 1000 x 1m = 16.6h of history: the headline window is the newest 100 bars. */
const CANDLES_1M = 1000;
/** Headline 1m window required by the Sniper definition. */
const HEADLINE_1M = 100;
/** 200 x 4H = 33 days: ample for 6 non-overlapping KER windows. */
const CANDLES_4H = 200;
const SAMPLE_BLOCK_1M = HEADLINE_1M;
const KER_WINDOWS = 6;
const MS_1M = 60_000;
const MS_4H = 14_400_000;
/** Tolerance against exchange/client clock drift when dropping the forming candle. */
const CLOCK_GRACE_MS = 1_500;

const BYBIT_BASE_URL = 'https://api.bybit.com';
const MAX_ATTEMPTS = 5;
const RETRYABLE_RET_CODES = new Set([10000, 10006, 10016]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScreenerOptions {
  universeSize: number;
  requestGapMs: number;
  outputPath: string;
  reportPath: string;
}

interface Ticker {
  symbol: string;
  lastPrice: Decimal;
  turnover24h: Decimal;
  price24hPct: Decimal;
  high24h: Decimal;
  low24h: Decimal;
}

interface Candle {
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  turnover: Decimal;
}

type Fit = 'SNIPER' | 'TANK' | 'BOTH' | 'NONE';

type KerDirection = 'UP' | 'DOWN' | 'FLAT';

/**
 * Post-classification microstructure probe, run only for the shortlist.
 * The taker fee is a floor on cost — a wide book is paid on top of it, so
 * `netViability` is the honest version of the Sniper ratio.
 */
interface OrderbookQuality {
  bid: Decimal;
  ask: Decimal;
  spreadBps: Decimal;
  spreadPct: Decimal;
  /** Round-trip taker fee (0.110%) + one full spread crossing. */
  effectiveCostPct: Decimal;
  /** atr1mPct / effectiveCostPct — snapshot. */
  netViability: Decimal;
  /** atr1mPctAvg / effectiveCostPct — the regime, used for ranking. */
  netViabilityAvg: Decimal;
}

interface AssetDna {
  symbol: string;
  rank: number;
  price: Decimal;
  turnover24h: Decimal;
  turnover24hM: Decimal;
  price24hPct: Decimal;

  // Sniper block (1m)
  candles1m: number;
  atr1m: Decimal;
  atr1mPct: Decimal;
  viabilityRatio: Decimal;
  /** 16h mean of 100-bar ATR% blocks — the regime, not the snapshot. */
  atr1mPctAvg: Decimal;
  viabilityAvg: Decimal;

  // Tank block (4H)
  candles4h: number;
  atr4h: Decimal;
  atr4hPct: Decimal;
  adrPct: Decimal;
  ker4h: Decimal;
  /** Mean of up to 6 non-overlapping KER windows — trend persistence. */
  ker4hAvg: Decimal;
  kerWindows: number;
  kerDirection: KerDirection;
  netChangePct4h: Decimal;

  // Classification
  sniperEligible: boolean;
  tankEligible: boolean;
  /** Gate passes on the averaged regime, not only on the newest window. */
  sniperStable: boolean;
  tankStable: boolean;
  fit: Fit;
  rejections: string[];
  riskFlags: string[];
  orderbook: OrderbookQuality | null;
}

interface ScreenerResult {
  generatedAt: string;
  source: string;
  thresholds: Record<string, string>;
  universe: {
    requested: number;
    evaluated: number;
    skipped: Array<{ symbol: string; reason: string }>;
    requests: number;
    rateLimitHits: number;
  };
  benchmark: AssetDna | null;
  sniperTargets: AssetDna[];
  tankTargets: AssetDna[];
  blacklist: AssetDna[];
  assets: AssetDna[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toDecimal = (value: Decimal.Value): Decimal => new Decimal(value);

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const padRight = (value: string, width: number): string => value.padEnd(width, ' ');

const padLeft = (value: string, width: number): string => value.padStart(width, ' ');

const usdMillions = (value: Decimal): string => `$${value.dividedBy(1_000_000).toFixed(1)}M`;

const pct = (value: Decimal, decimals = 3): string => `${value.toFixed(decimals)}%`;

function printUsage(): void {
  console.log(`
Bybit V5 Market Screener — Asset DNA (Sniper / Tank)

Usage: npx ts-node scripts/screener.ts [options]

Options:
  --top=<n>       Universe size by 24h turnover (default 50)
  --delay=<ms>    Delay between REST calls (default 200)
  --out=<path>    JSON output (default data/screener_results.json)
  --md=<path>     Markdown output (default data/screener_report.md)
  -h, --help      Show this help

Thresholds:
  Sniper: viabilityRatio >= ${SNIPER_MIN_VIABILITY.toString()} (1m ATR% >= ${SNIPER_MIN_VIABILITY.mul(ROUND_TRIP_TAKER_FEE_PCT).toFixed(3)}%) and turnover24h >= ${usdMillions(SNIPER_MIN_TURNOVER_USD)}
  Tank:   KER_4H >= ${TANK_MIN_KER.toString()}, ADR% >= ${TANK_MIN_ADR_PCT.toString()}, turnover24h >= ${usdMillions(TANK_MIN_TURNOVER_USD)}
`);
}

function parseOptions(argv: string[]): ScreenerOptions | null {
  const options: ScreenerOptions = {
    universeSize: 50,
    requestGapMs: 200,
    outputPath: 'data/screener_results.json',
    reportPath: 'data/screener_report.md',
  };

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      printUsage();
      return null;
    }
    if (arg.startsWith('--top=')) {
      const parsed = Number(arg.slice('--top='.length));
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        throw new Error(`Invalid --top value: ${arg.slice('--top='.length)} (expected integer 1..500)`);
      }
      options.universeSize = parsed;
      continue;
    }
    if (arg.startsWith('--delay=')) {
      const parsed = Number(arg.slice('--delay='.length));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
        throw new Error(`Invalid --delay value: ${arg.slice('--delay='.length)} (expected 0..10000 ms)`);
      }
      options.requestGapMs = parsed;
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.outputPath = arg.slice('--out='.length);
      continue;
    }
    if (arg.startsWith('--md=')) {
      options.reportPath = arg.slice('--md='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

// ---------------------------------------------------------------------------
// Public Bybit V5 REST client (rate-limit aware)
// ---------------------------------------------------------------------------

class PublicBybitClient {
  public requests = 0;
  public rateLimitHits = 0;

  public constructor(private readonly gapMs: number) {}

  /** Throttled GET with exponential backoff on 429 / retryable business codes. */
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
          console.warn(`  [429] Rate limited on ${path} — retrying in ${pause}ms (${attempt}/${MAX_ATTEMPTS})`);
          await sleep(pause);
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${path}`);
        }

        const payload = (await response.json()) as { retCode: number; retMsg: string; result: T };

        if (payload.retCode !== 0) {
          const retryable = RETRYABLE_RET_CODES.has(payload.retCode);
          if (retryable && attempt < MAX_ATTEMPTS) {
            const pause = 1_000 * 2 ** (attempt - 1);
            console.warn(
              `  [${payload.retCode}] ${payload.retMsg} on ${path} — retrying in ${pause}ms (${attempt}/${MAX_ATTEMPTS})`,
            );
            await sleep(pause);
            continue;
          }
          throw new Error(`Bybit [${payload.retCode}] ${payload.retMsg} for ${path}`);
        }

        return payload.result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isLast = attempt === MAX_ATTEMPTS;
        // Business errors already produced their own message; retry only network faults.
        const isNetworkFault = !message.startsWith('Bybit [') && !message.startsWith('HTTP 4');
        if (isLast || !isNetworkFault) {
          throw error instanceof Error ? error : new Error(message);
        }
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
// Parsing
// ---------------------------------------------------------------------------

function parseTickers(result: { list?: unknown }): Ticker[] {
  const rows = Array.isArray(result.list) ? result.list : [];
  const tickers: Ticker[] = [];

  for (const row of rows) {
    const item = row as Record<string, unknown>;
    const symbol = typeof item.symbol === 'string' ? item.symbol : '';
    if (!symbol) continue;

    try {
      const lastPrice = toDecimal(String(item.lastPrice ?? '0'));
      const turnover24h = toDecimal(String(item.turnover24h ?? '0'));
      if (!lastPrice.isFinite() || lastPrice.lte(0)) continue;
      if (!turnover24h.isFinite() || turnover24h.lte(0)) continue;

      tickers.push({
        symbol,
        lastPrice,
        turnover24h,
        price24hPct: toDecimal(String(item.price24hPcnt ?? '0')).mul(100),
        high24h: toDecimal(String(item.highPrice24h ?? '0')),
        low24h: toDecimal(String(item.lowPrice24h ?? '0')),
      });
    } catch {
      // Malformed numeric field — skip this instrument, never poison the universe.
    }
  }

  return tickers;
}

/** Bybit returns klines newest-first; normalise to ascending and validate. */
function parseKlines(result: { list?: unknown }): Candle[] {
  const rows = Array.isArray(result.list) ? result.list : [];
  const candles: Candle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    try {
      const candle: Candle = {
        timestamp: Number(row[0]),
        open: toDecimal(String(row[1])),
        high: toDecimal(String(row[2])),
        low: toDecimal(String(row[3])),
        close: toDecimal(String(row[4])),
        volume: toDecimal(String(row[5])),
        turnover: toDecimal(String(row[6])),
      };
      if (!Number.isFinite(candle.timestamp) || candle.timestamp <= 0) continue;
      if ([candle.open, candle.high, candle.low, candle.close].some((value) => !value.isFinite() || value.lte(0))) {
        continue;
      }
      candles.push(candle);
    } catch {
      // Skip malformed bar.
    }
  }

  candles.sort((left, right) => left.timestamp - right.timestamp);
  return candles;
}

/**
 * Drop the still-forming candle. Its high/low change on every tick, so including
 * it would make ATR and KER unstable and non-reproducible between runs.
 */
function dropFormingCandle(candles: Candle[], intervalMs: number, nowMs: number): Candle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  if (last.timestamp + intervalMs > nowMs + CLOCK_GRACE_MS) {
    return candles.slice(0, -1);
  }
  return candles;
}

// ---------------------------------------------------------------------------
// Metrics — mirrors the canonical implementations in src/
// ---------------------------------------------------------------------------

/**
 * ATR as the arithmetic mean of the last `period` True Ranges.
 * Identical to `PatternRecognizer.calculateATR()` and
 * `Scenario12_SniperTouch.calculateATR()` (simple mean, not Wilder smoothing).
 */
function calculateAtr(candles: Candle[], period: number): Decimal {
  if (candles.length < period + 1) return new Decimal(0);

  let sum = new Decimal(0);
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    const trueRange = Decimal.max(
      current.high.minus(current.low),
      current.high.minus(previous.close).abs(),
      current.low.minus(previous.close).abs(),
    );
    sum = sum.plus(trueRange);
  }

  return sum.dividedBy(period);
}

interface KerResult {
  ker: Decimal;
  direction: KerDirection;
  netChangePct: Decimal;
}

/**
 * Kaufman Efficiency Ratio over the last `period` closed bars.
 *
 *   KER = |close[n] - close[n - period]| / sum(|close[i] - close[i - 1]|)
 *
 * 1.0 = perfectly straight path, ~0 = pure chop. Direction is the sign of the
 * net displacement so the Tank report can tell an uptrend from a downtrend.
 */
function calculateKer(candles: Candle[], period: number): KerResult {
  if (candles.length < period + 1) {
    return { ker: new Decimal(0), direction: 'FLAT', netChangePct: new Decimal(0) };
  }

  const window = candles.slice(-(period + 1));
  const first = window[0].close;
  const last = window[window.length - 1].close;

  let path = new Decimal(0);
  for (let i = 1; i < window.length; i += 1) {
    path = path.plus(window[i].close.minus(window[i - 1].close).abs());
  }

  const net = last.minus(first).abs();
  const ker = path.isZero() ? new Decimal(0) : Decimal.min(net.dividedBy(path), new Decimal(1));
  const netChangePct = first.isZero() ? new Decimal(0) : last.minus(first).dividedBy(first).mul(100);

  let direction: KerDirection = 'FLAT';
  if (netChangePct.gt(new Decimal('0.05'))) direction = 'UP';
  else if (netChangePct.lt(new Decimal('-0.05'))) direction = 'DOWN';

  return { ker, direction, netChangePct };
}

// ---------------------------------------------------------------------------
// DNA assembly
// ---------------------------------------------------------------------------

async function fetchDna(
  client: PublicBybitClient,
  ticker: Ticker,
  rank: number,
): Promise<AssetDna | null> {
  const nowMs = Date.now();

  const [raw1m, raw4h] = await Promise.all([
    client.get<{ list?: unknown }>('/v5/market/kline', {
      category: 'linear',
      symbol: ticker.symbol,
      interval: '1',
      limit: CANDLES_1M,
    }),
    client.get<{ list?: unknown }>('/v5/market/kline', {
      category: 'linear',
      symbol: ticker.symbol,
      interval: '240',
      limit: CANDLES_4H,
    }),
  ]);

  const candles1m = dropFormingCandle(parseKlines(raw1m), MS_1M, nowMs);
  const candles4h = dropFormingCandle(parseKlines(raw4h), MS_4H, nowMs);

  if (candles1m.length < ATR_PERIOD + 1 || candles4h.length < KER_PERIOD + 1) {
    return null;
  }

  const price = ticker.lastPrice;
  const atr1m = calculateAtr(candles1m, ATR_PERIOD);
  const atr4h = calculateAtr(candles4h, ATR_PERIOD);
  const { ker, direction, netChangePct } = calculateKer(candles4h, KER_PERIOD);

  const atr1mPct = atr1m.dividedBy(price).mul(100);
  const atr4hPct = atr4h.dividedBy(price).mul(100);
  // 6 closed 4H bars = 24h of projected range.
  const adrPct = atr4h.mul(6).dividedBy(price).mul(100);
  const viabilityRatio = atr1mPct.dividedBy(ROUND_TRIP_TAKER_FEE_PCT);

  // Robustness: a 100-bar ATR is a ~100-minute sample and swings materially
  // between runs. The multi-block mean covers the full 16h fetch, and the KER
  // mean covers the whole 4H fetch, so a single lucky window cannot drive the
  // selection on its own.
  const blocks = blockAverages(candles1m, ATR_PERIOD, SAMPLE_BLOCK_1M, price);
  const atr1mPctAvg = blocks.length > 0 ? blocks.reduce((sum, value) => sum.plus(value), new Decimal(0)).dividedBy(blocks.length) : atr1mPct;
  const viabilityAvg = atr1mPctAvg.dividedBy(ROUND_TRIP_TAKER_FEE_PCT);

  const kerWindows = rollingKers(candles4h, KER_PERIOD, KER_WINDOWS);
  const ker4hAvg =
    kerWindows.length > 0
      ? kerWindows.reduce((sum, value) => sum.plus(value), new Decimal(0)).dividedBy(kerWindows.length)
      : ker;

  const turnover24hM = ticker.turnover24h.dividedBy(1_000_000);

  const sniperEligible =
    viabilityRatio.gte(SNIPER_MIN_VIABILITY) && ticker.turnover24h.gte(SNIPER_MIN_TURNOVER_USD);
  const tankEligible =
    ker.gte(TANK_MIN_KER) &&
    adrPct.gte(TANK_MIN_ADR_PCT) &&
    ticker.turnover24h.gte(TANK_MIN_TURNOVER_USD);

  // Gates stay exactly as specified; these flags only tell a genuine fit from a
  // snapshot artefact ("passed once" vs "passes on average").
  const sniperStable = viabilityAvg.gte(SNIPER_MIN_VIABILITY);
  const tankStable = ker4hAvg.gte(TANK_MIN_KER);

  const rejections: string[] = [];
  if (!sniperEligible) {
    if (viabilityRatio.lt(SNIPER_MIN_VIABILITY)) {
      rejections.push(
        `Sniper: 1m ATR ${pct(atr1mPct)} -> viability ${viabilityRatio.toFixed(2)} (< ${SNIPER_MIN_VIABILITY.toString()})`,
      );
    }
    if (ticker.turnover24h.lt(SNIPER_MIN_TURNOVER_USD)) {
      rejections.push(`Sniper: turnover ${usdMillions(ticker.turnover24h)} (< ${usdMillions(SNIPER_MIN_TURNOVER_USD)})`);
    }
  }
  if (!tankEligible) {
    if (ker.lt(TANK_MIN_KER)) {
      rejections.push(`Tank: KER ${ker.toFixed(3)} (< ${TANK_MIN_KER.toString()})`);
    }
    if (adrPct.lt(TANK_MIN_ADR_PCT)) {
      rejections.push(`Tank: ADR ${pct(adrPct)} (< ${TANK_MIN_ADR_PCT.toString()}%)`);
    }
    if (ticker.turnover24h.lt(TANK_MIN_TURNOVER_USD)) {
      rejections.push(`Tank: turnover ${usdMillions(ticker.turnover24h)} (< ${usdMillions(TANK_MIN_TURNOVER_USD)})`);
    }
  }

  const fit: Fit =
    sniperEligible && tankEligible ? 'BOTH' : sniperEligible ? 'SNIPER' : tankEligible ? 'TANK' : 'NONE';

  const riskFlags = buildRiskFlags({
    atr1mPct,
    adrPct,
    ker,
    netChangePct,
    viabilityRatio,
    turnover24h: ticker.turnover24h,
    sniperEligible,
    sniperStable,
    tankEligible,
    tankStable,
    sawNewListing: candles4h.length < CANDLES_4H - 1,
  });

  return {
    symbol: ticker.symbol,
    rank,
    price,
    turnover24h: ticker.turnover24h,
    turnover24hM,
    price24hPct: ticker.price24hPct,
    candles1m: candles1m.length,
    atr1m,
    atr1mPct,
    viabilityRatio,
    atr1mPctAvg,
    viabilityAvg,
    candles4h: candles4h.length,
    atr4h,
    atr4hPct,
    adrPct,
    ker4h: ker,
    ker4hAvg,
    kerWindows: kerWindows.length,
    kerDirection: direction,
    netChangePct4h: netChangePct,
    sniperEligible,
    tankEligible,
    sniperStable,
    tankStable,
    fit,
    rejections,
    riskFlags,
    orderbook: null,
  };
}

/**
 * Mean ATR% of non-overlapping `blockSize` windows, walked backwards from the
 * newest closed candle. Each block is normalised by the current price so the
 * values are directly comparable regardless of when the block occurred.
 */
function blockAverages(candles: Candle[], period: number, blockSize: number, price: Decimal): Decimal[] {
  const values: Decimal[] = [];
  for (let end = candles.length; end - blockSize >= 0; end -= blockSize) {
    const block = candles.slice(end - blockSize, end);
    const atr = calculateAtr(block, period);
    if (atr.gt(0)) values.push(atr.dividedBy(price).mul(100));
  }
  return values;
}

/** Non-overlapping KER samples, walked backwards from the newest closed candle. */
function rollingKers(candles: Candle[], period: number, windows: number): Decimal[] {
  const values: Decimal[] = [];
  for (let offset = 0; offset < windows; offset += 1) {
    const end = candles.length - offset * period;
    if (end - (period + 1) < 0) break;
    values.push(calculateKer(candles.slice(end - (period + 1), end), period).ker);
  }
  return values;
}

/**
 * Structural warnings that the raw thresholds cannot express.
 *
 * ATR% is normalised by the CURRENT price, so an instrument that lost 60% of
 * its value in the lookback prints an enormous ATR% that has nothing to do with
 * tradeable range — the same for a post-listing parabola. Those regimes pass a
 * naive volatility gate while being structurally untradeable.
 */
function buildRiskFlags(input: {
  atr1mPct: Decimal;
  adrPct: Decimal;
  ker: Decimal;
  netChangePct: Decimal;
  viabilityRatio: Decimal;
  turnover24h: Decimal;
  sniperEligible: boolean;
  sniperStable: boolean;
  tankEligible: boolean;
  tankStable: boolean;
  sawNewListing: boolean;
}): string[] {
  const flags: string[] = [];
  const netChange = input.netChangePct;

  if (input.viabilityRatio.lt(1)) flags.push('sniper fee-dominated (1m ATR below round-trip taker fee)');
  if (input.atr1mPct.gt(1)) flags.push('extreme 1m volatility (> 1% per bar)');
  if (input.adrPct.gt(100)) flags.push('post-launch distortion (ADR > 100% of price)');
  else if (input.adrPct.gt(40)) flags.push('extreme range (ADR > 40%)');
  if (netChange.abs().gt(50)) flags.push(`parabolic move (${netChange.toFixed(0)}% over 20 x 4H)`);
  if (input.ker.lt(new Decimal('0.15')) && input.adrPct.gt(5)) flags.push('chop trap (high range, no directional efficiency)');
  if (input.turnover24h.lt(SNIPER_MIN_TURNOVER_USD)) flags.push('thin book (< $15M/24h)');
  if (input.sawNewListing) flags.push('limited 4H history (< 200 bars) — metrics span the launch regime');
  if (input.sniperEligible && !input.sniperStable) flags.push('volatility regime outlier (16h mean fails the Sniper gate)');
  if (input.tankEligible && !input.tankStable) flags.push('trend not persistent (4H KER mean fails)');

  return flags;
}

/** Orderbook microstructure for the shortlist — spread is a real, recurring cost. */
async function fetchOrderbook(
  client: PublicBybitClient,
  symbol: string,
  atr1mPct: Decimal,
  atr1mPctAvg: Decimal,
): Promise<OrderbookQuality | null> {
  const result = await client.get<{ b?: string[][]; a?: string[][] }>('/v5/market/orderbook', {
    category: 'linear',
    symbol,
    limit: 1,
  });

  const bestBid = Array.isArray(result.b) && result.b.length > 0 ? toDecimal(String(result.b[0][0])) : null;
  const bestAsk = Array.isArray(result.a) && result.a.length > 0 ? toDecimal(String(result.a[0][0])) : null;

  if (!bestBid || !bestAsk || bestBid.lte(0) || bestAsk.lte(0) || bestAsk.lte(bestBid)) return null;

  const mid = bestBid.plus(bestAsk).dividedBy(2);
  const spreadPct = bestAsk.minus(bestBid).dividedBy(mid).mul(100);
  const effectiveCostPct = ROUND_TRIP_TAKER_FEE_PCT.plus(spreadPct);

  return {
    bid: bestBid,
    ask: bestAsk,
    spreadBps: spreadPct.mul(100),
    spreadPct,
    effectiveCostPct,
    netViability: effectiveCostPct.isZero() ? new Decimal(0) : atr1mPct.dividedBy(effectiveCostPct),
    netViabilityAvg: effectiveCostPct.isZero() ? new Decimal(0) : atr1mPctAvg.dividedBy(effectiveCostPct),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function shortRejection(asset: AssetDna): string {
  if (asset.rejections.length === 0) return '—';

  const feeTrapped = asset.viabilityRatio.lt(1);
  const chopTrap = asset.ker4h.lt(new Decimal('0.15'));
  const thinBook = asset.turnover24h.lt(SNIPER_MIN_TURNOVER_USD);

  const tags: string[] = [];
  if (feeTrapped) tags.push('fee-dominated');
  if (chopTrap) tags.push('chop trap');
  if (thinBook) tags.push('thin book');
  if (tags.length === 0) tags.push('marginal');

  return tags.join(', ');
}

function buildMarkdown(result: ScreenerResult): string {
  const { benchmark } = result;
  const lines: string[] = [];

  lines.push('# Bybit V5 Asset DNA — Screener Report');
  lines.push('');
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`Source: ${result.source}`);
  lines.push(
    `Universe: top ${result.universe.requested} USDT perpetuals by 24h turnover — evaluated ${result.universe.evaluated}, skipped ${result.universe.skipped.length}, REST calls ${result.universe.requests} (429s: ${result.universe.rateLimitHits})`,
  );
  lines.push('');

  lines.push('## Thresholds');
  lines.push('');
  lines.push('| Engine | Gate | Value |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Sniper | viabilityRatio (1m ATR% / ${ROUND_TRIP_TAKER_FEE_PCT.toString()}%) | >= ${SNIPER_MIN_VIABILITY.toString()} |`);
  lines.push(`| Sniper | 24h turnover | >= ${usdMillions(SNIPER_MIN_TURNOVER_USD)} |`);
  lines.push(`| Tank | KER_4H (20) | >= ${TANK_MIN_KER.toString()} |`);
  lines.push(`| Tank | ADR% (4H ATR14 x 6) | >= ${TANK_MIN_ADR_PCT.toString()}% |`);
  lines.push(`| Tank | 24h turnover | >= ${usdMillions(TANK_MIN_TURNOVER_USD)} |`);
  lines.push('');

  if (benchmark) {
    lines.push('## NEAR Baseline (DNA reference)');
    lines.push('');
    lines.push('| Symbol | 1m ATR% | 16h ATR% mean | Viability | Mean viability | 4H KER | KER mean | ADR% | Turnover |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    lines.push(
      `| ${benchmark.symbol} | ${pct(benchmark.atr1mPct)} | ${pct(benchmark.atr1mPctAvg)} | ${benchmark.viabilityRatio.toFixed(2)}x | ${benchmark.viabilityAvg.toFixed(2)}x | ${benchmark.ker4h.toFixed(3)} | ${benchmark.ker4hAvg.toFixed(3)} | ${pct(benchmark.adrPct)} | ${usdMillions(benchmark.turnover24h)} |`,
    );
    lines.push('');
  }

  const cleanSniper = result.sniperTargets.filter((asset) => asset.riskFlags.length === 0).length;
  const cleanTank = result.tankTargets.filter(
    (asset) => !asset.riskFlags.some((flag) => !flag.startsWith('sniper fee-dominated')),
  ).length;

  lines.push('## Fit Summary');
  lines.push('');
  lines.push(
    `- Sniper gate passed by **${result.sniperTargets.length}** instruments; **${cleanSniper}** carry no structural warning.`,
  );
  lines.push(
    `- Tank gate passed by **${result.tankTargets.length}** instruments; **${cleanTank}** carry no structural warning (Sniper-only fee flags excluded).`,
  );
  lines.push(
    `- Sniper gate rejected **${result.assets.filter((asset) => !asset.sniperEligible).length}** of ${result.assets.length}; Tank gate rejected **${result.assets.filter((asset) => !asset.tankEligible).length}**.`,
  );
  lines.push(
    '- ⚠️ marks a gate that passed on the newest window but fails on the longer-window mean — treat as a regime outlier, not a stable edge.',
  );
  lines.push('');

  lines.push('## V5 Sniper (Emilia) Candidates');
  lines.push('');
  if (result.sniperTargets.length === 0) {
    lines.push('_No instrument cleared both Sniper gates in this snapshot._');
  } else {
    const nearAtr = benchmark && benchmark.atr1mPct.gt(0) ? benchmark.atr1mPct : null;
    lines.push('| # | Symbol | 1m ATR% | 16h ATR% mean | Viability (snap) | Viability (16h) | Spread | Net viability (16h) | Turnover | 4H KER | ADR% | vs NEAR 1m ATR |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    result.sniperTargets.slice(0, 15).forEach((asset, index) => {
      const relative = nearAtr ? `${asset.atr1mPct.dividedBy(nearAtr).toFixed(2)}x` : 'n/a';
      const spread = asset.orderbook ? `${asset.orderbook.spreadBps.toFixed(1)} bps` : 'n/a';
      const netViability = asset.orderbook ? `${asset.orderbook.netViabilityAvg.toFixed(2)}x` : 'n/a';
      lines.push(
        `| ${index + 1} | ${asset.symbol} | ${pct(asset.atr1mPct)} | ${pct(asset.atr1mPctAvg)} | ${asset.viabilityRatio.toFixed(2)}x | ${asset.viabilityAvg.toFixed(2)}x${asset.sniperStable ? '' : ' ⚠️'} | ${spread} | ${netViability} | ${usdMillions(asset.turnover24h)} | ${asset.ker4h.toFixed(3)} | ${pct(asset.adrPct)} | ${relative} |`,
      );
    });
  }
  lines.push('');

  lines.push('## V4 Tank (Subaru) Candidates');
  lines.push('');
  if (result.tankTargets.length === 0) {
    lines.push('_No instrument cleared all three Tank gates in this snapshot._');
  } else {
    lines.push('| # | Symbol | 4H KER | KER mean (6w) | ADR% | Turnover | Direction | 20-bar move |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    result.tankTargets.slice(0, 15).forEach((asset, index) => {
      lines.push(
        `| ${index + 1} | ${asset.symbol} | ${asset.ker4h.toFixed(3)} | ${asset.ker4hAvg.toFixed(3)}${asset.tankStable ? '' : ' ⚠️'} | ${pct(asset.adrPct)} | ${usdMillions(asset.turnover24h)} | ${asset.kerDirection} | ${pct(asset.netChangePct4h, 2)} |`,
      );
    });
  }
  lines.push('');

  lines.push('## Blacklist — failed both engines');
  lines.push('');
  lines.push('| Symbol | 1m ATR% | Viability | 4H KER | ADR% | Turnover | Diagnosis | Risk flags |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const asset of result.blacklist.slice(0, 20)) {
    const flags = asset.riskFlags.length > 0 ? asset.riskFlags.join('; ') : '—';
    lines.push(
      `| ${asset.symbol} | ${pct(asset.atr1mPct)} | ${asset.viabilityRatio.toFixed(2)}x | ${asset.ker4h.toFixed(3)} | ${pct(asset.adrPct)} | ${usdMillions(asset.turnover24h)} | ${shortRejection(asset)} | ${flags} |`,
    );
  }
  if (result.blacklist.length > 20) {
    lines.push(`| … | | | | | | | ${result.blacklist.length - 20} more in JSON |`);
  }
  lines.push('');

  lines.push('## Full Universe');
  lines.push('');
  lines.push('| Rank | Symbol | Turnover | 1m ATR% | Viability | KER_4H | ADR% | Fit |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const asset of result.assets) {
    lines.push(
      `| ${asset.rank} | ${asset.symbol} | ${usdMillions(asset.turnover24h)} | ${pct(asset.atr1mPct)} | ${asset.viabilityRatio.toFixed(2)}x | ${asset.ker4h.toFixed(3)} | ${pct(asset.adrPct)} | ${asset.fit} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function printConsole(result: ScreenerResult): void {
  console.log('');
  console.log('═'.repeat(126));
  console.log(' BYBIT V5 ASSET DNA — SNIPER (1m) / TANK (15m-4H)');
  console.log(` Universe: top ${result.universe.requested} USDT perps by turnover | evaluated ${result.universe.evaluated}`);
  console.log(` REST calls ${result.universe.requests} | 429 handled ${result.universe.rateLimitHits}`);
  console.log('═'.repeat(126));
  console.log(
    `${padLeft('#', 3)} ${padRight('SYMBOL', 14)} ${padLeft('TURNOVER', 10)} ${padLeft('1mATR%', 8)} ${padLeft('VIAB', 6)} ${padLeft('VIAB16', 7)} ${padLeft('KER4H', 7)} ${padLeft('KERavg', 7)} ${padLeft('ADR%', 7)}  FIT`,
  );
  console.log('─'.repeat(126));

  for (const asset of result.assets) {
    const fitLabel = asset.fit === 'BOTH' ? 'BOTH <<' : asset.fit === 'SNIPER' ? 'SNIPER' : asset.fit === 'TANK' ? 'TANK' : '—';
    const unstable = (asset.sniperEligible && !asset.sniperStable) || (asset.tankEligible && !asset.tankStable);
    console.log(
      `${padLeft(String(asset.rank), 3)} ${padRight(asset.symbol, 14)} ${padLeft(usdMillions(asset.turnover24h), 10)} ${padLeft(pct(asset.atr1mPct, 3), 8)} ${padLeft(`${asset.viabilityRatio.toFixed(2)}x`, 6)} ${padLeft(`${asset.viabilityAvg.toFixed(2)}x`, 7)} ${padLeft(asset.ker4h.toFixed(3), 7)} ${padLeft(asset.ker4hAvg.toFixed(3), 7)} ${padLeft(pct(asset.adrPct, 2), 7)}  ${fitLabel}${unstable ? ' (unstable)' : ''}`,
    );
  }

  console.log('─'.repeat(126));
  console.log(
    `Sniper-qualified: ${result.sniperTargets.length} | Tank-qualified: ${result.tankTargets.length} | Blacklisted: ${result.blacklist.length}`,
  );
  if (result.universe.skipped.length > 0) {
    console.log(
      `Skipped: ${result.universe.skipped.map((item) => `${item.symbol} (${item.reason})`).join(' | ')}`,
    );
  }
  console.log('═'.repeat(112));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let options: ScreenerOptions | null;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exit(1);
    return;
  }
  if (!options) {
    process.exit(0);
    return;
  }

  const startedAt = Date.now();
  const client = new PublicBybitClient(options.requestGapMs);

  console.log('▶ Fetching linear perpetual tickers...');
  const tickersResult = await client.get<{ list?: unknown }>('/v5/market/tickers', { category: 'linear' });
  const allTickers = parseTickers(tickersResult);
  console.log(`  ${allTickers.length} live linear instruments reported by Bybit`);

  const perpetuals = allTickers
    .filter((ticker) => ticker.symbol.endsWith('USDT'))
    .sort((left, right) => right.turnover24h.comparedTo(left.turnover24h));

  if (perpetuals.length === 0) {
    throw new Error('No USDT perpetuals returned by /v5/market/tickers — aborting.');
  }

  const universe = perpetuals.slice(0, options.universeSize);
  const universeSymbols = new Set(universe.map((ticker) => ticker.symbol));

  // The benchmark must be scored even when it falls outside the turnover window,
  // otherwise "NEAR's DNA" is a number nobody can compare against.
  let benchmarkTicker: Ticker | null = null;
  if (!universeSymbols.has(BENCHMARK_SYMBOL)) {
    benchmarkTicker = allTickers.find((ticker) => ticker.symbol === BENCHMARK_SYMBOL) ?? null;
    if (benchmarkTicker) {
      console.log(`  Benchmark ${BENCHMARK_SYMBOL} is outside the top ${options.universeSize} — scoring it separately`);
    }
  }

  console.log('');
  console.log(`▶ Scoring ${universe.length} symbols (${options.requestGapMs}ms gap between calls)...`);

  const assets: AssetDna[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (let index = 0; index < universe.length; index += 1) {
    const ticker = universe[index];
    const label = `[${String(index + 1).padStart(2, ' ')}/${universe.length}] ${ticker.symbol}`;

    try {
      const dna = await fetchDna(client, ticker, index + 1);
      if (!dna) {
        skipped.push({ symbol: ticker.symbol, reason: 'insufficient closed history (likely new listing)' });
        console.log(`${padRight(label, 26)} SKIP (insufficient history)`);
        continue;
      }
      assets.push(dna);
      console.log(
        `${padRight(label, 26)} ATR1m ${padLeft(pct(dna.atr1mPct), 7)} | via ${padLeft(`${dna.viabilityRatio.toFixed(2)}x`, 5)} | KER ${dna.ker4h.toFixed(3)} | ADR ${padLeft(pct(dna.adrPct, 2), 7)} | ${dna.fit}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ symbol: ticker.symbol, reason });
      console.warn(`${padRight(label, 26)} FAILED: ${reason}`);
    }
  }

  let benchmark: AssetDna | null = assets.find((asset) => asset.symbol === BENCHMARK_SYMBOL) ?? null;
  if (!benchmark) {
    const ticker = benchmarkTicker ?? allTickers.find((candidate) => candidate.symbol === BENCHMARK_SYMBOL) ?? null;
    if (ticker) {
      try {
        benchmark = await fetchDna(client, ticker, 0);
      } catch (error) {
        console.warn(`  Benchmark ${BENCHMARK_SYMBOL} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const sniperTargets = assets
    .filter((asset) => asset.sniperEligible)
    .sort((left, right) => right.viabilityRatio.comparedTo(left.viabilityRatio) || right.turnover24h.comparedTo(left.turnover24h));

  const tankTargets = assets
    .filter((asset) => asset.tankEligible)
    .sort((left, right) => right.ker4h.comparedTo(left.ker4h) || right.adrPct.comparedTo(left.adrPct));

  // Spread probe: every Sniper-qualified instrument, because a 1m edge is
  // measured against a cost that a wide book can silently multiply.
  const shortlist = sniperTargets.slice(0, 25);
  if (shortlist.length > 0) {
    console.log('');
    console.log(`▶ Probing orderbook spread for ${shortlist.length} Sniper finalists...`);
    for (const asset of shortlist) {
      try {
        asset.orderbook = await fetchOrderbook(client, asset.symbol, asset.atr1mPct, asset.atr1mPctAvg);
        if (asset.orderbook) {
          console.log(
            `${padRight(asset.symbol, 14)} spread ${padLeft(`${asset.orderbook.spreadBps.toFixed(1)} bps`, 8)} | effective cost ${pct(asset.orderbook.effectiveCostPct, 3)} | net viability ${asset.orderbook.netViability.toFixed(2)}x (16h ${asset.orderbook.netViabilityAvg.toFixed(2)}x)`,
          );
        } else {
          console.log(`${padRight(asset.symbol, 14)} orderbook unavailable`);
        }
      } catch (error) {
        console.warn(`${padRight(asset.symbol, 14)} spread probe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Re-rank with microstructure: an instrument whose spread eats its own ATR
  // advantage is not a Sniper candidate in practice. Ranking uses the 16h mean
  // so a single loud minute cannot outrank a stable regime. Unprobed assets fall
  // back to the fee-only ratio.
  sniperTargets.sort((left, right) => {
    const leftScore = left.orderbook?.netViabilityAvg ?? left.viabilityAvg;
    const rightScore = right.orderbook?.netViabilityAvg ?? right.viabilityAvg;
    return rightScore.comparedTo(leftScore) || right.viabilityRatio.comparedTo(left.viabilityRatio);
  });

  const blacklist = assets
    .filter((asset) => asset.fit === 'NONE')
    .sort((left, right) => left.viabilityRatio.comparedTo(right.viabilityRatio));

  const result: ScreenerResult = {
    generatedAt: new Date().toISOString(),
    source: 'Bybit V5 public REST (/v5/market/tickers, /v5/market/kline)',
    thresholds: {
      roundTripTakerFeePct: ROUND_TRIP_TAKER_FEE_PCT.toString(),
      sniperMinViabilityRatio: SNIPER_MIN_VIABILITY.toString(),
      sniperMinAtr1mPct: SNIPER_MIN_VIABILITY.mul(ROUND_TRIP_TAKER_FEE_PCT).toString(),
      sniperMinTurnoverUsd: SNIPER_MIN_TURNOVER_USD.toString(),
      tankMinKer4h: TANK_MIN_KER.toString(),
      tankMinAdrPct: TANK_MIN_ADR_PCT.toString(),
      tankMinTurnoverUsd: TANK_MIN_TURNOVER_USD.toString(),
      atrPeriod: String(ATR_PERIOD),
      kerPeriod: String(KER_PERIOD),
    },
    universe: {
      requested: options.universeSize,
      evaluated: assets.length,
      skipped,
      requests: client.requests,
      rateLimitHits: client.rateLimitHits,
    },
    benchmark,
    sniperTargets,
    tankTargets,
    blacklist,
    assets,
  };

  // Serialise Decimals as fixed-precision strings (never as JS numbers).
  const json = JSON.stringify(
    result,
    (_key, value: unknown) => {
      if (value instanceof Decimal) return value.toString();
      return value;
    },
    2,
  );

  const outputPath = resolve(process.cwd(), options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${json}\n`, 'utf-8');

  const reportPath = resolve(process.cwd(), options.reportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${buildMarkdown(result)}\n`, 'utf-8');

  printConsole(result);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`JSON   : ${options.outputPath}`);
  console.log(`Report : ${options.reportPath}`);
  console.log(`Elapsed: ${elapsed}s`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}

export { calculateAtr, calculateKer, dropFormingCandle, parseKlines, parseTickers };
