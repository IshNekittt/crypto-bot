import "dotenv/config";
import { Decimal } from "decimal.js";

export interface RiskConfig {
  readonly baseRiskPercent: string;
  readonly reducedRiskPercent: string;
}

/**
 * Per-symbol calibration overrides (`<PARAM>_<SYMBOL>`, following the
 * `SCENARIOS_<SYMBOL>` precedent).
 *
 * Assets do not share a volatility regime, ATR or tick size, so a global value
 * that is calibrated for one symbol silently mis-calibrates every other one.
 * These overrides let a symbol be pinned to its own numbers without forking the
 * engine or contaminating the global defaults.
 *
 * Every field is optional. An absent key falls back to the global value with no
 * warning: "this asset has not been individually calibrated" is the normal state
 * of the system, not a configuration error. Only malformed values throw.
 *
 * Resolve through `resolveSymbolConfig()` — never read the map directly, or a
 * consumer will silently ignore calibration for every symbol.
 */
export interface SymbolOverrides {
  /** `DYNAMIC_TP_MIN_RR_<SYMBOL>` — structural target floor in R multiples. */
  readonly dynamicTpMinRr?: Decimal;
  /** `MIN_TP_DISTANCE_PCT_<SYMBOL>` — fee-aware target floor, fraction of price. */
  readonly minTpDistancePct?: Decimal;
  /** `MIN_NET_RR_<SYMBOL>` — fee-inclusive reward:risk floor. */
  readonly minNetRr?: Decimal;
  /** `MIN_VOLATILITY_FEE_RATIO_<SYMBOL>` — ATR-to-fee admission multiple. */
  readonly minVolatilityFeeRatio?: Decimal;
  /** `SMC_SWEEP_MIN_WICK_RATIO_<SYMBOL>` — sweep absorption floor, ratio in (0,1). */
  readonly smcSweepMinWickRatio?: Decimal;
  /** `SMC_SL_ATR_OFFSET_<SYMBOL>` — ATR multiple used to offset the stop. */
  readonly smcSlAtrOffset?: string;
  /** `SNIPER_LIMIT_EXPIRATION_CANDLES_<SYMBOL>` — limit lifetime in 1m candles. */
  readonly sniperLimitExpirationCandles?: number;
}

