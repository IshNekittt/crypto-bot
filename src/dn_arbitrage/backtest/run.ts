import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { logger } from '../../utils/logger';
import {
  DN_DAY_MS,
  DnConfig,
  DnConfigOverrides,
  buildDnConfig,
  roundTripFeeFraction,
  roundTripSlippageFraction,
} from '../config';
import { loadBasketFunding } from '../data/fundingFetcher';
import {
  buildBasketMetrics,
  runFundingSimulation,
} from '../backtest/fundingSimulator';
import { BasketMetrics, SymbolMetrics } from '../types';

/**
 * CLI entry point for the Phase 1 funding-only backtest.
 *
 * Examples:
 *   npm run dn:backtest
 *   npm run dn:backtest -- --days 180 --ma 3 --entry 0.0001 --exit 0.00002
 *   npm run dn:backtest -- --symbols SOLUSDT,NEARUSDT --offline
 *   npm run dn:backtest -- --refresh --trades
 */

const HELP_TEXT = `
DN Funding-Only Backtester (Phase 1)

Usage:
  npm run dn:backtest -- [options]

Options:
  --symbols <list>          Comma-separated symbols (default: 20-coin basket)
  --days <n>                Backtest window in days (default: 180)
  --end <iso|ms>            Window end (default: now)
  --ma <n>                  Funding MA length in epochs (default: 3, range 2–10)
  --entry <rate|percent>    Entry threshold per epoch (default: 0.0003 = 0.03%)
  --exit <rate|percent>     Exit threshold per epoch (default: 0.00002 = 0.002%)
  --basis-entry <rate|pct>  Assumed entry perp premium (default: 0.001 = 0.10%)
  --basis-exit <rate|pct>   Assumed exit perp premium (default: 0 = convergence)
  --spot-fee <rate|percent> Spot taker fee (default: 0.001 = 0.10%)
  --perp-fee <rate|percent> Perp maker fee (Post-Only assumption; default: 0.0002 = 0.02%)
  --slippage-bps <n>        Adverse slippage per side in bps (default: 2)
  --leverage <n>            Perp leverage for equity conversion (default: 3)
  --margin-buffer <rate>    Cash/margin buffer β (default: 0.05 = 5%)
  --equity <usdt>           Starting equity per symbol (default: 10000)
  --profit-buffer <rate>    Extra profit buffer in k_min (default: 0.001 = 0.10%)
  --min-hold-epochs <n>     Economic time-lock floor (default: 3)
  --max-hold-epochs <n>     Economic time-lock ceiling (default: 90)
  --min-hold-hours <n>      Wall-clock time-lock floor (default: 24)
  --max-hold-days <n>       Hard max holding period (default: 30)
  --cooldown <n>            Epochs skipped after exit (default: 3)
  --negative-streak <n>     Consecutive negative epochs to consider exit (default: 3)
  --exit-loss-tolerance <r> Early-exit carry/basis loss tolerance (default: 0)
  --exit-consecutive <n>    MA-below-exit confirmations (default: 2)
  --interval-hours <n>      Fallback funding interval for gap detection (default: 8)
  --cache-dir <path>        Cache root (default: data/dn_cache)
  --concurrency <n>         Concurrent symbol fetches (default: 3)
  --offline                 Cache only; never hit the network
  --refresh                 Ignore a fresh cache and refetch
  --trades                  Print every trade after the summary table
  --json                    Machine-readable JSON output (no table)
  --help                    Show this help

Math: r_net_notional = r_basis + r_funding − r_fees − r_slip
      r_net_equity   = r_net_notional / (1 + (P0/S0)/L + β)
      APY            = (1 + r_net_equity_total)^(365 / window_days) − 1
`;

