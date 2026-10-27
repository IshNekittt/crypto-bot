import { Decimal } from 'decimal.js';

/**
 * Delta-neutral funding backtester configuration.
 *
 * Defaults mirror `docs/DELTA_NEUTRAL_ARCHITECTURE.md` §11. The CLI layer can
 * override every value, and `DN_*` environment variables are honored so the
 * same config object can later be reused by the live engine without a fork.
 *
 * Scope note: Phase 1 is funding-only. There are deliberately no OHLC,
 * liquidation, portfolio-allocation or execution fields here.
 */

export const DN_DAY_MS = 24 * 60 * 60 * 1000;
export const DN_HOUR_MS = 60 * 60 * 1000;

/**
 * Default top-20 altcoin basket. Every entry is a USDT-margined linear perp
 * with a 1:1 spot pair on Bybit. The list is intentionally explicit rather
 * than derived from a live screener so a backtest is reproducible.
 */
export const DN_DEFAULT_BASKET: readonly string[] = [
  'XRPUSDT',
  'SOLUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'TRXUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'BCHUSDT',
  'LTCUSDT',
  'SUIUSDT',
  'NEARUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'TIAUSDT',
  'INJUSDT',
  'SEIUSDT',
  'WLDUSDT',
  'ATOMUSDT',
];

export interface DnConfig {
  /** Symbols to simulate. Uppercase `<BASE>USDT`. */
  readonly symbols: readonly string[];
  /** Backtest window length in days. */
  readonly days: number;

  // --- Screener / signal -------------------------------------------------
  /** Funding MA length in epochs (architecture allows 2–10; 3–5 recommended). */
  readonly maEpochs: number;
  /** Entry gate: `f_ma >= entryThreshold` (fraction per epoch, 0.0003 = 0.03%). */
  readonly entryThreshold: Decimal;
  /** Exit gate: `f_ma < exitThreshold` (hysteresis: must be below entry). */
  readonly exitThreshold: Decimal;
  /** Consecutive evaluations below `exitThreshold` required before exiting. */
  readonly exitConsecutiveEpochs: number;
  /** Consecutive realized negative epochs that can justify an economic exit. */
  readonly negativeStreakEpochs: number;
  /**
   * Economic loss threshold for early exits, as a fraction of notional. Early
   * exits require accrued funding + basis return to be below this value; a
   * negative value absorbs brief loss epochs. Also slack in §7.2's negative-
   * streak comparison: exit when exit cost > expected remaining carry + tolerance.
   * Defaults to 0 (no tolerated accrued carry/basis loss).
   */
  readonly exitLossTolerance: Decimal;

  // --- Lifecycle ---------------------------------------------------------
  readonly minHoldingEpochs: number;
  readonly maxHoldingEpochs: number;
  readonly minHoldingHours: number;
  readonly maxHoldingDays: number;
  /** Extra profit buffer used by the `k_min` calculation. */
  readonly profitBufferPct: Decimal;
  /** Epochs skipped after an exit before the symbol may re-enter. */
  readonly cooldownEpochs: number;

  // --- Costs -------------------------------------------------------------
  /** Spot taker fee, fraction of notional (0.001 = 0.10%). */
  readonly spotTakerFee: Decimal;
  /** Perp maker fee, fraction of notional (0.0002 = 0.02%). */
  readonly perpTakerFee: Decimal;
  /** Adverse slippage per side of the position, in bps (2 = 0.02% per side). */
  readonly slippageBps: number;
  /** Assumed perp premium over spot at entry (0.001 = 0.10%). */
  readonly basisEntryPct: Decimal;
  /** Assumed perp premium at exit; 0 models convergence. */
  readonly basisExitPct: Decimal;

