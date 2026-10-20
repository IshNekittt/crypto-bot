import { Decimal } from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { TradeResult } from './executionSimulator';
import { Scenario2_FVGFill } from '../engine/scenarios/Scenario2_FVGFill';
import { Scenario4_MitigationChain } from '../engine/scenarios/Scenario4_MitigationChain';
import { Scenario5_HTFLiquiditySweep } from '../engine/scenarios/Scenario5_HTFLiquiditySweep';
import { Scenario7_AMD } from '../engine/scenarios/Scenario7_AMD';
import { Scenario8_RangeDeviationReclaim } from '../engine/scenarios/Scenario8_RangeDeviationReclaim';
import { Scenario9_TurtleSoup } from '../engine/scenarios/Scenario9_TurtleSoup';
import { Scenario10_BreakerBlock } from '../engine/scenarios/Scenario10_BreakerBlock';
import { Scenario11_MitigationBlock } from '../engine/scenarios/Scenario11_MitigationBlock';

export interface ScenarioStats {
  name: string;
  id: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: Decimal;
  profitContribution: Decimal;
}

export function generateReport(
  symbol: string,
  initialBalance: Decimal,
  finalBalance: Decimal,
  trades: TradeResult[],
  periodStart: Date,
  periodEnd: Date,
  totalDays: number,
  maxDrawdown: Decimal
): string {
  const netProfit = finalBalance.minus(initialBalance);
  const netProfitPercent = netProfit.div(initialBalance).mul(100);

  const wins = trades.filter(t => t.pnl.gt(0));
  const losses = trades.filter(t => t.pnl.lte(0));

  const grossProfit = wins.reduce((sum, t) => sum.plus(t.pnl), new Decimal('0'));
  const grossLoss = losses.reduce((sum, t) => sum.plus(t.pnl.abs()), new Decimal('0'));
  const profitFactor = grossLoss.eq(0) ? new Decimal('Infinity') : grossProfit.div(grossLoss);

  const winRate = trades.length > 0 ? new Decimal(wins.length).div(trades.length).mul(100) : new Decimal('0');

  const totalFees = trades.reduce((sum, t) => sum.plus(t.feesPaid), new Decimal('0'));

  const scenarioMap = new Map<number, { name: string; trades: TradeResult[] }>();
  for (const trade of trades) {
    if (!scenarioMap.has(trade.scenarioId)) {
      scenarioMap.set(trade.scenarioId, { name: trade.scenarioName, trades: [] });
    }
    scenarioMap.get(trade.scenarioId)!.trades.push(trade);
  }

  const scenarioStats: ScenarioStats[] = [];
  for (const [id, data] of scenarioMap) {
    const sWins = data.trades.filter(t => t.pnl.gt(0)).length;
    const sLosses = data.trades.filter(t => t.pnl.lte(0)).length;
    const sProfit = data.trades.reduce((sum, t) => sum.plus(t.pnl), new Decimal('0'));
    const sWinRate = data.trades.length > 0 ? new Decimal(sWins).div(data.trades.length).mul(100) : new Decimal('0');
    scenarioStats.push({
      name: data.name,
      id,
      totalTrades: data.trades.length,
      wins: sWins,
      losses: sLosses,
      winRate: sWinRate,
      profitContribution: sProfit,
    });
  }

  scenarioStats.sort((a, b) => b.profitContribution.comparedTo(a.profitContribution));

  let lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push(`           BACKTEST REPORT: ${symbol}`);
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`📅 Period: ${periodStart.toISOString().split('T')[0]} → ${periodEnd.toISOString().split('T')[0]} (${totalDays} days)`);
  lines.push('');
  lines.push('💰 BALANCE');
  lines.push(`   Initial Balance:   $${initialBalance.toFixed(2)}`);
  lines.push(`   Final Balance:     $${finalBalance.toFixed(2)}`);
  lines.push(`   Net Profit:        $${netProfit.toFixed(2)} (${netProfitPercent.toFixed(2)}%)`);
  lines.push('');
  lines.push('📊 TRADES');
  lines.push(`   Total Trades:      ${trades.length}`);
  lines.push(`   Wins:              ${wins.length}`);
  lines.push(`   Losses:            ${losses.length}`);
  lines.push(`   Win Rate:          ${winRate.toFixed(2)}%`);
  lines.push(`   Profit Factor:     ${profitFactor.eq(Infinity) ? '∞' : profitFactor.toFixed(2)}`);
  lines.push(`   Max Drawdown:      ${maxDrawdown.toFixed(2)}%`);
  lines.push(`   Total Fees Paid:   $${totalFees.toFixed(2)}`);
  lines.push('');

  // ─── Dry Spells / Trade Clustering Analysis ───
  if (trades.length >= 2) {
    // Sort trades by entry time
    const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    
    let maxDrySpellDays = 0;
    let drySpellsGt3 = 0;
    let drySpellsGt5 = 0;
    let drySpellsGt7 = 0;

    for (let i = 1; i < sortedTrades.length; i++) {
      const prevExit = sortedTrades[i - 1].exitTime;
      const currEntry = sortedTrades[i].entryTime;
      const gapDays = (currEntry - prevExit) / (1000 * 60 * 60 * 24);

      if (gapDays > maxDrySpellDays) {
        maxDrySpellDays = gapDays;
      }
      if (gapDays > 3) drySpellsGt3++;
      if (gapDays > 5) drySpellsGt5++;
      if (gapDays > 7) drySpellsGt7++;
    }

    lines.push('⏳ TRADE CLUSTERING & DRY SPELLS');
    lines.push(`   Max consecutive days without trades: ${maxDrySpellDays.toFixed(1)} days`);
    lines.push(`   Periods > 3 days without trades: ${drySpellsGt3} times`);
    lines.push(`   Periods > 5 days without trades: ${drySpellsGt5} times`);
    lines.push(`   Periods > 7 days without trades: ${drySpellsGt7} times`);
    lines.push('');
  }

  // ─── Chronological Trade Calendar (Dynamic Days) ───
  if (trades.length > 0) {
    // Sort trades by entry time
    const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    
    // Calculate actual days to show: min(30, totalDays of backtest)
    const daysToShow = Math.min(30, totalDays);
    const periodEndMs = periodEnd.getTime();
    const daysMs = daysToShow * 24 * 60 * 60 * 1000;
    const startMs = periodEndMs - daysMs;
    
    // Group trades by date (UTC)
    const tradesByDate = new Map<string, TradeResult[]>();
    for (const trade of sortedTrades) {
      if (trade.entryTime >= startMs && trade.entryTime <= periodEndMs) {
        const date = new Date(trade.entryTime);
        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD in UTC
        if (!tradesByDate.has(dateStr)) {
          tradesByDate.set(dateStr, []);
        }
        tradesByDate.get(dateStr)!.push(trade);
      }
    }
    
    // Generate calendar for actual days
    lines.push(`🗓️ TRADE TIMELINE (Last ${daysToShow} Days of Backtest) [Timezone: UTC]`);
    for (let i = 0; i < daysToShow; i++) {
      const dateMs = periodEndMs - (i * 24 * 60 * 60 * 1000);
      const date = new Date(dateMs);
      const dateStr = date.toISOString().split('T')[0];
      
      const dayTrades = tradesByDate.get(dateStr) || [];
      
      if (dayTrades.length === 0) {
        lines.push(`[${dateStr}] ❌ No trades (Waiting)`);
      } else {
        const dailyPnL = dayTrades.reduce((sum, t) => sum.plus(t.pnl), new Decimal('0'));
        const pnlSign = dailyPnL.gte(0) ? '+' : '';
        lines.push(`[${dateStr}] ✅ ${dayTrades.length} trade${dayTrades.length > 1 ? 's' : ''} | Daily PnL: ${pnlSign}${dailyPnL.toFixed(2)}`);
        
        // Sort day trades by entry time
        dayTrades.sort((a, b) => a.entryTime - b.entryTime);
        for (const trade of dayTrades) {
          const entryTime = new Date(trade.entryTime).toISOString().split('T')[1].substring(0, 8); // HH:MM:SS UTC
          const resultLabel = trade.pnl.gte(0) ? 'WIN' : 'LOSS';
          const pnlSign2 = trade.pnl.gte(0) ? '+' : '';
          lines.push(`  ↳ ${entryTime} UTC - Scenario ${trade.scenarioId} (${resultLabel}: ${pnlSign2}$${trade.pnl.toFixed(2)})`);
        }
      }
    }
    lines.push('');
  }

  // ─── Detailed Recent Trades (Last 5 trades) ───
  if (trades.length > 0) {
    const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    const last5Trades = sortedTrades.slice(-5);
    
    lines.push('🔍 DETAILED RECENT TRADES (Last 5 trades):');
    for (const trade of last5Trades) {
      const entryTime = new Date(trade.entryTime).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
      const exitTime = new Date(trade.exitTime).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
      const resultLabel = trade.pnl.gte(0) ? 'WIN' : 'LOSS';
      const pnlSign = trade.pnl.gte(0) ? '+' : '';
      const pnlPctSign = trade.pnlPercent.gte(0) ? '+' : '';
      
      lines.push(`  ↳ ${symbol} | Scenario ${trade.scenarioId} (${trade.scenarioName}) | ${resultLabel}`);
      lines.push(`     Entry: ${entryTime} | Exit: ${exitTime}`);
      lines.push(`     Entry: ${trade.entryPrice} | SL: ${trade.slPrice} | TP: ${trade.tpPrice} | Qty: ${trade.qty}`);
      lines.push(`     PnL: ${pnlSign}$${trade.pnl.toFixed(2)} (${pnlPctSign}${trade.pnlPercent.toFixed(2)}%) | Fees: $${trade.feesPaid.toFixed(2)}`);
    }
    lines.push('');
  }

  lines.push('📋 SCENARIO BREAKDOWN');
  lines.push('   Scenario                    | Trades |  Win | Loss | Win%  | Profit $');
  lines.push('   ────────────────────────────┼────────┼──────┼──────┼───────┼───────────');
  for (const s of scenarioStats) {
    const name = s.name.padEnd(28);
    const tradesStr = s.totalTrades.toString().padStart(6);
    const winsStr = s.wins.toString().padStart(4);
    const lossesStr = s.losses.toString().padStart(4);
    const winRateStr = s.winRate.toFixed(2).padStart(5);
    const profitStr = s.profitContribution.toFixed(2).padStart(9);
    lines.push(`   ${name} │ ${tradesStr} │ ${winsStr} │ ${lossesStr} │ ${winRateStr}% │ $${profitStr}`);
  }
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');

  // Rejection stats for key scenarios
  const scenario2Stats = Scenario2_FVGFill.getRejectionStats();
  const scenario4Stats = Scenario4_MitigationChain.getRejectionStats();
  const scenario5Stats = Scenario5_HTFLiquiditySweep.getRejectionStats();
  const scenario7Stats = Scenario7_AMD.getRejectionStats();
  const scenario8Stats = Scenario8_RangeDeviationReclaim.getRejectionStats();
  const scenario9Stats = Scenario9_TurtleSoup.getRejectionStats();
  const scenario10Stats = Scenario10_BreakerBlock.getRejectionStats();
  const scenario11Stats = Scenario11_MitigationBlock.getRejectionStats();

  lines.push('📊 SCENARIO REJECTION STATS');
  lines.push('   Scenario 2 (FVG Fill):');
  lines.push(`     Total: ${scenario2Stats.totalEvals} | Killzone: ${scenario2Stats.killzone} | NoHTFFVG: ${scenario2Stats.noHtfFvg} | NoTouch: ${scenario2Stats.noFvgTouch} | NoChoch: ${scenario2Stats.noChoch} | Disp: ${scenario2Stats.displacement} | PremDisc: ${scenario2Stats.premiumDiscount} | NoLiqCtx: ${scenario2Stats.noLiquidityContext}`);
  lines.push('   Scenario 4 (Mitigation Chain):');
  lines.push(`     Total: ${scenario4Stats.totalEvals} | Killzone: ${scenario4Stats.killzone} | NoOB: ${scenario4Stats.noValidOb} | NoTouch: ${scenario4Stats.noObTouch} | NoChoch: ${scenario4Stats.noChoch} | Disp: ${scenario4Stats.displacement} | PremDisc: ${scenario4Stats.premiumDiscount} | NoBOS: ${scenario4Stats.noBosAfterBounce}`);
  lines.push('   Scenario 5 (HTF Sweep):');
  lines.push(`     Total: ${scenario5Stats.totalEvals} | Killzone: ${scenario5Stats.killzone} | NoPools: ${scenario5Stats.noPools} | NoSweep: ${scenario5Stats.noSweep} | NoChoch: ${scenario5Stats.noChoch} | Displacement: ${scenario5Stats.displacement} | NoFvg: ${scenario5Stats.noFvg}`);
  lines.push('   Scenario 7 (AMD):');
  lines.push(`     Total: ${scenario7Stats.totalEvals} | Killzone: ${scenario7Stats.killzone} | NoAsianRange: ${scenario7Stats.noAsianRange} | TooWide: ${scenario7Stats.asianRangeTooWide} | NoSweep: ${scenario7Stats.noSweep} | NoChoch: ${scenario7Stats.noChoch} | Displacement: ${scenario7Stats.displacement} | NoFvg: ${scenario7Stats.noFvg}`);
  lines.push('   Scenario 8 (Range Deviation):');
  lines.push(`     Total: ${scenario8Stats.totalEvals} | Killzone: ${scenario8Stats.killzone} | NoRange: ${scenario8Stats.noTradingRange} | NoDeviation: ${scenario8Stats.noDeviation} | NoReclaim: ${scenario8Stats.noReclaim} | NoChoch: ${scenario8Stats.noChoch} | Displacement: ${scenario8Stats.displacement} | NoFvg: ${scenario8Stats.noFvg} | RR: ${scenario8Stats.rr}`);
  lines.push('   Scenario 9 (Turtle Soup):');
  lines.push(`     Total: ${scenario9Stats.totalEvals} | Killzone: ${scenario9Stats.killzone} | NoRange: ${scenario9Stats.noTradingRange} | NoEqhEql: ${scenario9Stats.noEqhEql} | NoSfp: ${scenario9Stats.noSfp} | NoRejectionWick: ${scenario9Stats.noRejectionWick} | RR: ${scenario9Stats.rr} | PremDisc: ${scenario9Stats.premiumDiscount}`);
  lines.push('   Scenario 10 (Breaker Block):');
  lines.push(`     Total: ${scenario10Stats.totalEvals} | Killzone: ${scenario10Stats.killzone} | NoBreak: ${scenario10Stats.noBreak} | NoBrokenOB: ${scenario10Stats.noBrokenOb} | NoLiqSweep: ${scenario10Stats.noLiquiditySweep} | NotBOS: ${scenario10Stats.notBos} | OBNotFresh: ${scenario10Stats.obNotFresh} | NoFvg: ${scenario10Stats.noFvg} | NoRetest: ${scenario10Stats.noRetest} | Disp: ${scenario10Stats.displacement} | BodyClose: ${scenario10Stats.bodyClose}`);
  lines.push('   Scenario 11 (Mitigation Block):');
  lines.push(`     Total: ${scenario11Stats.totalEvals} | Killzone: ${scenario11Stats.killzone} | NoSms: ${scenario11Stats.noSms} | InvalidSms: ${scenario11Stats.invalidSmsPattern} | NoChoch: ${scenario11Stats.noChoch} | Displacement: ${scenario11Stats.displacement} | NoMB: ${scenario11Stats.noMitigationBlock} | NoRetest: ${scenario11Stats.noRetest} | PremDisc: ${scenario11Stats.premiumDiscount}`);
  lines.push('');

  return lines.join('\n');
}

