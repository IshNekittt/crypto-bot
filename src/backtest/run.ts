import 'dotenv/config';
import { BybitClient } from '../api/bybitClient';
import { PatternRecognizer } from '../smc/patternRecognizer';
import { ScenarioRouter } from '../engine/scenarioRouter';
import { loadConfig } from '../config/env';
import { logger } from '../utils/logger';
import { Candle, Timeframe } from '../types';
import { InstrumentInfo } from './executionSimulator';
import { Decimal } from 'decimal.js';
import { loadCachedOrFetch, getTimeRangeForSixMonths } from './historyLoader';
import { openTrade, checkAndCloseTrade, getInitialState, TradeResult } from './executionSimulator';
import { printReport } from './reporter';
import { Scenario5_HTFLiquiditySweep } from '../engine/scenarios/Scenario5_HTFLiquiditySweep';
import { Scenario2_FVGFill } from '../engine/scenarios/Scenario2_FVGFill';
import { Scenario4_MitigationChain } from '../engine/scenarios/Scenario4_MitigationChain';
import { Scenario7_AMD } from '../engine/scenarios/Scenario7_AMD';
import { Scenario8_RangeDeviationReclaim } from '../engine/scenarios/Scenario8_RangeDeviationReclaim';
import { Scenario9_TurtleSoup } from '../engine/scenarios/Scenario9_TurtleSoup';
import { Scenario10_BreakerBlock } from '../engine/scenarios/Scenario10_BreakerBlock';
import { Scenario11_MitigationBlock } from '../engine/scenarios/Scenario11_MitigationBlock';
import { loadCandlesFromCSV, aggregateCandles } from './csvLoader';

function parseArgs(config: any): string[] {
  const args = process.argv.slice(2);
  // Find the first argument that doesn't start with '-' (not a flag)
  const targetSymbol = args.find(a => !a.startsWith('-'));
  if (targetSymbol && config.symbols.includes(targetSymbol)) {
    return [targetSymbol];
  }
  return config.symbols;
}

function cleanupMemory(candlesLtf: any[], candlesHtf: any[], router: any, _recognizer: any): void {
  // Clear large arrays
  if (candlesLtf) candlesLtf.length = 0;
  if (candlesHtf) candlesHtf.length = 0;
  // Clear router and recognizer references
  if (router) {
    router.scenarios = [];
    router.patternRecognizer = null;
  }
  // Force garbage collection hint
  if (global.gc) global.gc();
}

// Track mitigated zones across the backtest
interface MitigatedZone {
  type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
  top: string;
  bottom: string;
  timeframe: string;
  direction: string;
  timestamp: number;
}

// Calculate daily levels from LTF candles (sliding window of ~96 candles for 15m timeframe)
function calculateDailyLevels(candles: Candle[], ltfMinutes: number): { pdh: Decimal; pdl: Decimal; doPrice: Decimal } | null {
  const candlesPerDay = Math.floor(1440 / ltfMinutes);
  if (candles.length < candlesPerDay) return null;
  
  const yesterdayCandles = candles.slice(-candlesPerDay);
  let pdh = new Decimal(0);
  let pdl = new Decimal('Infinity');
  
  for (const c of yesterdayCandles) {
    const high = new Decimal(c.high);
    const low = new Decimal(c.low);
    if (high.gt(pdh)) pdh = high;
    if (low.lt(pdl)) pdl = low;
  }
  
  const doPrice = new Decimal(candles[candles.length - 1].open);
  return { pdh, pdl, doPrice };
}

// Calculate weekly levels from LTF candles (sliding window of ~96*7 candles)
function calculateWeeklyLevels(candles: Candle[], ltfMinutes: number): { pwh: Decimal; pwl: Decimal; woPrice: Decimal } | null {
  const candlesPerWeek = Math.floor((1440 * 7) / ltfMinutes);
  if (candles.length < candlesPerWeek) return null;
  
  const lastWeekCandles = candles.slice(-candlesPerWeek);
  let pwh = new Decimal(0);
  let pwl = new Decimal('Infinity');
  
  for (const c of lastWeekCandles) {
    const high = new Decimal(c.high);
    const low = new Decimal(c.low);
    if (high.gt(pwh)) pwh = high;
    if (low.lt(pwl)) pwl = low;
  }
  
  const woPrice = new Decimal(candles[candles.length - 1].open);
  return { pwh, pwl, woPrice };
}