  // --- Capital -----------------------------------------------------------
  /** Perp leverage used in `E_alloc = N0 × (1 + (P0/S0)/L + β)`. */
  readonly leverage: number;
  /** Cash/margin buffer β as a fraction of entry notional. */
  readonly marginBufferPct: Decimal;
  /** Starting equity per symbol. Each symbol compounds independently in Phase 1. */
  readonly initialEquity: Decimal;

  // --- Data --------------------------------------------------------------
  /** Cache directory. Default is `data/dn_cache` (user-facing Phase 1 path). */
  readonly cacheDir: string;
  /** Fallback interval used for gap detection when history is too short to infer. */
  readonly expectedIntervalHours: number;
  /** Cache freshness window; older caches are refreshed unless `--offline`. */
  readonly cacheTtlMs: number;
  /** Concurrent symbol fetches. Kept low to stay far below public rate limits. */
  readonly fetchConcurrency: number;
}

/** Mutable override bag: `Partial<DnConfig>` would preserve the readonly modifiers. */
export type DnConfigOverrides = {
  -readonly [K in keyof DnConfig]?: DnConfig[K];
};

export const DN_DEFAULT_CONFIG: DnConfig = {
  symbols: DN_DEFAULT_BASKET,
  days: 180,

  maEpochs: 3,
  entryThreshold: new Decimal('0.0003'),
  exitThreshold: new Decimal('0.00002'),
  exitConsecutiveEpochs: 2,
  negativeStreakEpochs: 3,
  exitLossTolerance: new Decimal(0),

  minHoldingEpochs: 3,
  maxHoldingEpochs: 90,
  minHoldingHours: 24,
  maxHoldingDays: 30,
  profitBufferPct: new Decimal('0.001'),
  cooldownEpochs: 3,

  spotTakerFee: new Decimal('0.001'),
  perpTakerFee: new Decimal('0.0002'),
  slippageBps: 2,
  basisEntryPct: new Decimal('0.001'),
  basisExitPct: new Decimal('0'),

  leverage: 3,
  marginBufferPct: new Decimal('0.05'),
  initialEquity: new Decimal('10000'),

  cacheDir: 'data/dn_cache',
  expectedIntervalHours: 8,
  cacheTtlMs: 60 * 60 * 1000,
  fetchConcurrency: 3,
};

function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envDecimal(name: string, fallback: Decimal): Decimal {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  try {
    return new Decimal(raw);
  } catch {
    throw new Error(`Invalid ${name}: "${raw}" is not a decimal number`);
  }
}

function envInt(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: "${raw}" is not an integer`);
  }
  return Number(raw);
}

function envNumber(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a number`);
  }
  return value;
}

function parseSymbols(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const symbols = raw
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  if (symbols.length === 0) {
    throw new Error('DN_SYMBOLS / --symbols must contain at least one symbol');
  }
  return [...new Set(symbols)];
}

/**
 * Build a validated config from defaults → `DN_*` environment → explicit
 * overrides. The CLI calls this with parsed flags last, so flags always win.
 */