export function printReport(
  symbol: string,
  initialBalance: Decimal,
  finalBalance: Decimal,
  trades: TradeResult[],
  periodStart: Date,
  periodEnd: Date,
  totalDays: number,
  maxDrawdown: Decimal,
  // Accepted for signature symmetry with writeBacktestArtifacts(): the text
  // report has no candle-based section, only the HTML artifact draws them.
  // Prefixed with "_" because tsconfig enables noUnusedParameters.
  _candles: any[] = []
): void {
  console.log(generateReport(symbol, initialBalance, finalBalance, trades, periodStart, periodEnd, totalDays, maxDrawdown));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Equity Curve (Chart.js, CDN-loaded, fully self-contained output)
// ─────────────────────────────────────────────────────────────────────────────

export interface EquityPoint {
  label: string;
  equity: number;
  peak: number;
  drawdownPct: number;
}

export interface BacktestArtifacts {
  reportPath: string;
  chartPath: string;
}

const CHART_JS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const LIGHTWEIGHT_CHARTS_CDN =
  'https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safely embeds a value into an inline <script> block.
 * Escapes "<" so a "</script>" sequence can never terminate the block early.
 */
function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function formatUtcTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

/**
 * Builds the equity series from closed trades (sorted by exit time).
 * Presentation only — the Decimal math stays authoritative; values are
 * converted to `number` exclusively for Chart.js rendering.
 */
export function buildEquitySeries(
  initialBalance: Decimal,
  trades: TradeResult[],
  periodStart: Date
): EquityPoint[] {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const points: EquityPoint[] = [];

  let balance = initialBalance;
  let peak = initialBalance;

  const toPoint = (ts: number, current: Decimal, runningPeak: Decimal): EquityPoint => {
    const drawdownPct = runningPeak.gt(0)
      ? runningPeak.minus(current).div(runningPeak).mul(100).toNumber()
      : 0;
    return {
      label: formatUtcTimestamp(ts),
      equity: current.toNumber(),
      peak: runningPeak.toNumber(),
      drawdownPct: Math.max(0, drawdownPct),
    };
  };

  // Anchor the chart to the first executed trade rather than to the raw backtest
  // start. The 1m Sniper cache can begin months after the 15m/4H window, so using
  // `periodStart` would draw a huge, misleading flat line before the first trade.
  // Start exactly one day before that trade (clamped to the backtest start).
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const firstTradeEntry =
    sorted.length > 0
      ? sorted.reduce((min, trade) => Math.min(min, trade.entryTime), sorted[0].entryTime)
      : null;
  const chartStartTime =
    firstTradeEntry === null
      ? periodStart.getTime()
      : Math.max(periodStart.getTime(), firstTradeEntry - ONE_DAY_MS);

  // Anchor point: balance before the first trade
  points.push(toPoint(chartStartTime, balance, peak));

  for (const trade of sorted) {
    balance = balance.plus(trade.pnl);
    if (balance.gt(peak)) peak = balance;
    points.push(toPoint(trade.exitTime, balance, peak));
  }

  return points;
}

// ─────────────────────────────────────────────────────────────────────────────
// TradingView Lightweight Charts — price action + trade overlay
// ─────────────────────────────────────────────────────────────────────────────

export interface TradingViewCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradingViewMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  text: string;
}

