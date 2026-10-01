import "dotenv/config";
import { Decimal } from "decimal.js";

export interface RiskConfig {
  readonly baseRiskPercent: string;
  readonly reducedRiskPercent: string;
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
  readonly fundingAlertThreshold: string;
  readonly fundingRestoreThreshold: string;
  readonly symbolScenarios: Map<string, number[]>;
  readonly backtestCsvPath: string | null;
  readonly cooldownCandles: number;
  readonly smcSlAtrOffset: string;
  readonly smcDisplacementMultiplier: string;
  readonly limitExpirationCandles: number;
  readonly smartEntryThresholdPct: string;
  readonly breakevenRrTrigger: number;
  readonly enableSniperMode: boolean;
  readonly sniperDisplacementMultiplier?: string;
  readonly backtestDays: number;
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
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  if (ids.length === 0) {
    throw new Error(
      "ACTIVE_SCENARIOS must contain valid scenario IDs (1-12), e.g. ACTIVE_SCENARIOS=3,4,5,7,8,9,12",
    );
  }
  return [...new Set(ids)].sort((a, b) => a - b);
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
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
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
  const fundingAlertThreshold = parseDecimalOrDefault(
    optionalEnv(env, "FUNDING_ALERT_THRESHOLD"),
    "0.0",
    "FUNDING_ALERT_THRESHOLD",
  );
  const fundingRestoreThreshold = parseDecimalOrDefault(
    optionalEnv(env, "FUNDING_RESTORE_THRESHOLD"),
    "0.0001",
    "FUNDING_RESTORE_THRESHOLD",
  );

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

  const smartEntryThresholdPctRaw = parseDecimalOrDefault(
    optionalEnv(env, "SMART_ENTRY_THRESHOLD_PCT"),
    "0.15", // 0.15%
    "SMART_ENTRY_THRESHOLD_PCT",
  );
  const smartEntryThresholdPct = new Decimal(smartEntryThresholdPctRaw)
    .div(100)
    .toFixed(10);

  const breakevenRrTrigger = parsePositiveNumber(
    optionalEnv(env, "BREAKEVEN_RR_TRIGGER") ?? "2",
    "BREAKEVEN_RR_TRIGGER",
  );
  if (!Number.isInteger(breakevenRrTrigger)) {
    throw new Error(
      `BREAKEVEN_RR_TRIGGER must be an integer, got: ${breakevenRrTrigger}`,
    );
  }

  const enableSniperMode =
    (optionalEnv(env, "ENABLE_SNIPER_MODE") ?? "false").toLowerCase() ===
    "true";

  const sniperDisplacementMultiplier = parseDecimalOrDefault(
    optionalEnv(env, "SNIPER_DISPLACEMENT_MULTIPLIER"),
    "1.5",
    "SNIPER_DISPLACEMENT_MULTIPLIER",
  );

  const backtestDays = parsePositiveNumber(
    optionalEnv(env, "BACKTEST_DAYS") ?? "60",
    "BACKTEST_DAYS",
  );
  if (!Number.isInteger(backtestDays)) {
    throw new Error(`BACKTEST_DAYS must be an integer, got: ${backtestDays}`);
  }

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
    fundingAlertThreshold,
    fundingRestoreThreshold,
    symbolScenarios,
    backtestCsvPath,
    smcSlAtrOffset,
    smcDisplacementMultiplier,
    limitExpirationCandles,
    smartEntryThresholdPct,
    breakevenRrTrigger,
    enableSniperMode,
    sniperDisplacementMultiplier,
    backtestDays,
  };
}