export function buildDnConfig(overrides: DnConfigOverrides = {}): DnConfig {
  const envSymbols = parseSymbols(optionalEnv('DN_SYMBOLS'));

  const config: DnConfig = {
    ...DN_DEFAULT_CONFIG,
    symbols: envSymbols ?? DN_DEFAULT_CONFIG.symbols,
    days: envInt('DN_BACKTEST_DAYS', DN_DEFAULT_CONFIG.days),

    maEpochs: envInt('DN_FUNDING_MA_EPOCHS', DN_DEFAULT_CONFIG.maEpochs),
    entryThreshold: envDecimal('DN_MIN_FUNDING_RATE', DN_DEFAULT_CONFIG.entryThreshold),
    exitThreshold: envDecimal('DN_EXIT_FUNDING_RATE', DN_DEFAULT_CONFIG.exitThreshold),
    exitConsecutiveEpochs: envInt(
      'DN_EXIT_CONSECUTIVE_EPOCHS',
      DN_DEFAULT_CONFIG.exitConsecutiveEpochs,
    ),
    negativeStreakEpochs: envInt(
      'DN_NEGATIVE_STREAK_EPOCHS',
      DN_DEFAULT_CONFIG.negativeStreakEpochs,
    ),
    exitLossTolerance: envDecimal(
      'DN_EXIT_LOSS_TOLERANCE',
      DN_DEFAULT_CONFIG.exitLossTolerance,
    ),

    minHoldingEpochs: envInt('DN_MIN_HOLDING_EPOCHS', DN_DEFAULT_CONFIG.minHoldingEpochs),
    maxHoldingEpochs: envInt('DN_MAX_HOLDING_EPOCHS', DN_DEFAULT_CONFIG.maxHoldingEpochs),
    minHoldingHours: envInt('DN_MIN_HOLDING_HOURS', DN_DEFAULT_CONFIG.minHoldingHours),
    maxHoldingDays: envInt('DN_MAX_HOLDING_DAYS', DN_DEFAULT_CONFIG.maxHoldingDays),
    profitBufferPct: envDecimal(
      'DN_MIN_PROFIT_BUFFER_PCT',
      DN_DEFAULT_CONFIG.profitBufferPct,
    ),
    cooldownEpochs: envInt('DN_COOLDOWN_EPOCHS', DN_DEFAULT_CONFIG.cooldownEpochs),

    spotTakerFee: envDecimal('DN_SPOT_TAKER_FEE', DN_DEFAULT_CONFIG.spotTakerFee),
    perpTakerFee: envDecimal('DN_PERP_TAKER_FEE', DN_DEFAULT_CONFIG.perpTakerFee),
    slippageBps: envNumber('DN_SLIPPAGE_BASE_BPS', DN_DEFAULT_CONFIG.slippageBps),
    basisEntryPct: envDecimal('DN_BACKTEST_BASIS_PCT', DN_DEFAULT_CONFIG.basisEntryPct),
    basisExitPct: envDecimal(
      'DN_BASIS_EXIT_ASSUMPTION_PCT',
      DN_DEFAULT_CONFIG.basisExitPct,
    ),

    leverage: envInt('DN_PERP_LEVERAGE', DN_DEFAULT_CONFIG.leverage),
    marginBufferPct: envDecimal(
      'DN_MARGIN_BUFFER_PCT',
      DN_DEFAULT_CONFIG.marginBufferPct,
    ),
    initialEquity: envDecimal(
      'DN_BACKTEST_INITIAL_EQUITY',
      DN_DEFAULT_CONFIG.initialEquity,
    ),

    cacheDir: optionalEnv('DN_DATA_DIR') ?? DN_DEFAULT_CONFIG.cacheDir,
    expectedIntervalHours: envInt(
      'DN_BACKTEST_INTERVAL_HOURS',
      DN_DEFAULT_CONFIG.expectedIntervalHours,
    ),
    cacheTtlMs: envInt('DN_CACHE_TTL_MS', DN_DEFAULT_CONFIG.cacheTtlMs),
    fetchConcurrency: envInt(
      'DN_FETCH_CONCURRENCY',
      DN_DEFAULT_CONFIG.fetchConcurrency,
    ),

    ...overrides,
  };

  validateDnConfig(config);
  return config;
}

function assertIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

function assertDecimalInRange(
  name: string,
  value: Decimal,
  min: Decimal,
  max: Decimal,
  inclusiveMin = true,
  inclusiveMax = true,
): void {
  const belowMin = inclusiveMin ? value.lt(min) : value.lte(min);
  const aboveMax = inclusiveMax ? value.gt(max) : value.gte(max);
  if (belowMin || aboveMax) {
    throw new Error(
      `${name} must be in ${inclusiveMin ? '[' : '('}${min}, ${max}${inclusiveMax ? ']' : ')'}, got ${value.toString()}`,
    );
  }
}