async function runBacktestForSymbol(
  symbol: string,
  instrument: InstrumentInfo,
  recognizer: PatternRecognizer,
  candlesLtf: Candle[],
  candlesHtf: Candle[],
  ltfMinutes: number,
  config: ReturnType<typeof loadConfig>
): Promise<{ trades: TradeResult[]; maxDrawdown: Decimal }> {
  const state = getInitialState();
  const results: TradeResult[] = [];
  const mitigatedZones: MitigatedZone[] = [];

  const htfMap = new Map<number, Candle>();
  for (const c of candlesHtf) {
    htfMap.set(c.timestamp, c);
  }

  const htfTimestamps = candlesHtf.map(c => c.timestamp).sort((a, b) => a - b);

  // Use per-symbol scenarios (SCENARIOS_<SYMBOL>) or fall back to global ACTIVE_SCENARIOS
  const symbolScenarios = config.symbolScenarios?.get(symbol) ?? config.activeScenarios;
  logger.warn(`[${symbol}] Active scenarios for backtest: ${symbolScenarios.join(',')}`);

  // Create router ONCE outside the loop (performance optimization)
  const router = new ScenarioRouter({
    symbol,
    patternRecognizer: recognizer,
    notifier: { sendMessage: async () => false } as any,
    activeScenarios: symbolScenarios,
  });

  // Pattern data cache - avoid recomputing from scratch every candle
  let cachedPatternData: any = null;
  let cachedRouterResult: any = null;
  let lastCachedCandleIndex = -1;
  let lastCachedMitigatedZonesLength = 0;
  const CACHE_REBUILD_INTERVAL = 10; // Rebuild cache every N candles when no trade is open (reduced for accuracy)

  // Dynamic macro context tracking (lookahead-bias-free)
  let currentDayUtc = -1;
  let currentWeekUtc = -1;
  let runningAth = new Decimal(0);
  let runningAtl = new Decimal('Infinity');

  // Silence all info/debug logs - only keep warn for progress
  logger.level = 'warn';

  logger.warn(`[${symbol}] Starting backtest loop over ${candlesLtf.length} ${ltfMinutes}m candles...`);

  for (let i = 0; i < candlesLtf.length; i++) {
    // Progress logging every 1000 candles
    if (i % 1000 === 0) {
      logger.warn(`[${symbol}] Backtest processing candle ${i}/${candlesLtf.length} (${((i / candlesLtf.length) * 100).toFixed(1)}%)`);
    }

    const candleLtf = candlesLtf[i];
    const candleTime = candleLtf.timestamp;

    // === DYNAMIC MACRO CONTEXT UPDATE (no lookahead bias) ===
    const candleDate = new Date(candleTime);
    const candleDay = candleDate.getUTCDate();
    const candleWeek = Math.floor(candleTime / (7 * 24 * 60 * 60 * 1000));

    // Update running ATH/ATL with current candle (historical data only)
    const candleHigh = new Decimal(candleLtf.high);
    const candleLow = new Decimal(candleLtf.low);
    if (candleHigh.gt(runningAth)) runningAth = candleHigh;
    if (candleLow.lt(runningAtl)) runningAtl = candleLow;

    // Check for new day (00:00 UTC boundary)
    if (candleDay !== currentDayUtc) {
      currentDayUtc = candleDay;

      // Calculate yesterday's PDH/PDL from closed candles BEFORE current candle
      const dailyLevels = calculateDailyLevels(candlesLtf.slice(0, i), ltfMinutes);
      
      // Calculate weekly levels if new week (Monday)
      let pwh = new Decimal(0);
      let pwl = new Decimal(0);
      let wo = new Decimal(0);
      
      if (candleWeek !== currentWeekUtc) {
        currentWeekUtc = candleWeek;
        const weeklyLevels = calculateWeeklyLevels(candlesLtf.slice(0, i), ltfMinutes);
        if (weeklyLevels) {
          pwh = weeklyLevels.pwh;
          pwl = weeklyLevels.pwl;
          wo = weeklyLevels.woPrice;
        }
      } else {
        // Use existing weekly levels from cache
        const existing = recognizer.getMacroContext(symbol);
        pwh = existing?.weeklyLevels.pwh ?? new Decimal(0);
        pwl = existing?.weeklyLevels.pwl ?? new Decimal(0);
        wo = existing?.weeklyLevels.wo ?? new Decimal(0);
      }

      if (dailyLevels) {
        // Atomic update of macro context - no lookahead!
        recognizer.setMacroContext(symbol, {
          ath: runningAth,
          atl: runningAtl,
          htfFvgs: [],
          htfObs: [],
          weeklyLevels: { pwh, pwl, wo },
          dailyLevels: { 
            pdh: dailyLevels.pdh, 
            pdl: dailyLevels.pdl, 
            do: dailyLevels.doPrice 
          },
          liquidityPools: [
            { type: 'PDH', priceLevel: dailyLevels.pdh, points: [], isTaken: false, timestamp: candleTime },
            { type: 'PDL', priceLevel: dailyLevels.pdl, points: [], isTaken: false, timestamp: candleTime },
            { type: 'PWH', priceLevel: pwh, points: [], isTaken: false, timestamp: candleTime },
            { type: 'PWL', priceLevel: pwl, points: [], isTaken: false, timestamp: candleTime },
          ],
        });
      }
    }

    // HARD CHECK: If we have an open trade, ONLY check TP/SL. Skip ALL heavy math (router, patternRecognizer)
    if (state.openTrade) {
      if (state.openTrade.entryTime !== candleTime) {
        const { state: stateAfterCheck, tradeResult, mitigatedZone } = checkAndCloseTrade(state, candleLtf);
        Object.assign(state, stateAfterCheck);
        if (tradeResult) {
          results.push(tradeResult);
          if (mitigatedZone) {
            mitigatedZones.push(mitigatedZone);
          }
        }
      }
      // Still have open trade (didn't close), skip ALL signal evaluation
      if (state.openTrade) {
        continue;
      }
    }

    const validHtfTimestamps = htfTimestamps.filter(ts => ts <= candleTime);
    const currentHtfCandles = validHtfTimestamps.map(ts => htfMap.get(ts)!).filter(Boolean);

    if (currentHtfCandles.length < 50) continue;

    // Cache pattern data - only rebuild when mitigated zones change or every CACHE_REBUILD_INTERVAL candles
    const shouldRebuildCache = 
      cachedPatternData === null ||
      mitigatedZones.length !== lastCachedMitigatedZonesLength ||
      (i - lastCachedCandleIndex) >= CACHE_REBUILD_INTERVAL;

    if (shouldRebuildCache) {
      // SLIDING WINDOW: Only pass last 200 LTF candles and last 50 HTF candles
      const ltfStart = Math.max(0, i - 200 + 1);
      const currentLtfCandles = candlesLtf.slice(ltfStart, i + 1);
      
      // For HTF, we need last 50 candles up to current time
      const htfEndIdx = currentHtfCandles.length - 1;
      const htfStartIdx = Math.max(0, htfEndIdx - 50 + 1);
      const currentHtfWindow = currentHtfCandles.slice(htfStartIdx, htfEndIdx + 1);

      const routerResultForCache = await router.evaluate(
        currentLtfCandles,
        currentHtfWindow,
        candleTime,
        mitigatedZones
      );
      cachedPatternData = routerResultForCache;
      cachedRouterResult = routerResultForCache;
      lastCachedCandleIndex = i;
      lastCachedMitigatedZonesLength = mitigatedZones.length;
    }

    const routerResult = cachedRouterResult;

      try {
        if (routerResult.triggered && routerResult.levels) {
          const levels = routerResult.levels;
          const entryDecimal = new Decimal(levels.entry);
          const slDecimal = new Decimal(levels.stopLoss);
          const tpDecimal = new Decimal(levels.takeProfit);
          const side = entryDecimal.gt(slDecimal) ? 'Buy' : 'Sell';

          // Get zone details from the triggered scenario for mitigation tracking
          const zoneDetails = routerResult.zoneDetails ? {
            type: routerResult.zoneDetails.type,
            top: routerResult.zoneDetails.top,
            bottom: routerResult.zoneDetails.bottom,
            timeframe: routerResult.zoneDetails.timeframe,
            direction: routerResult.zoneDetails.direction,
            timestamp: routerResult.zoneDetails.timestamp,
          } : undefined;

          const { state: newState, tradeOpened } = openTrade(
            state,
            candleLtf,
            entryDecimal,
            slDecimal,
            tpDecimal,
            side,
            routerResult.scenario!.id,
            routerResult.scenario!.name,
            instrument,
            zoneDetails
          );

          if (tradeOpened) {
            Object.assign(state, newState);
          }
        }
      } catch (err) {
        logger.error(`[${symbol}] Backtest ERROR at index ${i} (${new Date(candleTime).toISOString()}) | Candle: O=${candleLtf.open} H=${candleLtf.high} L=${candleLtf.low} C=${candleLtf.close} V=${candleLtf.volume} | Error: ${err instanceof Error ? err.message : String(err)}`);
        logger.error(`[${symbol}] Stack: ${err instanceof Error ? err.stack : 'no stack'}`);
        continue;
      }
  }

  logger.info(`[${symbol}] Backtest finished successfully. Processed ${candlesLtf.length} candles, generated ${results.length} trades. Max Drawdown: ${state.maxDrawdown.toFixed(2)}%`);
  // Cleanup memory after each symbol
  cleanupMemory(candlesLtf, candlesHtf, router, null);
  return { trades: results, maxDrawdown: state.maxDrawdown };
}

