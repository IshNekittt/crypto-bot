#!/usr/bin/env node

/**
 * Horizontal Alpha Scaling — batch backtest matrix runner.
 *
 * Thin wrapper around the EXISTING backtest entrypoint (`src/backtest/run.ts`).
 * It never imports the simulator, never mutates strategy state and never touches
 * `.env` — it only spawns one child process per symbol and reads the artifacts
 * that `npm run backtest -- <SYMBOL>` already writes.
 *
 * Why one process per symbol:
 *   `run.ts` resolves instrument metadata for EVERY requested symbol before the
 *   simulation loop. A single dead ticker (delisted pair, typo, rate-limited
 *   metadata call) would therefore abort the whole multi-symbol run. Isolating
 *   each symbol keeps the batch alive and turns a hard failure into one row in
 *   the report.
 *
 * Metrics source (in priority order):
 *   1. `data/Backtest_Report_<SYMBOL>.txt` — written synchronously by the child
 *      right before it exits, so it is immune to truncated piped stdout.
 *   2. Captured stdout of the child — fallback when the artifact is missing or
 *      stale (e.g. a symbol that was skipped for insufficient candles).
 *
 * Usage:
 *   npm run matrix:test
 *   npm run matrix:test -- --symbols=BTCUSDT,ETHUSDT,SOLUSDT
 *   npx ts-node scripts/matrix_tester.ts --resume
 *   npx ts-node scripts/matrix_tester.ts --from-report
 *   npx ts-node scripts/matrix_tester.ts --npm --timeout=60
 *
 * Exit codes: 0 = report written (even if some symbols failed), 1 = fatal error.
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, resolve } from 'path';

// ---------------------------------------------------------------------------
// Defaults & thresholds
// ---------------------------------------------------------------------------

/**
 * Requested matrix universe — the four finalists selected by the 60-day screen
 * (NEAR, DOGE, APT) plus RENDERUSDT, the live successor of the delisted
 * RNDRUSDT perp. This is a 180-day deep-water run, so the universe is kept
 * deliberately small: each pair costs a full 1m history download (~260k
 * candles) plus a 259,200-candle simulation.
 *
 * `SYMBOLS` in `.env` MUST list the same four pairs — `parseSymbolOverrides()`
 * only builds the per-symbol calibration map for symbols present in `SYMBOLS`,
 * so a mismatch silently drops `MIN_NET_RR_NEARUSDT` / `MIN_VOLATILITY_FEE_RATIO_NEARUSDT`.
 */
const DEFAULT_SYMBOLS: readonly string[] = Object.freeze([
  'NEARUSDT',
  'DOGEUSDT',
  'APTUSDT',
  'RENDERUSDT',
]);

/** Screening gate requested by the Lead Architect. Strict inequalities. */
const THRESHOLDS = {
  minNetPct: new Decimal(10),
  maxDrawdownPct: new Decimal(10),
  minProfitFactor: new Decimal('1.5'),
} as const;

const DEFAULT_OUT_PATH = 'data/Matrix_Report.md';
const DEFAULT_STATE_PATH = 'data/matrix_state.json';
const DEFAULT_DATA_DIR = 'data';
const DEFAULT_LOG_DIR = 'data/matrix_logs';
const DEFAULT_TIMEOUT_MIN = 45;
const DEFAULT_GAP_MS = 5_000;
/** Keep the in-memory stdout tail bounded; the full log lives on disk. */
const MAX_TAIL_CHARS = 400_000;

/**
 * Env keys that change what a backtest measures. `--resume` refuses to reuse a
 * cached result when any of them differs, so a resumed run can never mix two
 * different strategies into one table.
 */
const SIGNATURE_ENV_KEYS = [
  'ACTIVE_SCENARIOS',
  'ENABLE_SNIPER_MODE',
  'BACKTEST_DAYS',
  'USE_LOCAL_CACHE_ONLY',
  'LTF_TIMEFRAME',
  'HTF_TIMEFRAME',
  'HISTORY_CANDLES',
  'ENABLE_DYNAMIC_TP',
  'DYNAMIC_TP_MIN_RR',
  'DYNAMIC_TP_MAX_RR',
  'MIN_NET_RR',
  'MIN_VOLATILITY_FEE_RATIO',
  'MIN_TP_DISTANCE_PCT',
  'S12_SESSION_SWEEPS',
  'S12_EQH_EQL_SWEEPS',
  'SMC_SL_ATR_OFFSET',
  'SMC_DISPLACEMENT_MULTIPLIER',
  'SMC_SWEEP_MIN_WICK_RATIO',
  'SNIPER_LIMIT_EXPIRATION_CANDLES',
  'SNIPER_DISPLACEMENT_MULTIPLIER',
  'SMART_ENTRY_THRESHOLD_PCT',
  'PREFLIGHT_BUFFER_PCT',
  'ENFORCE_KILLZONES',
  'ALLOWED_DAYS_OF_WEEK',
  'COOLDOWN_CANDLES',
  'RISK_PERCENT',
  'MAX_WORKING_CAPITAL',
] as const;