export function validateDnConfig(config: DnConfig): void {
  if (config.symbols.length === 0) {
    throw new Error('DN_SYMBOLS must contain at least one symbol');
  }
  for (const symbol of config.symbols) {
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
      throw new Error(`Invalid symbol "${symbol}": expected an uppercase <BASE>USDT pair`);
    }
  }

  if (!Number.isInteger(config.days) || config.days <= 0) {
    throw new Error(`DN_BACKTEST_DAYS must be a positive integer, got ${config.days}`);
  }

  assertIntegerInRange('DN_FUNDING_MA_EPOCHS', config.maEpochs, 2, 10);

  if (!config.entryThreshold.gt(0)) {
    throw new Error(`DN_MIN_FUNDING_RATE must be > 0, got ${config.entryThreshold.toString()}`);
  }
  if (config.exitThreshold.lt(0)) {
    throw new Error(
      `DN_EXIT_FUNDING_RATE must be >= 0, got ${config.exitThreshold.toString()}`,
    );
  }
  if (!config.exitThreshold.lt(config.entryThreshold)) {
    throw new Error(
      `DN_EXIT_FUNDING_RATE (${config.exitThreshold.toString()}) must be < DN_MIN_FUNDING_RATE (${config.entryThreshold.toString()}) to preserve hysteresis`,
    );
  }

  assertIntegerInRange('DN_EXIT_CONSECUTIVE_EPOCHS', config.exitConsecutiveEpochs, 1, 100);
  assertIntegerInRange('DN_NEGATIVE_STREAK_EPOCHS', config.negativeStreakEpochs, 1, 100);
  assertDecimalInRange(
    'DN_EXIT_LOSS_TOLERANCE',
    config.exitLossTolerance,
    new Decimal('-0.1'),
    new Decimal('0.1'),
  );

  assertIntegerInRange('DN_MIN_HOLDING_EPOCHS', config.minHoldingEpochs, 1, 10_000);
  assertIntegerInRange('DN_MAX_HOLDING_EPOCHS', config.maxHoldingEpochs, 1, 10_000);
  if (config.minHoldingEpochs > config.maxHoldingEpochs) {
    throw new Error('DN_MIN_HOLDING_EPOCHS must be <= DN_MAX_HOLDING_EPOCHS');
  }
  assertIntegerInRange('DN_MIN_HOLDING_HOURS', config.minHoldingHours, 0, 100_000);
  assertIntegerInRange('DN_MAX_HOLDING_DAYS', config.maxHoldingDays, 1, 10_000);
  if (!config.profitBufferPct.gte(0)) {
    throw new Error('DN_MIN_PROFIT_BUFFER_PCT must be >= 0');
  }
  assertIntegerInRange('DN_COOLDOWN_EPOCHS', config.cooldownEpochs, 0, 10_000);

  assertDecimalInRange(
    'DN_SPOT_TAKER_FEE',
    config.spotTakerFee,
    new Decimal(0),
    new Decimal('0.01'),
  );
  assertDecimalInRange(
    'DN_PERP_TAKER_FEE',
    config.perpTakerFee,
    new Decimal(0),
    new Decimal('0.01'),
  );
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0 || config.slippageBps > 1_000) {
    throw new Error(`DN_SLIPPAGE_BASE_BPS must be in [0, 1000], got ${config.slippageBps}`);
  }

  assertDecimalInRange(
    'DN_BACKTEST_BASIS_PCT',
    config.basisEntryPct,
    new Decimal('-0.1'),
    new Decimal('0.1'),
  );
  assertDecimalInRange(
    'DN_BASIS_EXIT_ASSUMPTION_PCT',
    config.basisExitPct,
    new Decimal('-0.1'),
    new Decimal('0.1'),
  );

  assertIntegerInRange('DN_PERP_LEVERAGE', config.leverage, 1, 10);
  assertDecimalInRange(
    'DN_MARGIN_BUFFER_PCT',
    config.marginBufferPct,
    new Decimal(0),
    new Decimal('0.99'),
  );
  if (!config.initialEquity.gt(0)) {
    throw new Error('DN_BACKTEST_INITIAL_EQUITY must be > 0');
  }

  if (config.cacheDir.trim().length === 0) {
    throw new Error('DN_DATA_DIR / --cache-dir must not be empty');
  }
  assertIntegerInRange('DN_BACKTEST_INTERVAL_HOURS', config.expectedIntervalHours, 1, 24);
  if (!Number.isInteger(config.cacheTtlMs) || config.cacheTtlMs < 0) {
    throw new Error('DN_CACHE_TTL_MS must be a non-negative integer');
  }
  assertIntegerInRange('DN_FETCH_CONCURRENCY', config.fetchConcurrency, 1, 10);
}