export interface BotConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly testnet: boolean;
  readonly demoTrading: boolean;
  readonly symbols: string[];
  readonly riskPercent: string;
  readonly reducedRiskPercent: string;
  readonly leverage: string;
  readonly dataDir: string;
  readonly historyCandles: number;
  readonly ltfTimeframe: string;
  readonly htfTimeframe: string;
  readonly macroCandles: number;
  readonly telegramBotToken: string | null;
  readonly telegramChatId: string | null;
  readonly databaseUrl: string | null;
  readonly autoTrading: boolean;
  readonly tradeApprovalTimeoutMinutes: number;
  readonly enableLiveTestOrders: boolean;
  readonly activeScenarios: number[];
  readonly enableFundingMonitor: boolean;
  readonly fundingMonitorSymbols: string[];
  readonly fundingAlertThresholdPct: string;
  readonly fundingRestoreThresholdPct: string;
  readonly symbolScenarios: Map<string, number[]>;
  /**
   * Per-symbol parameter overrides, keyed by the uppercased `SYMBOLS` entry.
   *
   * Only symbols with at least one `<PARAM>_<SYMBOL>` key present appear here,
   * so an empty map means "every symbol uses the global calibration". Declared
   * optional so hand-built `BotConfig` fixtures keep compiling. Consume via
   * `resolveSymbolConfig()`, which falls back to `config` unchanged when a symbol
   * has no entry.
   */
  readonly symbolOverrides?: ReadonlyMap<string, SymbolOverrides>;
  readonly backtestCsvPath: string | null;
  readonly cooldownCandles: number;
  readonly smcSlAtrOffset: string;
  readonly smcDisplacementMultiplier: string;
  readonly limitExpirationCandles: number;
  /**
   * Limit-order lifetime in Sniper Mode, counted in **1m execution candles**.
   *
   * The Classic knob (`limitExpirationCandles`) is measured in LTF candles, so the
   * same number means very different wall-clock lifetimes across modes: 6 candles
   * are 90 minutes on a 15m chart but only 6 minutes on the 1m Sniper chart, which
   * expired valid OB-midpoint pullbacks before they could complete. This knob keeps
   * the two modes independently tunable instead of silently inheriting the LTF
   * count. Resolve through `resolveLimitExpirationCandles()` / `resolveLimitExpirationMs()`.
   */
  readonly sniperLimitExpirationCandles: number;
  /**
   * Minimum share of the sweep candle's total range that its rejection wick must
   * cover for a level interaction to count as absorption (Scenario 12).
   *
   * Scenario 12 requires a *sweep* — wick through the macro level with a close back
   * inside it — and this ratio separates genuine absorption from a casual poke. It
   * is a ratio in `(0, 1)`, consumed as `Decimal` (Invariant 1).
   *
   * Calibration (measured, 60d 1m backtest, cache-reproducible): at `0.30` the gate
   * rejected 56.5% / 54.1% / 56.8% of every level touch on BTC / SOL / NEAR — past
   * the point where it removes absorption rather than noise. `0.25` keeps the
   * "rejection wick must be real" requirement while admitting the 25-30% SFPs that
   * high-liquidity majors routinely print: on those books a deep wick is absorbed
   * quickly, so an outsized wick is the exception, not the signature of defence.
   */
  readonly smcSweepMinWickRatio: Decimal;
  /**
   * Scenario 12 — opt-in intraday sweep sources (default `false`).
   *
   * With both flags off, the Sniper funnel reproduces the macro-only baseline
   * exactly (PDH/PDL/PWH/PWL). `s12SessionSweeps` adds the most recent Asian
   * session high/low, `s12EqhEqlSweeps` adds 15m EQH/EQL pools. Coincident
   * prices are deduplicated with macro priority: Macro > Session > EQH/EQL.
   *
   * Declared optional so hand-built `BotConfig` fixtures keep compiling; an
   * absent value is treated as `false` (baseline reproducibility).
   */
  readonly s12SessionSweeps?: boolean;
  readonly s12EqhEqlSweeps?: boolean;
  /**
   * Scenario 12 — minimum take-profit distance from entry, as a fraction of price
   * (default `0.0035` = 0.35%).
   *
   * Bybit charges ~0.11% round-trip taker fees, so a target closer than this hands
   * 30-45% of the gross move to the exchange: the trade is fee-dominated even when
   * it reaches TP. The gate runs on the resolved target, so it applies to both
   * structural and fixed-R targets. Values must lie in `(0, 0.1)`; a literal `10`
   * is almost certainly a percentage written without dividing by 100.
   */
  readonly minTpDistancePct: Decimal;
  readonly minNetRr: Decimal;
  readonly minVolatilityFeeRatio: Decimal;
  readonly smartEntryThresholdPct: string;
  readonly preflightBufferPct: string;
  readonly enableSniperMode: boolean;
  readonly sniperDisplacementMultiplier?: string;
  /**
   * Dynamic Take-Profit (see `src/engine/tpResolver.ts`).
   *
   * When `true`, scenarios derive the take-profit from market structure
   * (opposing liquidity pools, unmitigated HTF/LTF zones, range equilibrium)
   * instead of multiplying the stop distance by a constant.
   */
  readonly enableDynamicTp: boolean;
  /** Target multiple used when dynamic TP is disabled, and as the no-candidate fallback. */
  readonly fixedTpRr: Decimal;
  /** Nearest opposing target closer than this rejects the setup (no room to run). */
  readonly dynamicTpMinRr: Decimal;
  /** Hard ceiling on the resolved target, in R units. */
  readonly dynamicTpMaxRr: Decimal;
  /** When `true`, "no opposing target found" rejects instead of falling back to `fixedTpRr`. */
  readonly dynamicTpRequireTarget: boolean;
  readonly backtestDays: number;
  readonly maxWorkingCapital: number;
  readonly useLocalCacheOnly: boolean;
  readonly enableHealthcheckServer: boolean;
  readonly allowedDaysOfWeek: number[];
  readonly enforceKillzones: boolean;
  readonly enableTradeNotifications: boolean;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (!value || !value.trim()) return null;
  return value.trim();
}

function parsePositiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number, got: "${value}"`);
  }
  return parsed;
}

function parseSymbols(raw: string): string[] {
  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
    ),
  ];
  if (symbols.length === 0) {
    throw new Error(
      "SYMBOLS must contain at least one trading pair, e.g. SYMBOLS=SOLUSDT,BTCUSDT",
    );
  }
  return symbols;
}

function parseActiveScenarios(raw: string | null): number[] {
  if (!raw || !raw.trim()) return [];
  const ids = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && (n >= 1 && n <= 12 || n === 14 || n === 15));
  if (ids.length === 0) {
    throw new Error(
      "ACTIVE_SCENARIOS must contain valid scenario IDs (1-12, 14, or 15; 13 is archived), e.g. ACTIVE_SCENARIOS=15",
    );
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function parseAllowedDaysOfWeek(raw: string): number[] {
  const days = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (days.length === 0) {
    throw new Error(
      "ALLOWED_DAYS_OF_WEEK must contain ISO weekday numbers (1=Monday ... 7=Sunday), e.g. ALLOWED_DAYS_OF_WEEK=1,2,3,4,5",
    );
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function parseFundingSymbols(raw: string | null): string[] {
  if (!raw || !raw.trim()) return [];
  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
    ),
  ];
  return symbols;
}

function parseDecimalOrDefault(
  value: string | null,
  defaultValue: string,
  label: string,
): string {
  const raw = value ?? defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number, got: "${raw}"`);
  }
  return raw;
}

function parsePositiveNumberOrDefault(
  value: string | null,
  defaultValue: string,
  label: string,
): number {
  const raw = value ?? defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number, got: "${raw}"`);
  }
  return parsed;
}

/**
 * Parse a strictly positive ratio into a `Decimal` (used by the dynamic TP knobs).
 *
 * Ratios such as R:R multiples are consumed by `tpResolver` as `Decimal` and never
 * as `number`, so the config surface stays exact (Invariant 1). A value of `0` is
 * rejected here rather than downstream, where it would silently produce a
 * zero-width target.
 */
function parsePositiveDecimalOrDefault(
  value: string | null,
  defaultValue: string,
  label: string,
): Decimal {
  const raw = value ?? defaultValue;
  let parsed: Decimal;
  try {
    parsed = new Decimal(raw);
  } catch {
    throw new Error(`${label} must be a valid number, got: "${raw}"`);
  }
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new Error(`${label} must be a strictly positive number, got: "${raw}"`);
  }
  return parsed;
}

/**
 * Parse a proportional threshold (a share of a whole) into a `Decimal` in `(0, 1)`.
 *
 * A share of `0` would make the gate meaningless and a share of `1` (or more) would
 * require the wick to cover the entire candle range, so both are configuration
 * errors rather than clamped values. Input above 1 is a common mistake when the
 * value is written as a percentage (`25` instead of `0.25`), and failing loudly
 * surfaces that immediately instead of silently rejecting every setup.
 */
function parseRatioOrDefault(
  value: string | null,
  defaultValue: string,
  label: string,
): Decimal {
  const raw = value ?? defaultValue;
  let parsed: Decimal;
  try {
    parsed = new Decimal(raw);
  } catch {
    throw new Error(`${label} must be a valid number, got: "${raw}"`);
  }
  if (!parsed.isFinite() || parsed.lte(0) || parsed.gte(1)) {
    throw new Error(
      `${label} must be a ratio strictly between 0 and 1 (e.g. 0.25 for 25%), got: "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Effective limit-order lifetime in candles of the **execution** timeframe.
 *
 * Sniper Mode executes on 1m candles, Classic mode on the LTF, so the same candle
 * count means very different wall-clock lifetimes. Every consumer (live
 * reconciliation, backtest simulator) resolves through this single helper so the
 * two can never drift apart.
 *
 * Pass a symbol-resolved config (`resolveSymbolConfig(config, symbol)`) when the
 * caller knows which symbol it is acting on, so `SNIPER_LIMIT_EXPIRATION_CANDLES_<SYMBOL>`
 * is honoured.
 */
export function resolveLimitExpirationCandles(config: {
  enableSniperMode: boolean;
  limitExpirationCandles: number;
  sniperLimitExpirationCandles: number;
}): number {
  return config.enableSniperMode
    ? config.sniperLimitExpirationCandles
    : config.limitExpirationCandles;
}

/** Effective limit-order lifetime in milliseconds (see `resolveLimitExpirationCandles`). */
export function resolveLimitExpirationMs(config: {
  enableSniperMode: boolean;
  limitExpirationCandles: number;
  sniperLimitExpirationCandles: number;
  ltfTimeframe: string;
}): number {
  const executionTfMinutes = config.enableSniperMode
    ? 1
    : Number(config.ltfTimeframe);
  return (
    resolveLimitExpirationCandles(config) * executionTfMinutes * 60 * 1000
  );
}

/**
 * Return `config` with every per-symbol override for `symbol` applied.
 *
 * Single resolution point for asset-specific calibration: callers that evaluate
 * a specific symbol (the per-symbol `ScenarioRouter`, the backtest loop, the
 * reconciliation sweep) call this once and then consume the returned config
 * exactly as they consumed the global one. That keeps every scenario and the
 * `tpResolver` symbol-aware without threading a symbol through their signatures.
 *
 * A symbol with no overrides returns the **same object identity** — no
 * allocation, no behaviour change, so an uncalibrated deployment is byte-for-byte
 * the previous code path. Resolution is idempotent: resolving an already-resolved
 * config yields the same values.
 *
 * Note: only `DYNAMIC_TP_MIN_RR_<SYMBOL>` is overridable, not the max. `loadConfig`
 * therefore validates each symbol's floor against the global `DYNAMIC_TP_MAX_RR`
 * at parse time, so a symbol can never be configured with floor > ceiling.
 */
export function resolveSymbolConfig(config: BotConfig, symbol: string): BotConfig {
  const overrides = config.symbolOverrides?.get(symbol.trim().toUpperCase());
  if (!overrides) return config;

  return {
    ...config,
    dynamicTpMinRr: overrides.dynamicTpMinRr ?? config.dynamicTpMinRr,
    minTpDistancePct: overrides.minTpDistancePct ?? config.minTpDistancePct,
    minNetRr: overrides.minNetRr ?? config.minNetRr,
    minVolatilityFeeRatio:
      overrides.minVolatilityFeeRatio ?? config.minVolatilityFeeRatio,
    smcSweepMinWickRatio:
      overrides.smcSweepMinWickRatio ?? config.smcSweepMinWickRatio,
    smcSlAtrOffset: overrides.smcSlAtrOffset ?? config.smcSlAtrOffset,
    sniperLimitExpirationCandles:
      overrides.sniperLimitExpirationCandles ??
      config.sniperLimitExpirationCandles,
  };
}

function parseSymbolScenarios(
  env: NodeJS.ProcessEnv,
  symbols: string[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const symbol of symbols) {
    const key = `SCENARIOS_${symbol}`;
    const raw = env[key];
    if (raw && raw.trim()) {
      const ids = raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && (n >= 1 && n <= 12 || n === 14 || n === 15));
      if (ids.length > 0) {
        map.set(
          symbol,
          [...new Set(ids)].sort((a, b) => a - b),
        );
      }
    }
  }
  return map;
}

