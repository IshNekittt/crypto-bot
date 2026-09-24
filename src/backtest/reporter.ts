import { Decimal } from 'decimal.js';
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

  // ─── Chronological Trade Calendar (Last 30 Days) ───
  if (trades.length > 0) {
    // Sort trades by entry time
    const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    
    // Get the last 30 days of the test period
    const periodEndMs = periodEnd.getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const startMs = periodEndMs - thirtyDaysMs;
    
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
    
    // Generate last 30 days calendar
    lines.push('🗓️ TRADE TIMELINE (Last 30 Days of Backtest) [Timezone: UTC]');
    for (let i = 0; i < 30; i++) {
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
  maxDrawdown: Decimal
): void {
  console.log(generateReport(symbol, initialBalance, finalBalance, trades, periodStart, periodEnd, totalDays, maxDrawdown));
}