/** Report scenario names -> ids, so the table can prove which engine traded. */
const SCENARIO_NAME_TO_ID: Record<string, number> = {
  'HTF Continuation': 1,
  'HTF Liquidity Sweep': 5,
  'Sniper Touch (1m Macro)': 12,
  'Trend Following Alpha (Donchian / Volume Breakout)': 14,
  'Volatility Compression Squeeze (BB/KC)': 15,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatrixOptions {
  symbols: string[];
  outPath: string;
  statePath: string;
  dataDir: string;
  logDir: string;
  timeoutMs: number;
  gapMs: number;
  /** `true` = `npm run backtest -- SYMBOL` (recompiles each time). */
  npmMode: boolean;
  noBuild: boolean;
  resume: boolean;
  fromReport: boolean;
}

type FailureKind =
  | 'rate-limit'
  | 'insufficient-data'
  | 'invalid-symbol'
  | 'network'
  | 'timeout'
  | 'no-report'
  | 'spawn'
  | 'unknown';

interface SymbolFailure {
  kind: FailureKind;
  message: string;
}

/** Presentation-only metrics parsed from the text report. */
interface Metrics {
  initialBalance: Decimal;
  finalBalance: Decimal;
  netUsd: Decimal;
  netPct: Decimal;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: Decimal;
  /** Infinity is legal (no losing trades). */
  profitFactor: Decimal;
  maxDrawdownPct: Decimal;
  feesUsd: Decimal;
  periodStart: string | null;
  periodEnd: string | null;
  periodDays: number | null;
  scenarioIds: number[];
  scenarioNames: string[];
}

type Verdict = 'PASS' | 'NEAR' | 'FAIL' | 'NO_TRADES';

interface SymbolResult {
  symbol: string;
  status: 'ok' | 'error';
  metrics: Metrics | null;
  failure: SymbolFailure | null;
  durationMs: number;
  ranAtMs: number;
  resumed: boolean;
  reportPath: string;
  logPath: string;
  exitCode: number | null;
}

interface MatrixState {
  signature: string;
  updatedAt: string;
  runs: Record<string, { status: 'ok' | 'error'; ranAtMs: number }>;
}

interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  tail: string;
  logPath: string;
}