async function main(): Promise<void> {
  logger.info('Starting SMC Backtester...');

  const config = loadConfig();
  
  // CSV MODE: Load from local CSV file instead of Bybit API
  const useCsvMode = config.backtestCsvPath !== null;
  
  let client: BybitClient | null = null;
  let instruments = new Map<string, InstrumentInfo>();
  let recognizer: PatternRecognizer;
  let symbolsToTest = parseArgs(config);

  if (useCsvMode) {
    logger.info(`CSV MODE: Loading data from ${config.backtestCsvPath}`);
    
    // In CSV mode, we only test the symbol from the CSV file
    // For simplicity, assume CSV contains single symbol data
    // We'll extract symbol from filename or use first symbol from config
    if (symbolsToTest.length === 0) {
      logger.error('No symbols specified in config for CSV mode');
      process.exit(1);
    }
    
    // Create dummy client for PatternRecognizer (won't be used for fetching)
    client = BybitClient.create(config);
    recognizer = new PatternRecognizer(client!);
    
// Load candles from CSV
    logger.info(`Loading candles from CSV...`);
    const candlesLtf = loadCandlesFromCSV(config.backtestCsvPath);
    logger.info(`Loaded ${candlesLtf.length} LTF candles from CSV`);
    logger.info(`First candle: ${new Date(candlesLtf[0].timestamp).toISOString()}, Last candle: ${new Date(candlesLtf[candlesLtf.length - 1].timestamp).toISOString()}`);
    
    if (candlesLtf.length === 0) {
      logger.error('No candles loaded from CSV');
      process.exit(1);
    }

    // Extract symbol from filename (e.g., EURUSD_15m.csv -> EURUSD)
    const path = require('path');
    const fileName = path.basename(config.backtestCsvPath);
    const symbol = fileName.split('_')[0] || 'EURUSD';
    
    // Get instrument info (we need this for precision)
    // In CSV mode, we might be testing forex pairs not on Bybit, so provide fallback
    client = BybitClient.create(config);
    let instrument: InstrumentInfo;
    try {
      instrument = await client.getInstrumentInfo(symbol);
      if (!instrument) {
        throw new Error(`Instrument ${symbol} not found`);
      }
    } catch {
      logger.warn(`Instrument ${symbol} not found on Bybit, using default forex instrument`);
      instrument = {
        symbol,
        tickSize: '0.0001',
        qtyStep: '0.01',
        minOrderQty: '0.01',
        maxOrderQty: '1000000',
      };
    }
    
    // Aggregate HTF candles from LTF using config timeframe
    const htfMinutes = Number(config.htfTimeframe) || 240;
    const candlesHtf = aggregateCandles(candlesLtf, htfMinutes);
    logger.info(`Aggregated ${candlesHtf.length} HTF candles from LTF data`);
    
    // For macro context, we need daily candles. Aggregate from LTF
    const dailyMinutes = 1440;
    const candlesDaily = aggregateCandles(candlesLtf, dailyMinutes);
    logger.info(`Aggregated ${candlesDaily.length} daily candles from LTF data`);
    
    // Also aggregate weekly candles for PWH/PWL macro levels
    const weeklyMinutes = 10080;
    const candlesWeekly = aggregateCandles(candlesLtf, weeklyMinutes);
    logger.info(`Aggregated ${candlesWeekly.length} weekly candles from LTF data`);
    
    // Initialize macro context with aggregated daily data
    // We'll create a mock client that returns our aggregated data
    const htfInterval = config.htfTimeframe.toString();
    const mockClient = {
      getKlines: async (_symbol: string, interval: string, _limit: number) => {
        if (interval === 'D') return candlesDaily;
        if (interval === 'W') return candlesWeekly;
        if (interval === htfInterval) return candlesHtf;
        return candlesLtf;
      },
    } as any;
    
    recognizer = new PatternRecognizer(mockClient);
    
    // Get date range from candles BEFORE running backtest (array gets cleared in cleanupMemory)
    const fromMs = candlesLtf[0]?.timestamp || Date.now();
    const toMs = candlesLtf[candlesLtf.length - 1]?.timestamp || Date.now();
    
    const result = await runBacktestForSymbol(
      symbol,
      instrument,
      recognizer,
      candlesLtf,
      candlesHtf,
      Number(config.ltfTimeframe),
      config
    );
    
    const trades = result.trades;
    const maxDrawdown = result.maxDrawdown;
    const initialBalance = new Decimal('1000');
    const finalBalance = trades.reduce((bal, t) => bal.plus(t.pnl), new Decimal('1000'));

    printReport(
      symbol,
      initialBalance,
      finalBalance,
      result.trades,
      new Date(fromMs),
      new Date(toMs),
      Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)),
      maxDrawdown
    );

    // Print rejection stats (like online mode)
    logger.info('=== CSV MODE REJECTION STATS ===');
    const stats2 = Scenario2_FVGFill.getRejectionStats();
    logger.info(`Scenario 2 (FVG Fill): ${JSON.stringify(stats2, null, 2)}`);
    Scenario2_FVGFill.resetStats();
    
    const stats4 = Scenario4_MitigationChain.getRejectionStats();
    logger.info(`Scenario 4 (Mitigation Chain): ${JSON.stringify(stats4, null, 2)}`);
    Scenario4_MitigationChain.resetStats();
    
    const stats5 = Scenario5_HTFLiquiditySweep.getRejectionStats();
    logger.info(`Scenario 5 (HTF Liquidity Sweep): ${JSON.stringify(stats5, null, 2)}`);
    Scenario5_HTFLiquiditySweep.resetStats();
    
    const stats7 = Scenario7_AMD.getRejectionStats();
    logger.info(`Scenario 7 (AMD): ${JSON.stringify(stats7, null, 2)}`);
    Scenario7_AMD.resetStats();
    
    const stats8 = Scenario8_RangeDeviationReclaim.getRejectionStats();
    logger.info(`Scenario 8 (Range Deviation): ${JSON.stringify(stats8, null, 2)}`);
    Scenario8_RangeDeviationReclaim.resetStats();
    
    const stats9 = Scenario9_TurtleSoup.getRejectionStats();
    logger.info(`Scenario 9 (Turtle Soup): ${JSON.stringify(stats9, null, 2)}`);
    Scenario9_TurtleSoup.resetStats();
    
    const stats10 = Scenario10_BreakerBlock.getRejectionStats();
    logger.info(`Scenario 10 (Breaker Block): ${JSON.stringify(stats10, null, 2)}`);
    Scenario10_BreakerBlock.resetStats();
    
    const stats11 = Scenario11_MitigationBlock.getRejectionStats();
    logger.info(`Scenario 11 (Mitigation Block): ${JSON.stringify(stats11, null, 2)}`);
    Scenario11_MitigationBlock.resetStats();
    
    // Print PatternRecognizer displacement rejection stats
    const displacementRejections = recognizer.getDisplacementRejections();
    logger.info(`PatternRecognizer Displacement Rejections: ${displacementRejections}`);
    recognizer.resetDisplacementRejections();

    logger.info('\nBacktest completed!');
    process.exit(0);
    
  } else {
    // ONLINE MODE: Original Bybit API logic
    client = BybitClient.create(config);
    recognizer = new PatternRecognizer(client);

    for (const symbol of symbolsToTest) {
      const info = await client.getInstrumentInfo(symbol);
      instruments.set(symbol, info);
    }

    const { fromMs, toMs } = getTimeRangeForSixMonths();
    logger.info(`Backtest period: ${new Date(fromMs).toISOString()} - ${new Date(toMs).toISOString()}`);

    // Dynamic candle count based on LTF timeframe (180 days)
    const ltfMinutes = Number(config.ltfTimeframe);
    const totalCandles = Math.ceil((180 * 24 * 60) / ltfMinutes);
    logger.info(`Expected ~${totalCandles} LTF candles for ${ltfMinutes}m timeframe over 180 days`);

    for (const symbol of symbolsToTest) {
      logger.info(`\n=== Backtesting ${symbol} ===`);

      const instrument = instruments.get(symbol);
      if (!instrument) {
        logger.error(`No instrument info for ${symbol}`);
        continue;
      }

      const [candlesLtf, candlesHtf] = await Promise.all([
        loadCachedOrFetch(client, symbol, config.ltfTimeframe as Timeframe, fromMs, toMs),
        loadCachedOrFetch(client, symbol, config.htfTimeframe as Timeframe, fromMs, toMs),
      ]);

      logger.info(`Loaded ${candlesLtf.length} ${config.ltfTimeframe}m candles, ${candlesHtf.length} ${config.htfTimeframe}m candles for ${symbol}`);

      if (candlesLtf.length === 0 || candlesHtf.length === 0) {
        logger.warn(`No data for ${symbol}, skipping`);
        continue;
      }

      const result = await runBacktestForSymbol(
        symbol,
        instrument,
        recognizer,
        candlesLtf,
        candlesHtf,
        ltfMinutes,
        config
      );
      const trades = result.trades;
      const maxDrawdown = result.maxDrawdown;

      const initialBalance = new Decimal('1000');
      const finalBalance = trades.reduce((bal, t) => bal.plus(t.pnl), initialBalance);

      printReport(
        symbol,
        initialBalance,
        finalBalance,
        trades,
        new Date(fromMs),
        new Date(toMs),
        Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)),
        maxDrawdown
      );

      // Print rejection stats for ALL scenarios (like CSV mode)
      logger.info('=== ONLINE MODE REJECTION STATS ===');
      const stats2 = Scenario2_FVGFill.getRejectionStats();
      logger.info(`Scenario 2 (FVG Fill): ${JSON.stringify(stats2, null, 2)}`);
      Scenario2_FVGFill.resetStats();
      
      const stats4 = Scenario4_MitigationChain.getRejectionStats();
      logger.info(`Scenario 4 (Mitigation Chain): ${JSON.stringify(stats4, null, 2)}`);
      Scenario4_MitigationChain.resetStats();
      
      const stats5 = Scenario5_HTFLiquiditySweep.getRejectionStats();
      logger.info(`Scenario 5 (HTF Liquidity Sweep): ${JSON.stringify(stats5, null, 2)}`);
      Scenario5_HTFLiquiditySweep.resetStats();
      
      const stats7 = Scenario7_AMD.getRejectionStats();
      logger.info(`Scenario 7 (AMD): ${JSON.stringify(stats7, null, 2)}`);
      Scenario7_AMD.resetStats();
      
      const stats8 = Scenario8_RangeDeviationReclaim.getRejectionStats();
      logger.info(`Scenario 8 (Range Deviation): ${JSON.stringify(stats8, null, 2)}`);
      Scenario8_RangeDeviationReclaim.resetStats();
      
      const stats9 = Scenario9_TurtleSoup.getRejectionStats();
      logger.info(`Scenario 9 (Turtle Soup): ${JSON.stringify(stats9, null, 2)}`);
      Scenario9_TurtleSoup.resetStats();
      
      const stats10 = Scenario10_BreakerBlock.getRejectionStats();
      logger.info(`Scenario 10 (Breaker Block): ${JSON.stringify(stats10, null, 2)}`);
      Scenario10_BreakerBlock.resetStats();
      
      const stats11 = Scenario11_MitigationBlock.getRejectionStats();
      logger.info(`Scenario 11 (Mitigation Block): ${JSON.stringify(stats11, null, 2)}`);
      Scenario11_MitigationBlock.resetStats();
      
      // Print PatternRecognizer displacement rejection stats
      const displacementRejections = recognizer.getDisplacementRejections();
      logger.info(`PatternRecognizer Displacement Rejections: ${displacementRejections}`);
      recognizer.resetDisplacementRejections();

      // Force cleanup between symbols to prevent memory leak
      if (global.gc) global.gc();
    }

    logger.info('\nBacktest completed!');
    process.exit(0);
  }
}

main().catch(err => {
  logger.error(`Backtest fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});