/** Flat round-trip fee as a fraction of notional: `2 × (spot + perp)`. */
export function roundTripFeeFraction(config: DnConfig): Decimal {
  return config.spotTakerFee.plus(config.perpTakerFee).mul(2);
}

/** Round-trip slippage as a fraction of notional: `2 × bps`. */
export function roundTripSlippageFraction(config: DnConfig): Decimal {
  return new Decimal(config.slippageBps).mul(2).div(10_000);
}

/**
 * Fee drag exactly as architecture §8.4 describes, normalized by entry spot
 * notional. Price ratios use `S1/S0 = 1` (funding-only approximation):
 *
 *   r_fees = s_in + p_in(P0/S0) + s_out(S1/S0) + p_out(P1/S0)
 *          = s + p(1 + b0) + s + p(1 + b1)
 *
 * With the maker-optimized default perp fee and `b0 = 0.10%`, this is
 * 0.24002%: 0.24% base round trip plus the perp-leg basis adjustment.
 */
export function feeReturnFraction(config: DnConfig): Decimal {
  const entryPerpRatio = new Decimal(1).plus(config.basisEntryPct);
  const exitPerpRatio = new Decimal(1).plus(config.basisExitPct);
  return config.spotTakerFee
    .plus(config.perpTakerFee.mul(entryPerpRatio))
    .plus(config.spotTakerFee)
    .plus(config.perpTakerFee.mul(exitPerpRatio));
}

/** Basis PnL as a fraction of N0: `b0 − b1 × (S1/S0)` with `S1/S0 = 1`. */
export function basisReturnFraction(config: DnConfig): Decimal {
  return config.basisEntryPct.minus(config.basisExitPct);
}

/**
 * Allocated-equity denominator from §8.6:
 * `1 + (P0/S0)/L + β`, with `P0/S0 = 1 + b0`.
 */
export function equityDenominator(config: DnConfig): Decimal {
  const perpToSpot = new Decimal(1).plus(config.basisEntryPct);
  return new Decimal(1)
    .plus(perpToSpot.div(config.leverage))
    .plus(config.marginBufferPct);
}

/**
 * Economic time-lock from §7.1:
 *
 *   k_min = ceil((fee_round_trip + slippage_round_trip + profit_buffer) / f_ma)
 *
 * clamped to `[DN_MIN_HOLDING_EPOCHS, DN_MAX_HOLDING_EPOCHS]`. A wall-clock
 * minimum (`DN_MIN_HOLDING_HOURS`) is enforced separately by the simulator.
 */
export function computeKMin(entryMa: Decimal, config: DnConfig): number {
  if (!entryMa.gt(0)) return config.maxHoldingEpochs;

  const roundTripCost = roundTripFeeFraction(config)
    .plus(roundTripSlippageFraction(config))
    .plus(config.profitBufferPct);

  const raw = roundTripCost.div(entryMa).ceil().toNumber();
  if (!Number.isFinite(raw)) return config.maxHoldingEpochs;
  return Math.max(config.minHoldingEpochs, Math.min(raw, config.maxHoldingEpochs));
}