/**
 * Parse `<PARAM>_<SYMBOL>` overrides for every configured symbol.
 *
 * Iterates `symbols` (the parsed `SYMBOLS` list) rather than scanning the whole
 * environment, so a stray `..._OLDUSDT` key from a previous run cannot resurrect
 * calibration for a pair the bot no longer trades. Symbols with no keys are
 * omitted entirely — that is what makes the fallback silent.
 *
 * Errors name the full variable (`MIN_TP_DISTANCE_PCT_APTUSDT`), not the bare
 * parameter, so a typo in the suffix is obvious from the message.
 */
function parseSymbolOverrides(
  env: NodeJS.ProcessEnv,
  symbols: string[],
  globalMaxRr: Decimal,
): Map<string, SymbolOverrides> {
  const map = new Map<string, SymbolOverrides>();

  for (const symbol of symbols) {
    const overrides: {
      dynamicTpMinRr?: Decimal;
      minTpDistancePct?: Decimal;
      minNetRr?: Decimal;
      minVolatilityFeeRatio?: Decimal;
      smcSweepMinWickRatio?: Decimal;
      smcSlAtrOffset?: string;
      sniperLimitExpirationCandles?: number;
    } = {};
    let hasAny = false;

    const minRrKey = `DYNAMIC_TP_MIN_RR_${symbol}`;
    const minRrRaw = optionalEnv(env, minRrKey);
    if (minRrRaw !== null) {
      const parsed = parsePositiveDecimalOrDefault(minRrRaw, "1.5", minRrKey);
      // No per-symbol ceiling is supported, so a floor above the global ceiling
      // would make the resolver's bounds unsatisfiable at evaluation time.
      if (parsed.gt(globalMaxRr)) {
        throw new Error(
          `${minRrKey} (${parsed.toString()}) must be <= DYNAMIC_TP_MAX_RR (${globalMaxRr.toString()})`,
        );
      }
      overrides.dynamicTpMinRr = parsed;
      hasAny = true;
    }

    const minTpKey = `MIN_TP_DISTANCE_PCT_${symbol}`;
    const minTpRaw = optionalEnv(env, minTpKey);
    if (minTpRaw !== null) {
      const parsed = parsePositiveDecimalOrDefault(minTpRaw, "0.0035", minTpKey);
      if (parsed.gte(new Decimal("0.1"))) {
        throw new Error(
          `${minTpKey} must be < 0.1 (10%), got: ${parsed.toString()}`,
        );
      }
      overrides.minTpDistancePct = parsed;
      hasAny = true;
    }

    const minNetRrKey = `MIN_NET_RR_${symbol}`;
    const minNetRrRaw = optionalEnv(env, minNetRrKey);
    if (minNetRrRaw !== null) {
      overrides.minNetRr = parsePositiveDecimalOrDefault(minNetRrRaw, "1.0", minNetRrKey);
      hasAny = true;
    }

    const minVolatilityFeeRatioKey = `MIN_VOLATILITY_FEE_RATIO_${symbol}`;
    const minVolatilityFeeRatioRaw = optionalEnv(env, minVolatilityFeeRatioKey);
    if (minVolatilityFeeRatioRaw !== null) {
      overrides.minVolatilityFeeRatio = parsePositiveDecimalOrDefault(
        minVolatilityFeeRatioRaw,
        "1.0",
        minVolatilityFeeRatioKey,
      );
      hasAny = true;
    }

    const wickKey = `SMC_SWEEP_MIN_WICK_RATIO_${symbol}`;
    const wickRaw = optionalEnv(env, wickKey);
    if (wickRaw !== null) {
      overrides.smcSweepMinWickRatio = parseRatioOrDefault(wickRaw, "0.25", wickKey);
      hasAny = true;
    }

    const slKey = `SMC_SL_ATR_OFFSET_${symbol}`;
    const slRaw = optionalEnv(env, slKey);
    if (slRaw !== null) {
      overrides.smcSlAtrOffset = parseDecimalOrDefault(slRaw, "0.5", slKey);
      hasAny = true;
    }

    const expKey = `SNIPER_LIMIT_EXPIRATION_CANDLES_${symbol}`;
    const expRaw = optionalEnv(env, expKey);
    if (expRaw !== null) {
      const parsed = parsePositiveNumberOrDefault(expRaw, "15", expKey);
      if (!Number.isInteger(parsed)) {
        throw new Error(`${expKey} must be an integer, got: ${parsed}`);
      }
      overrides.sniperLimitExpirationCandles = parsed;
      hasAny = true;
    }

    if (hasAny) map.set(symbol, overrides);
  }

  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const riskPercent = requireEnv(env, "RISK_PERCENT");
  parsePositiveNumber(riskPercent, "RISK_PERCENT");

  const reducedRiskPercent = optionalEnv(env, "REDUCED_RISK_PERCENT") ?? "1";
  parsePositiveNumber(reducedRiskPercent, "REDUCED_RISK_PERCENT");

  if (Number(reducedRiskPercent) > Number(riskPercent)) {
    throw new Error("REDUCED_RISK_PERCENT must not exceed RISK_PERCENT");
  }

  const leverage = optionalEnv(env, "LEVERAGE") ?? "10";
  parsePositiveNumber(leverage, "LEVERAGE");

  const historyCandles = parsePositiveNumber(
    optionalEnv(env, "HISTORY_CANDLES") ?? "200",
    "HISTORY_CANDLES",
  );
  if (!Number.isInteger(historyCandles)) {
    throw new Error(
      `HISTORY_CANDLES must be an integer, got: ${historyCandles}`,
    );
  }
  if (historyCandles > 1000) {
    throw new Error("HISTORY_CANDLES must be <= 1000 (Bybit kline limit)");
  }

  const ltfTimeframe = optionalEnv(env, "LTF_TIMEFRAME") ?? "15";
  if (
    ![
      "1",
      "3",
      "5",
      "15",
      "30",
      "60",
      "120",
      "240",
      "360",
      "720",
      "D",
      "W",
      "M",
    ].includes(ltfTimeframe)
  ) {
    throw new Error(
      `LTF_TIMEFRAME must be a valid Bybit interval, got: ${ltfTimeframe}`,
    );
  }

  const htfTimeframe = optionalEnv(env, "HTF_TIMEFRAME") ?? "240";
  if (
    ![
      "1",
      "3",
      "5",
      "15",
      "30",
      "60",
      "120",
      "240",
      "360",
      "720",
      "D",
      "W",
      "M",
    ].includes(htfTimeframe)
  ) {
    throw new Error(
      `HTF_TIMEFRAME must be a valid Bybit interval, got: ${htfTimeframe}`,
    );
  }

  const macroCandles = parsePositiveNumber(
    optionalEnv(env, "MACRO_CANDLES") ?? "1000",
    "MACRO_CANDLES",
  );
  if (!Number.isInteger(macroCandles)) {
    throw new Error(`MACRO_CANDLES must be an integer, got: ${macroCandles}`);
  }
  if (macroCandles > 1000) {
    throw new Error("MACRO_CANDLES must be <= 1000 (Bybit kline limit)");
  }

  const demoTrading =
    (optionalEnv(env, "DEMO_TRADING") ?? "false").toLowerCase() === "true";
  const testnet = demoTrading
    ? false
    : (optionalEnv(env, "TESTNET") ?? "true").toLowerCase() !== "false";

  if (demoTrading && testnet) {
    throw new Error(
      "DEMO_TRADING and TESTNET cannot both be true. DEMO_TRADING forces TESTNET=false.",
    );
  }

  const enableFundingMonitor =
    (optionalEnv(env, "ENABLE_FUNDING_MONITOR") ?? "false").toLowerCase() ===
    "true";
  const fundingMonitorSymbols = parseFundingSymbols(
    optionalEnv(env, "FUNDING_MONITOR_SYMBOLS"),
  );
  const fundingAlertThresholdPctRaw = parseDecimalOrDefault(
    optionalEnv(env, "FUNDING_ALERT_THRESHOLD_PCT"),
    "0.0",
    "FUNDING_ALERT_THRESHOLD_PCT",
  );
  const fundingAlertThresholdPct = new Decimal(fundingAlertThresholdPctRaw)
    .div(100)
    .toFixed(10);

  const fundingRestoreThresholdPctRaw = parseDecimalOrDefault(
    optionalEnv(env, "FUNDING_RESTORE_THRESHOLD_PCT"),
    "0.015", // 0.015%
    "FUNDING_RESTORE_THRESHOLD_PCT",
  );
  const fundingRestoreThresholdPct = new Decimal(fundingRestoreThresholdPctRaw)
    .div(100)
    .toFixed(10);

  const symbols = parseSymbols(requireEnv(env, "SYMBOLS"));
  const symbolScenarios = parseSymbolScenarios(env, symbols);
  const backtestCsvPath = optionalEnv(env, "BACKTEST_CSV_PATH");

  const cooldownCandles = parsePositiveNumber(
    optionalEnv(env, "COOLDOWN_CANDLES") ?? "16",
    "COOLDOWN_CANDLES",
  );
  if (!Number.isInteger(cooldownCandles)) {
    throw new Error(
      `COOLDOWN_CANDLES must be an integer, got: ${cooldownCandles}`,
    );
  }

  const smcSlAtrOffset = parseDecimalOrDefault(
    optionalEnv(env, "SMC_SL_ATR_OFFSET"),
    "0.5",
    "SMC_SL_ATR_OFFSET",
  );

  const smcDisplacementMultiplier = parseDecimalOrDefault(
    optionalEnv(env, "SMC_DISPLACEMENT_MULTIPLIER"),
    "1.5",
    "SMC_DISPLACEMENT_MULTIPLIER",
  );

  // Scenario 12 sweep-absorption threshold. Ratio in (0, 1), see BotConfig.
  const smcSweepMinWickRatio = parseRatioOrDefault(
    optionalEnv(env, "SMC_SWEEP_MIN_WICK_RATIO"),
    "0.25",
    "SMC_SWEEP_MIN_WICK_RATIO",
  );

  // Scenario 12 opt-in sweep sources. Default false = macro-only baseline.
  const s12SessionSweeps =
    (optionalEnv(env, "S12_SESSION_SWEEPS") ?? "false").toLowerCase() === "true";
  const s12EqhEqlSweeps =
    (optionalEnv(env, "S12_EQH_EQL_SWEEPS") ?? "false").toLowerCase() === "true";

  // Scenario 12 fee-aware target floor. Strictly positive (enforced by the helper)
  // and below 10% — a larger value would reject every realistic target.
  const minTpDistancePct = parsePositiveDecimalOrDefault(
    optionalEnv(env, "MIN_TP_DISTANCE_PCT"),
    "0.0035",
    "MIN_TP_DISTANCE_PCT",
  );
  if (minTpDistancePct.gte(new Decimal("0.1"))) {
    throw new Error(
      `MIN_TP_DISTANCE_PCT must be < 0.1 (10%), got: ${minTpDistancePct.toString()}`,
    );
  }

  const minNetRr = parsePositiveDecimalOrDefault(
    optionalEnv(env, "MIN_NET_RR"),
    "1.0",
    "MIN_NET_RR",
  );
  const minVolatilityFeeRatio = parsePositiveDecimalOrDefault(
    optionalEnv(env, "MIN_VOLATILITY_FEE_RATIO"),
    "1.0",
    "MIN_VOLATILITY_FEE_RATIO",
  );

  const limitExpirationCandles = parsePositiveNumberOrDefault(
    optionalEnv(env, "LIMIT_EXPIRATION_CANDLES"),
    "6",
    "LIMIT_EXPIRATION_CANDLES",
  );
  if (!Number.isInteger(limitExpirationCandles)) {
    throw new Error(
      `LIMIT_EXPIRATION_CANDLES must be an integer, got: ${limitExpirationCandles}`,
    );
  }

  // Sniper Mode counts this in 1m candles, Classic mode in LTF candles (see BotConfig).
  const sniperLimitExpirationCandles = parsePositiveNumberOrDefault(
    optionalEnv(env, "SNIPER_LIMIT_EXPIRATION_CANDLES"),
    "15",
    "SNIPER_LIMIT_EXPIRATION_CANDLES",
  );
  if (!Number.isInteger(sniperLimitExpirationCandles)) {
    throw new Error(
      `SNIPER_LIMIT_EXPIRATION_CANDLES must be an integer, got: ${sniperLimitExpirationCandles}`,
    );
  }

  const preflightBufferPctRaw = parseDecimalOrDefault(
    optionalEnv(env, "PREFLIGHT_BUFFER_PCT"),
    "0.05", // 0.05%
    "PREFLIGHT_BUFFER_PCT",
  );
  const preflightBufferPct = new Decimal(preflightBufferPctRaw)
    .div(100)
    .toFixed(10);

  const smartEntryThresholdPctRaw = parseDecimalOrDefault(
    optionalEnv(env, "SMART_ENTRY_THRESHOLD_PCT"),
    "0.15", // 0.15%
    "SMART_ENTRY_THRESHOLD_PCT",
  );
  const smartEntryThresholdPct = new Decimal(smartEntryThresholdPctRaw)
    .div(100)
    .toFixed(10);

  const enableSniperMode =
    (optionalEnv(env, "ENABLE_SNIPER_MODE") ?? "false").toLowerCase() ===
    "true";

  const sniperDisplacementMultiplier = parseDecimalOrDefault(
    optionalEnv(env, "SNIPER_DISPLACEMENT_MULTIPLIER"),
    "1.5",
    "SNIPER_DISPLACEMENT_MULTIPLIER",
  );

  // === Dynamic Take-Profit ===
  // Structural targets replace the blind `k * R` constant. See tpResolver.ts.
  const enableDynamicTp =
    (optionalEnv(env, "ENABLE_DYNAMIC_TP") ?? "false").toLowerCase() === "true";

  const fixedTpRr = parsePositiveDecimalOrDefault(
    optionalEnv(env, "FIXED_TP_RR"),
    "3",
    "FIXED_TP_RR",
  );

  const dynamicTpMinRr = parsePositiveDecimalOrDefault(
    optionalEnv(env, "DYNAMIC_TP_MIN_RR"),
    "1.5",
    "DYNAMIC_TP_MIN_RR",
  );

  const dynamicTpMaxRr = parsePositiveDecimalOrDefault(
    optionalEnv(env, "DYNAMIC_TP_MAX_RR"),
    "6",
    "DYNAMIC_TP_MAX_RR",
  );

  if (dynamicTpMaxRr.lt(dynamicTpMinRr)) {
    throw new Error(
      `DYNAMIC_TP_MAX_RR (${dynamicTpMaxRr.toString()}) must be >= DYNAMIC_TP_MIN_RR (${dynamicTpMinRr.toString()})`,
    );
  }

  // Per-symbol calibration (`<PARAM>_<SYMBOL>`). Parsed after the globals so each
  // symbol's value can be validated against the global bounds it inherits.
  const symbolOverrides = parseSymbolOverrides(env, symbols, dynamicTpMaxRr);

  const dynamicTpRequireTarget =
    (optionalEnv(env, "DYNAMIC_TP_REQUIRE_TARGET") ?? "false").toLowerCase() ===
    "true";

  const backtestDays = parsePositiveNumber(
    optionalEnv(env, "BACKTEST_DAYS") ?? "60",
    "BACKTEST_DAYS",
  );
  if (!Number.isInteger(backtestDays)) {
    throw new Error(`BACKTEST_DAYS must be an integer, got: ${backtestDays}`);
  }

  const maxWorkingCapital = optionalEnv(env, "MAX_WORKING_CAPITAL")
    ? parsePositiveNumberOrDefault(optionalEnv(env, "MAX_WORKING_CAPITAL"), "0", "MAX_WORKING_CAPITAL")
    : 0;

  const useLocalCacheOnly = (optionalEnv(env, "USE_LOCAL_CACHE_ONLY") ?? "false").toLowerCase() === "true";

  const enableHealthcheckServer = (optionalEnv(env, "ENABLE_HEALTHCHECK_SERVER") ?? "false").toLowerCase() === "true";

  const allowedDaysOfWeek = parseAllowedDaysOfWeek(
    optionalEnv(env, "ALLOWED_DAYS_OF_WEEK") ?? "1,2,3,4,5",
  );

  const enforceKillzones =
    (optionalEnv(env, "ENFORCE_KILLZONES") ?? "true").toLowerCase() === "true";

  // Routine trade notifications (Setup Found / Order Opened / Position Closed).
  // Default true — set ENABLE_TRADE_NOTIFICATIONS=false to mute trade spam while
  // keeping all logger.error alerts flowing through the global Telegram hook.
  const enableTradeNotifications =
    (optionalEnv(env, "ENABLE_TRADE_NOTIFICATIONS") ?? "true").toLowerCase() ===
    "true";

  return {
    cooldownCandles,
    apiKey: requireEnv(env, "BYBIT_API_KEY"),
    apiSecret: requireEnv(env, "BYBIT_API_SECRET"),
    testnet,
    demoTrading,
    symbols,
    riskPercent,
    reducedRiskPercent,
    leverage,
    dataDir: optionalEnv(env, "DATA_DIR") ?? "data",
    historyCandles,
    ltfTimeframe,
    htfTimeframe,
    macroCandles,
    telegramBotToken: optionalEnv(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: optionalEnv(env, "TELEGRAM_CHAT_ID"),
    databaseUrl: optionalEnv(env, "DATABASE_URL"),
    autoTrading:
      (optionalEnv(env, "AUTO_TRADING") ?? "false").toLowerCase() === "true",
    tradeApprovalTimeoutMinutes: parseInt(
      optionalEnv(env, "TRADE_APPROVAL_TIMEOUT_MINUTES") ?? "5",
      10,
    ),
    enableLiveTestOrders:
      (optionalEnv(env, "ENABLE_LIVE_TEST_ORDERS") ?? "false").toLowerCase() ===
      "true",
    activeScenarios: parseActiveScenarios(optionalEnv(env, "ACTIVE_SCENARIOS")),
    enableFundingMonitor,
    fundingMonitorSymbols,
    fundingAlertThresholdPct,
    fundingRestoreThresholdPct,
    symbolScenarios,
    symbolOverrides,
    backtestCsvPath,
    smcSlAtrOffset,
    smcDisplacementMultiplier,
    smcSweepMinWickRatio,
    s12SessionSweeps,
    s12EqhEqlSweeps,
    minTpDistancePct,
    minNetRr,
    minVolatilityFeeRatio,
    limitExpirationCandles,
    sniperLimitExpirationCandles,
    smartEntryThresholdPct,
    preflightBufferPct,
    enableSniperMode,
    sniperDisplacementMultiplier,
    enableDynamicTp,
    fixedTpRr,
    dynamicTpMinRr,
    dynamicTpMaxRr,
    dynamicTpRequireTarget,
    backtestDays,
    maxWorkingCapital,
    useLocalCacheOnly,
    enableHealthcheckServer,
    allowedDaysOfWeek,
    enforceKillzones,
    enableTradeNotifications,
  };
}