/**
 * Converts backtest candles (timestamp in ms, OHLC as strings) into the
 * Lightweight Charts candle format (timestamp in seconds, OHLC as numbers).
 *
 * Presentation only — money remains `Decimal`/string everywhere else. Invalid
 * candles are dropped instead of poisoning the series, because a single NaN
 * makes the browser-side `setData()` throw and kills the whole chart.
 * Timestamps are deduplicated and sorted ascending: Lightweight Charts requires
 * strictly ascending, unique times.
 */
export function buildTradingViewCandles(candles: any[]): TradingViewCandle[] {
  const byTime = new Map<number, TradingViewCandle>();

  for (const candle of candles) {
    const timestampMs = Number(candle?.timestamp);
    const open = Number(candle?.open);
    const high = Number(candle?.high);
    const low = Number(candle?.low);
    const close = Number(candle?.close);

    if (!Number.isFinite(timestampMs)) continue;
    if (![open, high, low, close].every((value) => Number.isFinite(value))) continue;

    // Seconds, not milliseconds — Lightweight Charts treats numbers as UTCTimestamp.
    const time = Math.floor(timestampMs / 1000);
    byTime.set(time, { time, open, high, low, close });
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Builds entry/exit markers for the price chart.
 *
 * Lightweight Charts requires every marker time to match an existing candle
 * exactly, so trade timestamps are snapped to the latest candle at or before
 * the event. Trades that predate the first candle clamp to the chart start.
 */
export function buildTradingViewMarkers(
  trades: TradeResult[],
  candles: TradingViewCandle[]
): TradingViewMarker[] {
  if (candles.length === 0) return [];

  const times = candles.map((candle) => candle.time);

  const alignToCandle = (timestampMs: number): number | null => {
    if (!Number.isFinite(timestampMs)) return null;

    const targetSeconds = Math.floor(timestampMs / 1000);
    if (targetSeconds <= times[0]) return times[0];

    // Binary search: largest candle time <= target (times is sorted ascending).
    let low = 0;
    let high = times.length - 1;
    let best = times[times.length - 1];

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (times[mid] <= targetSeconds) {
        best = times[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return best;
  };

  const markers: TradingViewMarker[] = [];

  for (const trade of trades) {
    const isLong = trade.side === 'Buy';
    const entryTime = alignToCandle(trade.entryTime);
    const exitTime = alignToCandle(trade.exitTime);

    if (entryTime !== null) {
      markers.push({
        time: entryTime,
        position: isLong ? 'belowBar' : 'aboveBar',
        color: isLong ? '#22c55e' : '#ef4444',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: `${trade.side} Entry`,
      });
    }

    if (exitTime !== null) {
      const isWin = trade.pnl.gte(0);
      markers.push({
        time: exitTime,
        position: isWin ? 'aboveBar' : 'belowBar',
        color: isWin ? '#22c55e' : '#ef4444',
        shape: 'circle',
        text: trade.closedBy || (isWin ? 'TP' : 'SL'),
      });
    }
  }

  // Lightweight Charts requires markers sorted by time. Array.prototype.sort is
  // stable, so an entry always precedes its exit when both land on one candle.
  return markers.sort((a, b) => a.time - b.time);
}

/**
 * Human-readable LTF label ("15m", "4H", "1D") derived from the candle spacing
 * instead of a hardcoded timeframe, so custom `LTF_TIMEFRAME` runs stay correct.
 */
export function describeCandleInterval(candles: TradingViewCandle[]): string {
  if (candles.length < 2) return '';

  const deltas = candles
    .slice(0, 50)
    .map((candle, index, sample) => (index === 0 ? 0 : candle.time - sample[index - 1].time))
    .slice(1)
    .filter((delta) => delta > 0)
    .sort((a, b) => a - b);

  if (deltas.length === 0) return '';

  const intervalSeconds = deltas[Math.floor(deltas.length / 2)];
  const minutes = Math.round(intervalSeconds / 60);

  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}m`;
}

export function generateEquityCurveHtml(
  symbol: string,
  initialBalance: Decimal,
  finalBalance: Decimal,
  trades: TradeResult[],
  periodStart: Date,
  periodEnd: Date,
  maxDrawdown: Decimal,
  candles: any[]
): string {
  const series = buildEquitySeries(initialBalance, trades, periodStart);

  const tvCandles = buildTradingViewCandles(candles);
  const tvMarkers = buildTradingViewMarkers(trades, tvCandles);
  const timeframeLabel = describeCandleInterval(tvCandles);
  const overlayTitle = timeframeLabel
    ? `Asset Price &amp; Trade Overlay (${timeframeLabel})`
    : 'Asset Price &amp; Trade Overlay';

  const labels = series.map((p) => p.label);
  const equity = series.map((p) => p.equity);
  const peak = series.map((p) => p.peak);
  // Positive magnitudes: the secondary axis is reversed, so 0% sits at the top
  // and deeper drawdowns are drawn downwards (tooltips render them as negative).
  const drawdown = series.map((p) => p.drawdownPct);

  // Y1 axis headroom. Chart.js auto-scale can settle exactly on the deepest dip,
  // and because the axis is reversed the red line then looks like it plunges
  // through the floor of the plot. Reserve 20% of extra depth below the worst
  // drawdown so the line always stays inside the chart.
  // The simulator's reported `maxDrawdown` is also considered: it samples equity
  // continuously (entry fees, partial closes), so it can be deeper than anything
  // the closed-trade series captures. Using only the series would leave the axis
  // ending above the figure printed in the text report.
  const seriesMaxDrawdown = drawdown.reduce((max, value) => (value > max ? value : max), 0);
  const reportedMaxDrawdown = maxDrawdown.isFinite() ? maxDrawdown.toNumber() : 0;
  const deepestDrawdown = Math.max(seriesMaxDrawdown, reportedMaxDrawdown, 0);
  const drawdownAxisMax = deepestDrawdown > 0 ? deepestDrawdown * 1.2 : 1;
  const drawdownAxisMaxLiteral = drawdownAxisMax.toFixed(4);

  const netProfit = finalBalance.minus(initialBalance);
  const netProfitPercent = initialBalance.gt(0)
    ? netProfit.div(initialBalance).mul(100)
    : new Decimal('0');
  const wins = trades.filter((t) => t.pnl.gt(0)).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const netPositive = netProfit.gte(0);
  const safeSymbol = escapeHtml(symbol);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Equity Curve — ${safeSymbol}</title>
<script src="${CHART_JS_CDN}"></script>
<script src="${LIGHTWEIGHT_CHARTS_CDN}"></script>
<style>
  :root {
    --bg: #121212;
    --panel: #1b1b1b;
    --border: #2a2a2a;
    --text: #f5f5f5;
    --muted: #9e9e9e;
    --green: #00e676;
    --red: #ff5252;
    --amber: #ffc400;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.7px; }
  .card .v { font-size: 18px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .chart-wrap {
    position: relative;
    width: 100%;
    height: 68vh;
    min-height: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
  }
  .legend { margin-top: 14px; color: var(--muted); font-size: 12px; line-height: 1.7; }
  .legend b { color: var(--text); font-weight: 600; }
  .card-title {
    margin: 0 0 15px 0;
    font-size: 14px;
    color: #a1a1aa;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tv-chart { width: 100%; height: 600px; }
  .tv-empty { color: var(--muted); font-size: 13px; padding: 24px 4px; }
  #fallback { display: none; color: var(--red); padding: 24px; }
</style>
</head>
<body>
  <h1>Equity Curve — ${safeSymbol}</h1>
  <div class="sub">${periodStart.toISOString().split('T')[0]} → ${periodEnd.toISOString().split('T')[0]} · ${trades.length} closed trades</div>

  <div class="cards">
    <div class="card"><div class="k">Initial Balance</div><div class="v">$${initialBalance.toFixed(2)}</div></div>
    <div class="card"><div class="k">Final Balance</div><div class="v">$${finalBalance.toFixed(2)}</div></div>
    <div class="card"><div class="k">Net Profit</div><div class="v ${netPositive ? 'pos' : 'neg'}">${netPositive ? '+' : ''}$${netProfit.toFixed(2)}</div></div>
    <div class="card"><div class="k">Return</div><div class="v ${netPositive ? 'pos' : 'neg'}">${netProfitPercent.toFixed(2)}%</div></div>
    <div class="card"><div class="k">Max Drawdown</div><div class="v neg">${maxDrawdown.toFixed(2)}%</div></div>
    <div class="card"><div class="k">Win Rate</div><div class="v">${winRate.toFixed(2)}%</div></div>
  </div>

  <div class="chart-wrap">
    <canvas id="equityChart"></canvas>
    <div id="fallback">Chart.js could not be loaded from the CDN. Open this file with an internet connection to render the chart.</div>
  </div>

  <div class="legend">
    <b>Green</b> segments = equity making new highs · <b>Red</b> segments = equity below its running peak (drawdown).<br />
    Dashed grey = running peak (high-water mark) · Thin red line = closed drawdown depth (%, right axis: 0% at the top, deeper drawdowns point downwards).<br />
    Thick dashed red = max floating drawdown, the deepest intra-trade equity dip recorded by the simulator.<br />
    Max Floating Drawdown represents intra-trade equity dips not visible in closed-trade data points. All timestamps UTC.
  </div>

  <div class="card" style="margin-top: 20px;">
    <div class="card-title">${overlayTitle}</div>
    <div id="tvchart" class="tv-chart"></div>
  </div>

  <script>
    const LABELS = ${serializeForScript(labels)};
    const EQUITY = ${serializeForScript(equity)};
    const PEAK = ${serializeForScript(peak)};
    const DRAWDOWN = ${serializeForScript(drawdown)};
    // Intra-trade (floating) drawdown sampled by the simulator. The closed-trade
    // series above cannot show it, so it is drawn as a horizontal reference line.
    const MAX_FLOATING_DRAWDOWN = ${reportedMaxDrawdown.toFixed(4)};
    const HAS_FLOATING_DRAWDOWN = MAX_FLOATING_DRAWDOWN > 0;
    const GREEN = '#00e676';
    const RED = '#ff5252';

    // ─── Trade overlay data (Lightweight Charts) ───
    // Plain OHLC numbers: the chart library has no notion of Decimal/strings.
    const CANDLE_DATA = ${serializeForScript(tvCandles)};
    const MARKER_DATA = ${serializeForScript(tvMarkers)};

    function render() {
      if (typeof Chart === 'undefined') {
        document.getElementById('equityChart').style.display = 'none';
        document.getElementById('fallback').style.display = 'block';
        return;
      }

      const canvas = document.getElementById('equityChart');
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 420);
      gradient.addColorStop(0, 'rgba(0, 230, 118, 0.28)');
      gradient.addColorStop(1, 'rgba(0, 230, 118, 0.02)');

      new Chart(ctx, {
        type: 'line',
        data: {
          labels: LABELS,
          datasets: [
            {
              label: 'Balance (USDT)',
              data: EQUITY,
              borderWidth: 2,
              pointRadius: 0,
              pointHitRadius: 12,
              tension: 0.15,
              fill: true,
              backgroundColor: gradient,
              // Colour each segment by whether the account was underwater at that point
              segment: {
                borderColor: (seg) => {
                  const idx = typeof seg.p1DataIndex === 'number' ? seg.p1DataIndex : 0;
                  return DRAWDOWN[idx] > 0.0001 ? RED : GREEN;
                }
              },
              yAxisID: 'y'
            },
            {
              label: 'Running Peak',
              data: PEAK,
              borderColor: 'rgba(158, 158, 158, 0.85)',
              borderWidth: 1,
              borderDash: [6, 4],
              pointRadius: 0,
              fill: false,
              tension: 0,
              yAxisID: 'y'
            },
            {
              label: 'Closed Drawdown %',
              data: DRAWDOWN,
              borderColor: 'rgba(255, 82, 82, 0.6)',
              borderWidth: 1,
              pointRadius: 0,
              pointHitRadius: 12,
              fill: false,
              tension: 0.1,
              yAxisID: 'y1'
            },
            {
              label: 'Max Floating Drawdown',
              // Flat reference line at the deepest intra-trade equity dip. Hidden
              // entirely when the simulator recorded no drawdown, so an all-time-high
              // run does not get a meaningless line pinned to 0%.
              data: HAS_FLOATING_DRAWDOWN ? LABELS.map(() => MAX_FLOATING_DRAWDOWN) : [],
              borderColor: 'rgba(255, 0, 0, 0.5)',
              borderDash: [5, 5],
              borderWidth: 1,
              pointRadius: 0,
              pointHitRadius: 12,
              fill: false,
              tension: 0,
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              labels: { color: '#f5f5f5', usePointStyle: true, boxWidth: 8, font: { size: 11 } }
            },
            tooltip: {
              callbacks: {
                label: (item) => {
                  if (item.dataset.yAxisID === 'y1') {
                    const depth = Number(item.parsed.y);
                    const formatted = (depth === 0 ? '0.00' : '-' + Math.abs(depth).toFixed(2)) + '%';
                    // Both y1 datasets share the same formatting but must stay
                    // distinguishable in the tooltip, otherwise the flat reference
                    // line is mistaken for a duplicate of the closed line.
                    const prefix = item.dataset.label === 'Max Floating Drawdown'
                      ? 'Max Floating Drawdown: '
                      : 'Closed Drawdown: ';
                    return prefix + formatted;
                  }
                  return item.dataset.label + ': $' + Number(item.parsed.y).toFixed(2);
                }
              }
            }
          },
          scales: {
            x: {
              ticks: {
                color: '#9e9e9e',
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 10,
                font: { size: 10 }
              },
              grid: { color: 'rgba(255,255,255,0.04)' }
            },
            y: {
              position: 'left',
              ticks: {
                color: '#9e9e9e',
                font: { size: 10 },
                callback: (v) => '$' + Number(v).toLocaleString()
              },
              grid: { color: 'rgba(255,255,255,0.07)' }
            },
            y1: {
              type: 'linear',
              position: 'right',
              // Reversed secondary axis: 0% at the top, deeper drawdowns point downwards.
              // min: 0 pins the top edge even when every trade is a new high (no drawdown),
              // where Chart.js would otherwise expand the domain to -1..1.
              reverse: true,
              min: 0,
              suggestedMin: 0,
              // 20% headroom below the deepest drawdown (computed in TS) so the red
              // line can never be clipped by the bottom edge of the chart.
              suggestedMax: ${drawdownAxisMaxLiteral},
              ticks: {
                color: 'rgba(255,82,82,0.75)',
                font: { size: 10 },
                callback: (v) => {
                  const depth = Number(v);
                  return (depth === 0 ? '' : '-') + Math.abs(depth).toFixed(1) + '%';
                }
              },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    }

    // ─── TradingView Lightweight Charts: price action + trade markers ───
    // Independent from the Chart.js renderer above: a CDN failure on one
    // library must never blank out the other panel.
    function renderTradeChart() {
      const container = document.getElementById('tvchart');
      if (!container) return;

      if (typeof LightweightCharts === 'undefined') {
        container.innerHTML = '<div class="tv-empty">Lightweight Charts could not be loaded from the CDN. Open this file with an internet connection to render the price chart.</div>';
        return;
      }
      if (CANDLE_DATA.length === 0) {
        container.innerHTML = '<div class="tv-empty">No LTF candles were captured for this backtest window.</div>';
        return;
      }

      const chartOptions = {
        autoSize: true,
        layout: { textColor: '#d1d5db', background: { type: 'solid', color: '#18181b' } },
        grid: { vertLines: { color: '#27272a' }, horzLines: { color: '#27272a' } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#27272a' },
        rightPriceScale: { borderColor: '#27272a' }
      };

      const chart = LightweightCharts.createChart(container, chartOptions);

      const seriesOptions = {
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444'
      };

      // Lightweight Charts v5 replaced addCandlestickSeries() with addSeries().
      // Both branches are kept so the artifact survives a CDN version bump.
      const series = typeof chart.addSeries === 'function' && LightweightCharts.CandlestickSeries
        ? chart.addSeries(LightweightCharts.CandlestickSeries, seriesOptions)
        : chart.addCandlestickSeries(seriesOptions);

      series.setData(CANDLE_DATA);

      if (MARKER_DATA.length > 0) {
        // v5 exposes markers as a primitive; v4 keeps them on the series.
        if (typeof LightweightCharts.createSeriesMarkers === 'function') {
          LightweightCharts.createSeriesMarkers(series, MARKER_DATA);
        } else if (typeof series.setMarkers === 'function') {
          series.setMarkers(MARKER_DATA);
        }
      }

      chart.timeScale().fitContent();
    }

    function renderAll() {
      render();
      renderTradeChart();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderAll);
    } else {
      renderAll();
    }
  </script>
</body>
</html>
`;
}

/**
 * Sanitizes a symbol for safe use inside a filename.
 * Bybit symbols are alphanumeric, but this guards against path traversal and
 * OS-reserved characters if a symbol ever arrives from an untrusted source.
 */
function sanitizeFilenamePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : 'UNKNOWN';
}

/**
 * Writes the text report and the HTML equity curve into `dataDir`.
 * Both files are per-symbol, so multi-symbol runs never clobber each other.
 */
export function writeBacktestArtifacts(
  symbol: string,
  initialBalance: Decimal,
  finalBalance: Decimal,
  trades: TradeResult[],
  periodStart: Date,
  periodEnd: Date,
  totalDays: number,
  maxDrawdown: Decimal,
  dataDir = 'data',
  candles: any[] = []
): BacktestArtifacts {
  const dir = path.resolve(process.cwd(), dataDir);
  fs.mkdirSync(dir, { recursive: true });

  const report = generateReport(
    symbol,
    initialBalance,
    finalBalance,
    trades,
    periodStart,
    periodEnd,
    totalDays,
    maxDrawdown
  );
  const chart = generateEquityCurveHtml(
    symbol,
    initialBalance,
    finalBalance,
    trades,
    periodStart,
    periodEnd,
    maxDrawdown,
    candles
  );

  const fileSymbol = sanitizeFilenamePart(symbol);
  const reportPath = path.join(dir, `Backtest_Report_${fileSymbol}.txt`);
  const chartPath = path.join(dir, `Backtest_Chart_${fileSymbol}.html`);

  fs.writeFileSync(reportPath, report, 'utf-8');
  fs.writeFileSync(chartPath, chart, 'utf-8');

  return { reportPath, chartPath };
}