interface ReportContext {
  generatedAt: string;
  signature: string;
  results: SymbolResult[];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
Horizontal Alpha Scaling — batch backtest matrix

Usage: npm run matrix:test -- [options] [SYMBOL ...]

Options:
  --symbols=A,B,C     Symbol universe (default: the 15-pair S12 alt matrix)
  --out=<path>        Markdown report (default ${DEFAULT_OUT_PATH})
  --state=<path>      Resume state (default ${DEFAULT_STATE_PATH})
  --data-dir=<path>   Where Backtest_Report_<SYMBOL>.txt lives (default ${DEFAULT_DATA_DIR})
  --log-dir=<path>    Per-symbol child logs (default ${DEFAULT_LOG_DIR})
  --timeout=<min>     Per-symbol wall clock (default ${DEFAULT_TIMEOUT_MIN})
  --gap=<ms>          Pause between symbols (default ${DEFAULT_GAP_MS})
  --npm               Use "npm run backtest -- SYMBOL" instead of the built entrypoint
  --no-build          Skip the one-time "npm run build" (dist/ must be current)
  --resume            Reuse results already produced under the same config signature
  --from-report       Parse existing reports only; never spawn a backtest
  -h, --help          Show this help

Gate: Net PnL > ${THRESHOLDS.minNetPct.toString()}% AND Max DD < ${THRESHOLDS.maxDrawdownPct.toString()}% AND PF > ${THRESHOLDS.minProfitFactor.toString()}
`);
}

function parseOptions(argv: string[]): MatrixOptions | null {
  const options: MatrixOptions = {
    symbols: [...DEFAULT_SYMBOLS],
    outPath: DEFAULT_OUT_PATH,
    statePath: DEFAULT_STATE_PATH,
    dataDir: DEFAULT_DATA_DIR,
    logDir: DEFAULT_LOG_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MIN * 60_000,
    gapMs: DEFAULT_GAP_MS,
    npmMode: false,
    noBuild: false,
    resume: false,
    fromReport: false,
  };

  const positional: string[] = [];
  let explicitSymbols = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      printUsage();
      return null;
    }
    if (arg === '--npm') {
      options.npmMode = true;
      continue;
    }
    if (arg === '--no-build') {
      options.noBuild = true;
      continue;
    }
    if (arg === '--resume') {
      options.resume = true;
      continue;
    }
    if (arg === '--from-report') {
      options.fromReport = true;
      continue;
    }
    if (arg.startsWith('--symbols=')) {
      const list = parseSymbolList(arg.slice('--symbols='.length));
      options.symbols = list;
      explicitSymbols = true;
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.outPath = requireValue(arg, '--out');
      continue;
    }
    if (arg.startsWith('--state=')) {
      options.statePath = requireValue(arg, '--state');
      continue;
    }
    if (arg.startsWith('--data-dir=')) {
      options.dataDir = requireValue(arg, '--data-dir');
      continue;
    }
    if (arg.startsWith('--log-dir=')) {
      options.logDir = requireValue(arg, '--log-dir');
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      const minutes = Number(requireValue(arg, '--timeout'));
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`Invalid --timeout value: ${arg} (expected positive minutes)`);
      }
      options.timeoutMs = Math.round(minutes * 60_000);
      continue;
    }
    if (arg.startsWith('--gap=')) {
      const gap = Number(requireValue(arg, '--gap'));
      if (!Number.isFinite(gap) || gap < 0) {
        throw new Error(`Invalid --gap value: ${arg} (expected milliseconds >= 0)`);
      }
      options.gapMs = Math.round(gap);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    if (explicitSymbols) {
      throw new Error('Pass symbols either via --symbols=... or as positional args, not both.');
    }
    options.symbols = parseSymbolList(positional.join(','));
  }

  // De-duplicate while preserving order, so a typo in a list cannot run twice.
  options.symbols = [...new Set(options.symbols)];
  return options;
}

function requireValue(arg: string, flag: string): string {
  const value = arg.slice(`${flag}=`.length).trim();
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseSymbolList(raw: string): string[] {
  const symbols = raw
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);

  if (symbols.length === 0) throw new Error('Symbol list is empty.');

  for (const symbol of symbols) {
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
      throw new Error(`Invalid symbol "${symbol}" (expected e.g. BTCUSDT).`);
    }
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

function decimalFromMatch(block: string, pattern: RegExp): Decimal | null {
  const match = block.match(pattern);
  if (!match) return null;
  try {
    const value = new Decimal(match[1]);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

function intFromMatch(block: string, pattern: RegExp): number | null {
  const match = block.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

/**
 * Parses the text artifact produced by `generateReport()`. Returns null when the
 * block is absent or incomplete — a half-parsed row is worse than a failure,
 * because it would silently corrupt the screening table.
 */
export function parseReportMetrics(text: string, symbol: string): Metrics | null {
  const marker = `BACKTEST REPORT: ${symbol}`;
  const markerIndex = text.lastIndexOf(marker);
  const block = markerIndex >= 0 ? text.slice(markerIndex) : text;

  const netMatch = block.match(
    /Net Profit:\s+\$(-?\d+(?:\.\d+)?)\s+\((-?\d+(?:\.\d+)?)%\)/,
  );
  if (!netMatch) return null;

  const netUsd = new Decimal(netMatch[1]);
  const netPct = new Decimal(netMatch[2]);

  const trades = intFromMatch(block, /Total Trades:\s+(\d+)/);
  const wins = intFromMatch(block, /Wins:\s+(\d+)/);
  const losses = intFromMatch(block, /Losses:\s+(\d+)/);
  const winRatePct = decimalFromMatch(block, /Win Rate:\s+(-?\d+(?:\.\d+)?)%/);
  const maxDrawdownPct = decimalFromMatch(block, /Max Drawdown:\s+(-?\d+(?:\.\d+)?)%/);
  const feesUsd = decimalFromMatch(block, /Total Fees Paid:\s+\$(-?\d+(?:\.\d+)?)/);

  const pfMatch = block.match(/Profit Factor:\s+(∞|Infinity|-?\d+(?:\.\d+)?)/);
  const profitFactor = pfMatch
    ? pfMatch[1] === '∞' || pfMatch[1] === 'Infinity'
      ? new Decimal(Infinity)
      : new Decimal(pfMatch[1])
    : null;

  if (
    trades === null ||
    wins === null ||
    losses === null ||
    winRatePct === null ||
    maxDrawdownPct === null ||
    feesUsd === null ||
    profitFactor === null
  ) {
    return null;
  }

  const initialBalance =
    decimalFromMatch(block, /Initial Balance:\s+\$(-?\d+(?:\.\d+)?)/) ??
    new Decimal(1000);
  const finalBalance =
    decimalFromMatch(block, /Final Balance:\s+\$(-?\d+(?:\.\d+)?)/) ??
    initialBalance.plus(netUsd);

  const period = block.match(
    /Period:\s+(\d{4}-\d{2}-\d{2})\s+→\s+(\d{4}-\d{2}-\d{2})\s+\((\d+)\s+days\)/,
  );

  const scenarioIds: number[] = [];
  const scenarioNames: string[] = [];
  const scenarioSection = block.split('📋 SCENARIO BREAKDOWN')[1]?.split('═══')[0] ?? '';
  for (const line of scenarioSection.split('\n')) {
    if (!line.includes('│')) continue;
    const name = line.split('│')[0].trim();
    if (!name || name.startsWith('Scenario') || name.startsWith('─')) continue;
    scenarioNames.push(name);
    const id = SCENARIO_NAME_TO_ID[name];
    if (id !== undefined && !scenarioIds.includes(id)) scenarioIds.push(id);
  }
  scenarioIds.sort((left, right) => left - right);

  return {
    initialBalance,
    finalBalance,
    netUsd,
    netPct,
    trades,
    wins,
    losses,
    winRatePct,
    profitFactor,
    maxDrawdownPct,
    feesUsd,
    periodStart: period?.[1] ?? null,
    periodEnd: period?.[2] ?? null,
    periodDays: period ? Number(period[3]) : null,
    scenarioIds,
    scenarioNames,
  };
}

// ---------------------------------------------------------------------------
// Child process execution
// ---------------------------------------------------------------------------

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runChild(
  command: string,
  args: string[],
  options: { timeoutMs: number; logPath: string; shell?: boolean },
): Promise<RunOutcome> {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const logStream = createWriteStream(options.logPath, { flags: 'w' });
  // A failing log sink must never take the batch down: stdout capture still
  // works and the run itself does not depend on the artifact.
  logStream.on('error', (error) => {
    console.warn(`[matrix] log stream error (${options.logPath}): ${error.message}`);
  });

  return new Promise<RunOutcome>((done) => {
    const startedAt = Date.now();
    let tail = '';
    let timedOut = false;
    let spawnError: Error | null = null;

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? false,
    });

    const append = (chunk: Buffer): void => {
      logStream.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-MAX_TAIL_CHARS);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    child.on('error', (error) => {
      spawnError = error;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL: the child has no cleanup that matters (cache writes are
      // synchronous and a corrupted cache file is re-fetched on the next run).
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const finish = (): void => {
        done({
          code,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
          tail: spawnError
            ? `${tail}\n[matrix] spawn error: ${spawnError.message}`
            : tail,
          logPath: options.logPath,
        });
      };
      // Flush the log before the caller reads it / reports the path.
      logStream.end(finish);
    });
  });
}

function isFresh(filePath: string, startedAtMs: number): boolean {
  if (!existsSync(filePath)) return false;
  try {
    // 5s of clock tolerance: mtime is set by the child, not by this process.
    return statSync(filePath).mtimeMs >= startedAtMs - 5_000;
  } catch {
    return false;
  }
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function extractErrorLine(tail: string): string {
  const fatal = tail.match(/Backtest fatal error:\s*(.+)/);
  if (fatal) return fatal[1].trim();

  // Loader-level skip markers are warnings, not errors — surface them before
  // falling through to a generic "Backtest completed!" last line.
  const skip = tail.match(/(?:Missing required candle data|No candles fetched)[^\n]*/);
  if (skip) return skip[0].trim();

  const errorLines = tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\[ERROR\]|Error:|error:/i.test(line));
  if (errorLines.length > 0) return errorLines[errorLines.length - 1];

  const warnLines = tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\[WARN\]/.test(line));
  if (warnLines.length > 0) return warnLines[warnLines.length - 1];

  return lastNonEmptyLine(tail);
}

function classifyFailure(tail: string, exitCode: number | null, timedOut: boolean): SymbolFailure {
  const message = extractErrorLine(tail).slice(0, 400) || `child exited with code ${exitCode}`;

  if (timedOut) {
    return { kind: 'timeout', message: `Timed out before completion: ${message}` };
  }
  if (/\b(429|10016)\b|Too many visits|rate limit/i.test(tail)) {
    return { kind: 'rate-limit', message };
  }
  if (
    /Missing required candle data|OFFLINE MODE|No candles fetched|insufficient (?:closed )?history/i.test(
      tail,
    )
  ) {
    return { kind: 'insufficient-data', message };
  }
  if (
    /not found in Bybit|Instruments info failed|Invalid symbol|symbol .* not .*exist/i.test(tail)
  ) {
    return { kind: 'invalid-symbol', message };
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(tail)) {
    return { kind: 'network', message };
  }
  if (/Cannot find module|ENOENT/.test(tail)) {
    return { kind: 'spawn', message };
  }
  return { kind: 'unknown', message };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function buildSignature(symbols: string[]): string {
  const parts: Record<string, string> = { SYMBOLS: symbols.join(',') };

  for (const key of SIGNATURE_ENV_KEYS) {
    parts[key] = process.env[key] ?? '(default)';
  }
  // Per-symbol overrides (`MIN_NET_RR_NEARUSDT`, `SMC_SL_ATR_OFFSET_APTUSDT`, ...)
  for (const key of Object.keys(process.env).sort()) {
    if (symbols.some((symbol) => key.endsWith(`_${symbol}`))) {
      parts[key] = process.env[key] ?? '';
    }
  }

  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function loadState(statePath: string): MatrixState | null {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as MatrixState;
  } catch {
    return null;
  }
}

function saveState(statePath: string, state: MatrixState): void {
  const absolute = resolve(statePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tempPath, absolute);
}

function warnOnConfigDrift(): void {
  const scenarios = (process.env.ACTIVE_SCENARIOS ?? '').trim();
  const sniper = (process.env.ENABLE_SNIPER_MODE ?? 'false').toLowerCase() === 'true';
  const ids = scenarios
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (ids.includes('12') && !sniper) {
    console.warn(
      '⚠️  ACTIVE_SCENARIOS includes 12 but ENABLE_SNIPER_MODE=false — ' +
        'loadConfig() aborts on this combination.',
    );
  }
  if (ids.length === 0) {
    console.warn('⚠️  ACTIVE_SCENARIOS is empty — the backtest will use its default registry.');
  }
}

async function runBuild(): Promise<void> {
  console.log('▶ Building once (npm run build) so every symbol runs the same dist/ …');
  const outcome = await runChild(npmCommand(), ['run', 'build'], {
    timeoutMs: 5 * 60_000,
    logPath: resolve(DEFAULT_LOG_DIR, '_build.log'),
    shell: process.platform === 'win32',
  });

  if (outcome.code !== 0) {
    throw new Error(
      `Build failed (exit ${outcome.code}). See ${outcome.logPath}\n${outcome.tail.slice(-4000)}`,
    );
  }
  console.log('  build OK');
}

async function runSymbol(symbol: string, options: MatrixOptions): Promise<SymbolResult> {
  const reportPath = resolve(options.dataDir, `Backtest_Report_${symbol}.txt`);
  const logPath = resolve(options.logDir, `${symbol}.log`);
  const startedAt = Date.now();

  const command = options.npmMode ? npmCommand() : process.execPath;
  const args = options.npmMode
    ? ['run', 'backtest', '--', symbol]
    : [resolve('dist/backtest/run.js'), symbol];

  console.log(
    `▶ ${symbol} — ${options.npmMode ? 'npm run backtest' : 'node dist/backtest/run.js'} ${symbol}`,
  );

  const outcome = await runChild(command, args, {
    timeoutMs: options.timeoutMs,
    logPath,
    shell: options.npmMode && process.platform === 'win32',
  });

  // Prefer the artifact: `run.ts` calls process.exit(0) right after writing it,
  // and piped stdout can be truncated by that exit.
  const freshReport = isFresh(reportPath, startedAt);
  const reportText = freshReport ? readText(reportPath) : '';
  const metrics =
    parseReportMetrics(reportText, symbol) ?? parseReportMetrics(outcome.tail, symbol);

  if (metrics) {
    return {
      symbol,
      status: 'ok',
      metrics,
      failure: null,
      durationMs: outcome.durationMs,
      ranAtMs: Date.now(),
      resumed: false,
      reportPath,
      logPath,
      exitCode: outcome.code,
    };
  }

  // A child can exit 0 without writing a report (e.g. a delisted symbol that the
  // loader skips). Classify its log first — only a genuinely silent success is
  // reported as `no-report`.
  const failure = classifyFailure(outcome.tail, outcome.code, outcome.timedOut);

  if (failure.kind === 'unknown' && outcome.code === 0 && !outcome.timedOut) {
    failure.kind = 'no-report';
    failure.message =
      'Child exited successfully but produced no parseable report ' +
      '(insufficient candles or symbol skipped — see log).';
  }

  return {
    symbol,
    status: 'error',
    metrics: null,
    failure,
    durationMs: outcome.durationMs,
    ranAtMs: Date.now(),
    resumed: false,
    reportPath,
    logPath,
    exitCode: outcome.code,
  };
}

async function runFromReport(symbol: string, options: MatrixOptions): Promise<SymbolResult> {
  const reportPath = resolve(options.dataDir, `Backtest_Report_${symbol}.txt`);
  const logPath = resolve(options.logDir, `${symbol}.log`);
  const text = readText(reportPath);
  const metrics = text ? parseReportMetrics(text, symbol) : null;

  if (metrics) {
    return {
      symbol,
      status: 'ok',
      metrics,
      failure: null,
      durationMs: 0,
      ranAtMs: existsSync(reportPath) ? statSync(reportPath).mtimeMs : Date.now(),
      resumed: true,
      reportPath,
      logPath,
      exitCode: null,
    };
  }

  // No report: use the child log (if it exists) so a skipped/delisted symbol is
  // reported by cause rather than as an unexplained missing artifact.
  const logText = readText(logPath);
  const classified = logText ? classifyFailure(logText, 0, false) : null;
  const failure: SymbolFailure =
    classified && classified.kind !== 'unknown'
      ? classified
      : {
          kind: 'no-report',
          message: `No parseable report at ${reportPath}. Run the matrix first.`,
        };

  return {
    symbol,
    status: 'error',
    metrics: null,
    failure,
    durationMs: 0,
    ranAtMs: Date.now(),
    resumed: true,
    reportPath,
    logPath,
    exitCode: null,
  };
}

function tryResume(
  symbol: string,
  options: MatrixOptions,
  state: MatrixState | null,
  signature: string,
): SymbolResult | null {
  if (!state || state.signature !== signature) return null;
  const entry = state.runs[symbol];
  if (!entry || entry.status !== 'ok') return null;

  const reportPath = resolve(options.dataDir, `Backtest_Report_${symbol}.txt`);
  if (!isFresh(reportPath, entry.ranAtMs)) return null;

  const metrics = parseReportMetrics(readText(reportPath), symbol);
  if (!metrics) return null;

  return {
    symbol,
    status: 'ok',
    metrics,
    failure: null,
    durationMs: 0,
    ranAtMs: entry.ranAtMs,
    resumed: true,
    reportPath,
    logPath: resolve(options.logDir, `${symbol}.log`),
    exitCode: null,
  };
}

// ---------------------------------------------------------------------------
// Formatting & reporting
// ---------------------------------------------------------------------------

function signedPct(value: Decimal): string {
  return `${value.gte(0) ? '+' : ''}${value.toFixed(2)}%`;
}

function signedUsd(value: Decimal): string {
  return `${value.gte(0) ? '+' : '-'}$${value.abs().toFixed(2)}`;
}

function formatProfitFactor(value: Decimal): string {
  return value.isFinite() ? value.toFixed(2) : '∞';
}

function recoveryFactor(metrics: Metrics): Decimal | null {
  if (metrics.maxDrawdownPct.lte(0)) return null;
  return metrics.netPct.div(metrics.maxDrawdownPct);
}

function formatRecovery(metrics: Metrics): string {
  const value = recoveryFactor(metrics);
  if (value === null) return metrics.netPct.gt(0) ? '∞' : '—';
  return value.toFixed(2);
}

export function classifyVerdict(metrics: Metrics): Verdict {
  if (metrics.trades === 0) return 'NO_TRADES';

  const passNet = metrics.netPct.gt(THRESHOLDS.minNetPct);
  const passDrawdown = metrics.maxDrawdownPct.lt(THRESHOLDS.maxDrawdownPct);
  const passProfitFactor = metrics.profitFactor.gt(THRESHOLDS.minProfitFactor);

  if (passNet && passDrawdown && passProfitFactor) return 'PASS';

  const passedGates = [passNet, passDrawdown, passProfitFactor].filter(Boolean).length;
  if (passedGates >= 2 && metrics.netPct.gt(0)) return 'NEAR';
  return 'FAIL';
}

function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case 'PASS':
      return '🏆 PASS';
    case 'NEAR':
      return '🟡 NEAR';
    case 'NO_TRADES':
      return '⚠️ NO TRADES';
    default:
      return '· FAIL';
  }
}

function envValue(key: string, fallback = '(default)'): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function tableHeader(): string[] {
  return [
    '#',
    'Symbol',
    'Net PnL %',
    'Net $',
    'Trades',
    'W/L',
    'Win %',
    'PF',
    'Max DD %',
    'Fees $',
    'Net/DD',
    'Scenarios',
    'Verdict',
  ];
}

function tableRow(index: number, result: SymbolResult): string {
  const metrics = result.metrics;
  if (!metrics) return '';

  return [
    String(index),
    `**${result.symbol}**`,
    signedPct(metrics.netPct),
    signedUsd(metrics.netUsd),
    String(metrics.trades),
    `${metrics.wins}/${metrics.losses}`,
    `${metrics.winRatePct.toFixed(2)}%`,
    formatProfitFactor(metrics.profitFactor),
    `${metrics.maxDrawdownPct.toFixed(2)}%`,
    `$${metrics.feesUsd.toFixed(2)}`,
    formatRecovery(metrics),
    metrics.scenarioIds.length > 0 ? metrics.scenarioIds.join(', ') : '—',
    verdictLabel(classifyVerdict(metrics)),
  ].join(' | ');
}

function markdownTable(rows: string[]): string[] {
  return [
    `| ${tableHeader().join(' | ')} |`,
    `| ${tableHeader().map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row} |`),
  ];
}

function okResults(results: SymbolResult[]): Array<SymbolResult & { metrics: Metrics }> {
  return results
    .filter((result): result is SymbolResult & { metrics: Metrics } => result.status === 'ok' && result.metrics !== null)
    .sort((left, right) => right.metrics.netPct.comparedTo(left.metrics.netPct));
}

function buildMarkdown(context: ReportContext): string {
  const { results } = context;
  const ok = okResults(results);
  const failed = results.filter((result) => result.status === 'error');
  const passed = ok.filter((result) => classifyVerdict(result.metrics) === 'PASS');
  const near = ok.filter((result) => classifyVerdict(result.metrics) === 'NEAR');

  const lines: string[] = [];
  const periodStart = ok.find((result) => result.metrics.periodStart)?.metrics.periodStart ?? 'n/a';
  const periodEnd = ok.find((result) => result.metrics.periodEnd)?.metrics.periodEnd ?? 'n/a';
  const periodDays = ok.find((result) => result.metrics.periodDays)?.metrics.periodDays ?? null;
  const sniperOn = envValue('ENABLE_SNIPER_MODE', 'false').toLowerCase() === 'true';

  lines.push('# 📈 Horizontal Alpha Scaling — Batch Backtest Matrix');
  lines.push('');
  lines.push(`**Generated:** ${context.generatedAt}`);
  lines.push(
    `**Engine:** \`ACTIVE_SCENARIOS=${envValue('ACTIVE_SCENARIOS')}\` · Sniper Mode **${sniperOn ? 'ON' : 'OFF'}**`,
  );
  lines.push(
    `**Window:** \`BACKTEST_DAYS=${envValue('BACKTEST_DAYS')}\` · ${periodStart} → ${periodEnd}` +
      (periodDays === null ? '' : ` (${periodDays} days)`),
  );
  lines.push(
    `**Data:** Bybit V5 linear perpetuals · \`USE_LOCAL_CACHE_ONLY=${envValue('USE_LOCAL_CACHE_ONLY')}\` · $1,000 initial balance per symbol`,
  );
  lines.push(
    `**Entry filters:** killzones **${envValue('ENFORCE_KILLZONES', 'true') === 'false' ? 'bypassed' : 'enforced'}** · weekdays \`${envValue('ALLOWED_DAYS_OF_WEEK', '1,2,3,4,5')}\``,
  );
  lines.push(
    sniperOn
      ? `**Execution profile:** \`MIN_NET_RR=${envValue('MIN_NET_RR')}\` · \`MIN_VOLATILITY_FEE_RATIO=${envValue('MIN_VOLATILITY_FEE_RATIO')}\` · ` +
          `\`MIN_TP_DISTANCE_PCT=${envValue('MIN_TP_DISTANCE_PCT')}\` · \`SNIPER_LIMIT_EXPIRATION_CANDLES=${envValue('SNIPER_LIMIT_EXPIRATION_CANDLES')}\``
      : `**Execution profile:** \`LIMIT_EXPIRATION_CANDLES=${envValue('LIMIT_EXPIRATION_CANDLES')}\` · ` +
          `\`SMC_SL_ATR_OFFSET=${envValue('SMC_SL_ATR_OFFSET')}\` · \`SMC_DISPLACEMENT_MULTIPLIER=${envValue('SMC_DISPLACEMENT_MULTIPLIER')}\` · ` +
          `\`SMC_SWEEP_VOLUME_MULTIPLIER=${envValue('SMC_SWEEP_VOLUME_MULTIPLIER')}\``,
  );
  lines.push(`**Run signature:** \`${context.signature}\``);
  lines.push('');

  lines.push('## 🎯 Screening Gate');
  lines.push('');
  lines.push(
    `A symbol is an **Alpha Target** only when all three gates hold: Net PnL **> +${THRESHOLDS.minNetPct.toFixed(2)}%**, ` +
      `Max DD **< ${THRESHOLDS.maxDrawdownPct.toFixed(2)}%**, Profit Factor **> ${THRESHOLDS.minProfitFactor.toFixed(2)}**.`,
  );
  lines.push('');
  lines.push(`**Result: ${passed.length} of ${ok.length} evaluated symbols cleared the gate.**`);
  lines.push('');

  if (passed.length === 0) {
    lines.push('_No symbol cleared all three gates in this run._');
  } else {
    lines.push(...markdownTable(passed.map((result, index) => tableRow(index + 1, result))));
  }
  lines.push('');

  if (near.length > 0) {
    lines.push('### 🟡 Near Misses (2 of 3 gates, profitable)');
    lines.push('');
    lines.push(...markdownTable(near.map((result, index) => tableRow(index + 1, result))));
    lines.push('');
  }

  lines.push('## 📊 Full Matrix');
  lines.push('');
  lines.push('Sorted by Net PnL (descending). `Net/DD` = Net PnL % ÷ Max DD % (recovery factor).');
  lines.push('');
  if (ok.length === 0) {
    lines.push('_No symbol produced a parseable report._');
  } else {
    lines.push(...markdownTable(ok.map((result, index) => tableRow(index + 1, result))));
  }
  lines.push('');

  lines.push('## ❌ Failed / Skipped');
  lines.push('');
  if (failed.length === 0) {
    lines.push('_Every symbol completed._');
  } else {
    lines.push('| Symbol | Kind | Reason | Log |');
    lines.push('| --- | --- | --- | --- |');
    for (const result of failed) {
      const reason = (result.failure?.message ?? 'Unknown failure')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      lines.push(
        `| ${result.symbol} | \`${result.failure?.kind ?? 'unknown'}\` | ${reason} | \`${result.logPath}\` |`,
      );
    }
  }
  lines.push('');

  lines.push('## 🧮 Portfolio Aggregate');
  lines.push('');
  if (ok.length === 0) {
    lines.push('_Nothing to aggregate._');
  } else {
    const totalInitial = ok.reduce((sum, result) => sum.plus(result.metrics.initialBalance), new Decimal(0));
    const totalNet = ok.reduce((sum, result) => sum.plus(result.metrics.netUsd), new Decimal(0));
    const totalTrades = ok.reduce((sum, result) => sum + result.metrics.trades, 0);
    const totalWins = ok.reduce((sum, result) => sum + result.metrics.wins, 0);
    const totalFees = ok.reduce((sum, result) => sum.plus(result.metrics.feesUsd), new Decimal(0));
    const profitable = ok.filter((result) => result.metrics.netPct.gt(0)).length;
    const worstDrawdown = ok.reduce(
      (worst, result) => Decimal.max(worst, result.metrics.maxDrawdownPct),
      new Decimal(0),
    );
    const equalWeightPct = totalInitial.gt(0)
      ? totalNet.div(totalInitial).mul(100)
      : new Decimal(0);
    const aggregateWinRate = totalTrades > 0 ? new Decimal(totalWins).div(totalTrades).mul(100) : new Decimal(0);

    const sortedNet = ok.map((result) => result.metrics.netPct).sort((left, right) => left.comparedTo(right));
    const medianNet = sortedNet[Math.floor(sortedNet.length / 2)];

    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Symbols evaluated | ${ok.length} / ${results.length} |`);
    lines.push(`| Profitable symbols | ${profitable} / ${ok.length} |`);
    lines.push(`| Aggregate net PnL | ${signedUsd(totalNet)} |`);
    lines.push(`| Equal-weight return | ${signedPct(equalWeightPct)} |`);
    lines.push(`| Median symbol return | ${signedPct(medianNet)} |`);
    lines.push(`| Total trades | ${totalTrades} |`);
    lines.push(`| Aggregate win rate | ${aggregateWinRate.toFixed(2)}% |`);
    lines.push(`| Total fees paid | $${totalFees.toFixed(2)} |`);
    lines.push(`| Worst symbol Max DD | ${worstDrawdown.toFixed(2)}% |`);
    lines.push(`| Alpha targets (PASS) | ${passed.length} |`);
    lines.push('');
    lines.push(
      '_Aggregate is equal-weight per symbol, not a compounded portfolio: each symbol starts at $1,000 and the results are summed. It answers "does this universe carry edge", not "what would one account have earned"._',
    );
  }
  lines.push('');

  lines.push('## 📐 Method');
  lines.push('');
  lines.push(
    '- Each symbol runs the **existing** `src/backtest/run.ts` entrypoint in its own child process (`node dist/backtest/run.js <SYMBOL>`), so a rate limit, a delisted ticker or a bad cache file can only fail that row.',
  );
  lines.push(
    '- Metrics are parsed from `data/Backtest_Report_<SYMBOL>.txt`, the same artifact `npm run backtest` writes; captured stdout is only a fallback.',
  );
  lines.push(
    '- `PASS` requires **all three** gates. `NEAR` requires two of three and a positive return. `NO TRADES` is reported separately — a flat strategy is not a passing one.',
  );
  lines.push(
    '- Fees are the simulator\'s round-trip taker fees (0.055% per leg), already netted out of every PnL figure above.',
  );
  lines.push(
    '- Per-symbol logs: `data/matrix_logs/<SYMBOL>.log`. Per-symbol equity curves: `data/Backtest_Chart_<SYMBOL>.html`.',
  );
  lines.push('');
  lines.push(`_Generated by \`scripts/matrix_tester.ts\` (run signature \`${context.signature}\`)._`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let options: MatrixOptions | null;
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
  const signature = buildSignature(options.symbols);

  console.log('');
  console.log('═'.repeat(78));
  console.log(' HORIZONTAL ALPHA SCALING — BATCH BACKTEST MATRIX');
  console.log(` Symbols : ${options.symbols.length} (${options.symbols.join(', ')})`);
  console.log(` Engine  : ACTIVE_SCENARIOS=${envValue('ACTIVE_SCENARIOS')} | Sniper=${envValue('ENABLE_SNIPER_MODE', 'false')}`);
  console.log(` Window  : BACKTEST_DAYS=${envValue('BACKTEST_DAYS')} | offline=${envValue('USE_LOCAL_CACHE_ONLY', 'false')}`);
  console.log(` Gate    : Net > ${THRESHOLDS.minNetPct.toString()}% | DD < ${THRESHOLDS.maxDrawdownPct.toString()}% | PF > ${THRESHOLDS.minProfitFactor.toString()}`);
  console.log(` Signature: ${signature}`);
  console.log('═'.repeat(78));
  console.log('');

  warnOnConfigDrift();

  if (!options.fromReport && !options.npmMode && !options.noBuild) {
    await runBuild();
  }
  if (!options.fromReport && options.npmMode) {
    console.log('▶ npm mode: every symbol recompiles via "npm run backtest" (slower, but exact CLI parity).');
  }

  const state = options.resume ? loadState(options.statePath) : null;
  if (options.resume && (!state || state.signature !== signature)) {
    console.log('ℹ️  --resume: no state for this config signature — starting fresh.');
  }

  const results: SymbolResult[] = [];
  const nextState: MatrixState = {
    signature,
    updatedAt: new Date().toISOString(),
    runs: options.resume && state?.signature === signature ? { ...state.runs } : {},
  };

  for (let index = 0; index < options.symbols.length; index += 1) {
    const symbol = options.symbols[index];
    const label = `[${String(index + 1).padStart(2, ' ')}/${options.symbols.length}] ${symbol}`;

    if (!options.fromReport) {
      const resumed = options.resume ? tryResume(symbol, options, state, signature) : null;
      if (resumed) {
        results.push(resumed);
        console.log(`${label} — ⏩ resumed (${signedPct(resumed.metrics!.netPct)}, ${resumed.metrics!.trades} trades)`);
        continue;
      }
    }

    let result: SymbolResult;
    if (options.fromReport) {
      result = await runFromReport(symbol, options);
    } else {
      result = await runSymbol(symbol, options);
    }
    results.push(result);

    nextState.runs[symbol] = {
      status: result.status,
      ranAtMs: result.ranAtMs,
    };
    nextState.updatedAt = new Date().toISOString();
    saveState(options.statePath, nextState);

    if (result.status === 'ok' && result.metrics) {
      console.log(
        `${label} — ✅ ${signedPct(result.metrics.netPct)} | ${result.metrics.trades} trades | ` +
          `WR ${result.metrics.winRatePct.toFixed(2)}% | PF ${formatProfitFactor(result.metrics.profitFactor)} | ` +
          `DD ${result.metrics.maxDrawdownPct.toFixed(2)}% | ${verdictLabel(classifyVerdict(result.metrics))} | ` +
          `${(result.durationMs / 1000).toFixed(1)}s`,
      );
    } else {
      console.log(
        `${label} — ❌ ${result.failure?.kind ?? 'unknown'}: ${result.failure?.message ?? 'no report'} | ` +
          `${(result.durationMs / 1000).toFixed(1)}s | log: ${result.logPath}`,
      );
    }

    if (!options.fromReport && index < options.symbols.length - 1 && options.gapMs > 0) {
      await new Promise((done) => setTimeout(done, options.gapMs));
    }
  }

  const markdown = buildMarkdown({
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    signature,
    results,
  });

  const outPath = resolve(options.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log('');
  console.log(markdown);
  console.log('');
  console.log('─'.repeat(78));
  console.log(`Report : ${options.outPath}`);
  console.log(`State  : ${options.statePath}`);
  console.log(`Logs   : ${options.logDir}/`);
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`);
  console.log('─'.repeat(78));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}

export {
  DEFAULT_SYMBOLS,
  THRESHOLDS,
  buildMarkdown,
  buildSignature,
  parseOptions,
};