interface CliOptions {
  readonly config: DnConfig;
  readonly endMs: number;
  readonly offline: boolean;
  readonly refresh: boolean;
  readonly showTrades: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

const BOOLEAN_FLAGS = new Set(['offline', 'refresh', 'trades', 'json', 'help']);

function parseRate(raw: string, flag: string): Decimal {
  const trimmed = raw.trim();
  try {
    if (trimmed.endsWith('%')) {
      return new Decimal(trimmed.slice(0, -1)).div(100);
    }
    return new Decimal(trimmed);
  } catch {
    throw new Error(`${flag}: invalid decimal or percentage "${raw}"`);
  }
}

function parseInteger(raw: string, flag: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${flag}: expected an integer, got "${raw}"`);
  }
  return Number(raw);
}

function parseNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag}: expected a number, got "${raw}"`);
  }
  return value;
}

function parseEnd(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d{12,}$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`--end: invalid UTC date "${raw}" (use ISO-8601 or milliseconds)`);
  }
  return parsed;
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

function parseCli(argv: string[]): CliOptions {
  const raw = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument "${arg}". Use --help for usage.`);
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    if (key.length === 0) throw new Error('Empty flag name');

    if (BOOLEAN_FLAGS.has(key)) {
      if (equalsIndex !== -1) {
        throw new Error(`--${key} is a boolean flag and does not take a value`);
      }
      raw.set(key, true);
      continue;
    }

    if (equalsIndex !== -1) {
      raw.set(key, arg.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    raw.set(key, next);
    i += 1;
  }

  if (raw.has('help')) {
    return {
      config: buildDnConfig(),
      endMs: Date.now(),
      offline: false,
      refresh: false,
      showTrades: false,
      json: false,
      help: true,
    };
  }

  const overrides: DnConfigOverrides = {};

  const symbols = raw.get('symbols');
  if (typeof symbols === 'string') overrides.symbols = parseSymbols(symbols);

  const days = raw.get('days');
  if (typeof days === 'string') overrides.days = parseInteger(days, '--days');

  const ma = raw.get('ma');
  if (typeof ma === 'string') overrides.maEpochs = parseInteger(ma, '--ma');

  const entry = raw.get('entry');
  if (typeof entry === 'string') overrides.entryThreshold = parseRate(entry, '--entry');

  const exit = raw.get('exit');
  if (typeof exit === 'string') overrides.exitThreshold = parseRate(exit, '--exit');

  const basisEntry = raw.get('basis-entry');
  if (typeof basisEntry === 'string') {
    overrides.basisEntryPct = parseRate(basisEntry, '--basis-entry');
  }

  const basisExit = raw.get('basis-exit');
  if (typeof basisExit === 'string') {
    overrides.basisExitPct = parseRate(basisExit, '--basis-exit');
  }

  const spotFee = raw.get('spot-fee');
  if (typeof spotFee === 'string') {
    overrides.spotTakerFee = parseRate(spotFee, '--spot-fee');
  }

  const perpFee = raw.get('perp-fee');
  if (typeof perpFee === 'string') {
    overrides.perpTakerFee = parseRate(perpFee, '--perp-fee');
  }

  const slippageBps = raw.get('slippage-bps');
  if (typeof slippageBps === 'string') {
    overrides.slippageBps = parseNumber(slippageBps, '--slippage-bps');
  }

  const leverage = raw.get('leverage');
  if (typeof leverage === 'string') {
    overrides.leverage = parseInteger(leverage, '--leverage');
  }

  const marginBuffer = raw.get('margin-buffer');
  if (typeof marginBuffer === 'string') {
    overrides.marginBufferPct = parseRate(marginBuffer, '--margin-buffer');
  }

  const equity = raw.get('equity');
  if (typeof equity === 'string') {
    overrides.initialEquity = new Decimal(equity);
  }

  const profitBuffer = raw.get('profit-buffer');
  if (typeof profitBuffer === 'string') {
    overrides.profitBufferPct = parseRate(profitBuffer, '--profit-buffer');
  }

  const minHoldEpochs = raw.get('min-hold-epochs');
  if (typeof minHoldEpochs === 'string') {
    overrides.minHoldingEpochs = parseInteger(minHoldEpochs, '--min-hold-epochs');
  }

  const maxHoldEpochs = raw.get('max-hold-epochs');
  if (typeof maxHoldEpochs === 'string') {
    overrides.maxHoldingEpochs = parseInteger(maxHoldEpochs, '--max-hold-epochs');
  }

  const minHoldHours = raw.get('min-hold-hours');
  if (typeof minHoldHours === 'string') {
    overrides.minHoldingHours = parseInteger(minHoldHours, '--min-hold-hours');
  }

  const maxHoldDays = raw.get('max-hold-days');
  if (typeof maxHoldDays === 'string') {
    overrides.maxHoldingDays = parseInteger(maxHoldDays, '--max-hold-days');
  }

  const cooldown = raw.get('cooldown');
  if (typeof cooldown === 'string') {
    overrides.cooldownEpochs = parseInteger(cooldown, '--cooldown');
  }

  const negativeStreak = raw.get('negative-streak');
  if (typeof negativeStreak === 'string') {
    overrides.negativeStreakEpochs = parseInteger(negativeStreak, '--negative-streak');
  }

  const exitLossTolerance = raw.get('exit-loss-tolerance');
  if (typeof exitLossTolerance === 'string') {
    overrides.exitLossTolerance = parseRate(exitLossTolerance, '--exit-loss-tolerance');
  }

  const exitConsecutive = raw.get('exit-consecutive');
  if (typeof exitConsecutive === 'string') {
    overrides.exitConsecutiveEpochs = parseInteger(
      exitConsecutive,
      '--exit-consecutive',
    );
  }

  const intervalHours = raw.get('interval-hours');
  if (typeof intervalHours === 'string') {
    overrides.expectedIntervalHours = parseInteger(intervalHours, '--interval-hours');
  }

  const cacheDir = raw.get('cache-dir');
  if (typeof cacheDir === 'string') overrides.cacheDir = cacheDir;

  const concurrency = raw.get('concurrency');
  if (typeof concurrency === 'string') {
    overrides.fetchConcurrency = parseInteger(concurrency, '--concurrency');
  }

  const config = buildDnConfig(overrides);

  const end = raw.get('end');
  const endMs = typeof end === 'string' ? parseEnd(end) : Date.now();

  return {
    config,
    endMs,
    offline: raw.get('offline') === true,
    refresh: raw.get('refresh') === true,
    showTrades: raw.get('trades') === true,
    json: raw.get('json') === true,
    help: false,
  };
}

function formatPercent(value: Decimal, signed = false): string {
  const percent = value.mul(100);
  const text = `${percent.abs().toFixed(2)}%`;
  if (percent.lt(0)) return `-${text}`;
  return signed ? `+${text}` : text;
}

/**
 * Funding rates are tiny (0.01% = 0.0001). Two decimals would render the entry
 * floor and the exit threshold identically as "0.00%", so rates get 4 decimals.
 */
function formatRate(value: Decimal): string {
  return `${value.mul(100).toFixed(4)}%`;
}

function formatUsd(value: Decimal, signed = false): string {
  const negative = value.lt(0);
  const [integerPart, fractionPart] = value.abs().toFixed(2).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `$${grouped}.${fractionPart}`;
  if (negative) return `-${body}`;
  return signed ? `+${body}` : body;
}

function formatHold(hours: Decimal | null): string {
  if (hours === null) return '—';
  const value = hours.toNumber();
  if (value >= 48) return `${(value / 24).toFixed(1)}d`;
  return `${value.toFixed(1)}h`;
}

function formatRatio(ratio: Decimal | null): string {
  return ratio === null ? '—' : `${ratio.toFixed(2)}x`;
}

function pad(value: string, width: number, align: 'left' | 'right'): string {
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

function printTable(aggregate: BasketMetrics): void {
  const columns = [
    { header: 'Symbol', width: 12, align: 'left' as const },
    { header: 'Trades', width: 7, align: 'right' as const },
    { header: 'Avg Hold', width: 9, align: 'right' as const },
    { header: 'Total Yield', width: 13, align: 'right' as const },
    { header: 'Net APY', width: 11, align: 'right' as const },
    { header: 'Net PnL', width: 14, align: 'right' as const },
    { header: 'Fund/Fee', width: 9, align: 'right' as const },
    { header: 'Gaps', width: 5, align: 'right' as const },
  ];

  const header = columns
    .map((column) => pad(column.header, column.width, column.align))
    .join('  ');
  const separator = columns.map((column) => '-'.repeat(column.width)).join('  ');

  console.log(header);
  console.log(separator);

  for (const result of aggregate.results) {
    const row = [
      pad(result.symbol, 12, 'left'),
      pad(String(result.tradeCount), 7, 'right'),
      pad(formatHold(result.avgHoldHours), 9, 'right'),
      pad(formatPercent(result.totalYield, true), 13, 'right'),
      pad(formatPercent(result.netApy, true), 11, 'right'),
      pad(formatUsd(result.netPnlUsdt, true), 14, 'right'),
      pad(formatRatio(result.fundingToFeeRatio), 9, 'right'),
      pad(String(result.dataGaps), 5, 'right'),
    ];
    console.log(row.join('  '));
  }

  if (aggregate.results.length > 0) {
    console.log(separator);
    const totalRow = [
      pad('TOTAL', 12, 'left'),
      pad(String(aggregate.tradeCount), 7, 'right'),
      pad(formatHold(aggregate.avgHoldHours), 9, 'right'),
      pad(formatPercent(aggregate.totalYield, true), 13, 'right'),
      pad(formatPercent(aggregate.netApy, true), 11, 'right'),
      pad(formatUsd(aggregate.netPnlUsdt, true), 14, 'right'),
      pad(formatRatio(aggregate.fundingToFeeRatio), 9, 'right'),
      pad(
        String(aggregate.results.reduce((acc, result) => acc + result.dataGaps, 0)),
        5,
        'right',
      ),
    ];
    console.log(totalRow.join('  '));
  }
}

function printTradeLog(results: readonly SymbolMetrics[]): void {
  console.log('');
  console.log('TRADE LOG');
  for (const result of results) {
    if (result.trades.length === 0) continue;
    console.log(`\n${result.symbol}`);
    for (const trade of result.trades) {
      console.log(
        `  ${new Date(trade.entryTime).toISOString()} → ${new Date(trade.exitTime).toISOString()} | ` +
          `${trade.epochsHeld} ep (${trade.holdHours.toFixed(1)}h, k_min=${trade.kMin}) | ` +
          `funding=${formatRate(trade.fundingReturn)} basis=${formatRate(trade.basisReturn)} ` +
          `fees=${formatRate(trade.feeReturn)} slip=${formatRate(trade.slippageReturn)} | ` +
          `net=${formatPercent(trade.netEquityReturn, true)} | ${formatUsd(trade.netPnlUsdt, true)} | ` +
          `${trade.exitReason}`,
      );
    }
  }
}

function printReport(
  aggregate: BasketMetrics,
  config: DnConfig,
  fromMs: number,
  toMs: number,
  showTrades: boolean,
): void {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  DELTA-NEUTRAL FUNDING BACKTEST — FUNDING-ONLY MODE (PHASE 1)');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(
    `Window       : ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} (${aggregate.windowDays.toFixed(1)} days)`,
  );
  console.log(
    `Signal       : f_ma(${config.maEpochs}) >= ${formatRate(config.entryThreshold)} entry | ` +
      `f_ma < ${formatRate(config.exitThreshold)} exit | ` +
      `${config.exitConsecutiveEpochs} confirmations`,
  );
  console.log(
    `Costs        : spot taker ${formatPercent(config.spotTakerFee)} + perp maker ${formatPercent(config.perpTakerFee)} per leg | ` +
      `round trip ${formatPercent(roundTripFeeFraction(config))} + slip ${formatPercent(roundTripSlippageFraction(config))}`,
  );
  console.log(
    `Basis        : entry ${formatPercent(config.basisEntryPct)} → exit ${formatPercent(config.basisExitPct)} | ` +
      `L=${config.leverage}x | β=${formatPercent(config.marginBufferPct)}`,
  );
  console.log(
    `Capital      : ${formatUsd(config.initialEquity)} per symbol | ` +
      `${config.symbols.length} requested | ${aggregate.results.length} simulated`,
  );
  console.log(
    `Lifecycle    : k_min clamp [${config.minHoldingEpochs}, ${config.maxHoldingEpochs}] epochs | ` +
      `wall-clock min ${config.minHoldingHours}h | max hold ${config.maxHoldingDays}d | ` +
      `cooldown ${config.cooldownEpochs} epochs | exit loss tolerance ${formatPercent(config.exitLossTolerance)}`,
  );
  console.log('');
  printTable(aggregate);

  if (aggregate.failures.length > 0) {
    console.log('');
    console.log(`SKIPPED SYMBOLS (${aggregate.failures.length})`);
    for (const failure of aggregate.failures) {
      console.log(`  - ${failure.symbol}: ${failure.error}`);
    }
  }

  console.log('');
  console.log('MODEL NOTES');
  console.log('  • Funding-only: no OHLC, no intrabar execution, no liquidation model.');
  console.log('  • Funding accrual uses mark ≈ S0 (1:1 rate); basis entry/exit are assumptions.');
  console.log('  • Fees are charged on both entry and exit for both legs, exactly as §8.4.');
  console.log('  • Net yield is on allocated equity, not notional: N0 = E_alloc / (1 + (P0/S0)/L + β).');
  console.log('  • APY compounds each symbol sequentially over the data window; idle cash earns 0.');
  console.log('  • Time-lock: k_min = ceil((fees + slippage + profit buffer) / entry MA), then clamped.');
  console.log('  • Missing funding epochs are never fabricated; Gaps counts intervals > 2× the funding interval.');

  if (showTrades) printTradeLog(aggregate.results);
}

function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, rawValue: unknown) =>
      rawValue instanceof Decimal ? rawValue.toString() : rawValue,
    2,
  );
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(HELP_TEXT.trim());
    return;
  }

  const { config } = cli;
  const toMs = cli.endMs;
  const fromMs = toMs - config.days * DN_DAY_MS;

  logger.info(
    `[DN] Funding-only backtest: ${config.symbols.length} symbols, ${config.days} days, ` +
      `${cli.offline ? 'offline cache' : 'network + cache'}`,
  );

  const basket = await loadBasketFunding(config.symbols, fromMs, toMs, {
    config,
    offline: cli.offline,
    refresh: cli.refresh,
  });

  const results: SymbolMetrics[] = [];
  for (const symbol of config.symbols) {
    const history = basket.histories.get(symbol);
    if (!history) continue;

    const metrics = runFundingSimulation({
      symbol,
      events: history.events,
      intervalHours: history.intervalHours,
      dataGaps: history.dataGaps,
      config,
    });
    results.push(metrics);
  }

  const aggregate = buildBasketMetrics(results, basket.failures, config);

  if (cli.json) {
    console.log(
      serialize({
        generatedAt: new Date().toISOString(),
        mode: 'funding-only',
        window: {
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          days: config.days,
        },
        config,
        aggregate,
      }),
    );
  } else {
    printReport(aggregate, config, fromMs, toMs, cli.showTrades);
  }

  if (results.length === 0) {
    logger.error('[DN] No symbols produced a usable funding history');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[DN] Fatal error: ${message}`);
  console.error(`[DN] Fatal error: ${message}`);
  process.exit(1);
});
