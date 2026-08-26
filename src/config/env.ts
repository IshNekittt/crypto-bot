import 'dotenv/config';

const MAX_KLINE_LIMIT = 1000;

export interface RiskConfig {
  readonly baseRiskPercent: string;
  readonly reducedRiskPercent: string;
}

export interface BotConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly testnet: boolean;
  readonly symbols: string[];
  readonly riskPercent: string;
  readonly reducedRiskPercent: string;
  readonly leverage: string;
  readonly dataDir: string;
  readonly historyCandles: number;
  readonly telegramBotToken: string | null;
  readonly telegramChatId: string | null;
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
  const symbols = [...new Set(
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0),
  )];
  if (symbols.length === 0) {
    throw new Error('SYMBOLS must contain at least one trading pair, e.g. SYMBOLS=SOLUSDT,BTCUSDT');
  }
  return symbols;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const riskPercent = requireEnv(env, 'RISK_PERCENT');
  parsePositiveNumber(riskPercent, 'RISK_PERCENT');

  const reducedRiskPercent = optionalEnv(env, 'REDUCED_RISK_PERCENT') ?? '1';
  parsePositiveNumber(reducedRiskPercent, 'REDUCED_RISK_PERCENT');

  if (Number(reducedRiskPercent) > Number(riskPercent)) {
    throw new Error('REDUCED_RISK_PERCENT must not exceed RISK_PERCENT');
  }

  const leverage = optionalEnv(env, 'LEVERAGE') ?? '10';
  parsePositiveNumber(leverage, 'LEVERAGE');

  const historyCandles = parsePositiveNumber(
    optionalEnv(env, 'HISTORY_CANDLES') ?? '200',
    'HISTORY_CANDLES',
  );
  if (!Number.isInteger(historyCandles)) {
    throw new Error(`HISTORY_CANDLES must be an integer, got: ${historyCandles}`);
  }
  if (historyCandles > MAX_KLINE_LIMIT) {
    throw new Error(`HISTORY_CANDLES must be <= ${MAX_KLINE_LIMIT} (Bybit kline limit)`);
  }

  return {
    apiKey: requireEnv(env, 'BYBIT_API_KEY'),
    apiSecret: requireEnv(env, 'BYBIT_API_SECRET'),
    testnet: (optionalEnv(env, 'TESTNET') ?? 'true').toLowerCase() !== 'false',
    symbols: parseSymbols(requireEnv(env, 'SYMBOLS')),
    riskPercent,
    reducedRiskPercent,
    leverage,
    dataDir: optionalEnv(env, 'DATA_DIR') ?? 'data',
    historyCandles,
    telegramBotToken: optionalEnv(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: optionalEnv(env, 'TELEGRAM_CHAT_ID'),
  };
}
