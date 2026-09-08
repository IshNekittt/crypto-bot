import 'dotenv/config';
import { BybitClient } from '../api/bybitClient';
import { PatternRecognizer } from '../smc/patternRecognizer';
import { ScenarioRouter } from '../engine/scenarioRouter';
import { loadConfig } from '../config/env';
import { logger } from '../utils/logger';
import { Candle } from '../types';
import { InstrumentInfo } from './executionSimulator';
import { Decimal } from 'decimal.js';
import { loadCachedOrFetch, getTimeRangeForSixMonths } from './historyLoader';
import { openTrade, checkAndCloseTrade, getInitialState, TradeResult } from './executionSimulator';
import { printReport } from './reporter';
import { Scenario5_HTFLiquiditySweep } from '../engine/scenarios/Scenario5_HTFLiquiditySweep';

function parseArgs(config: any): string[] {
  const args = process.argv.slice(2);
  // Find the first argument that doesn't start with '-' (not a flag)
  const targetSymbol = args.find(a => !a.startsWith('-'));
  if (targetSymbol && config.symbols.includes(targetSymbol)) {
    return [targetSymbol];
  }
  return config.symbols;
}

function cleanupMemory(candles15m: any[], candles4h: any[], router: any, _recognizer: any): void {
  // Clear large arrays
  if (candles15m) candles15m.length = 0;
  if (candles4h) candles4h.length = 0;
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

async function runBacktestForSymbol(
  symbol: string,
  instrument: InstrumentInfo,
  recognizer: PatternRecognizer,
  candles15m: Candle[],
  candles4h: Candle[]
): Promise<{ trades: TradeResult[]; maxDrawdown: Decimal }> {
  const state = getInitialState();
  const results: TradeResult[] = [];
  const mitigatedZones: MitigatedZone[] = [];

  const fourHourMap = new Map<number, Candle>();
  for (const c of candles4h) {
    fourHourMap.set(c.timestamp, c);
  }

  const fourHourTimestamps = candles4h.map(c => c.timestamp).sort((a, b) => a - b);

  // Create router ONCE outside the loop (performance optimization)
  const router = new ScenarioRouter({
    symbol,
    patternRecognizer: recognizer,
    notifier: { sendMessage: async () => false } as any,
  });

  // Pattern data cache - avoid recomputing from scratch every candle
  let cachedPatternData: any = null;
  let cachedRouterResult: any = null;
  let lastCachedCandleIndex = -1;
  let lastCachedMitigatedZonesLength = 0;
  const CACHE_REBUILD_INTERVAL = 10; // Rebuild cache every N candles when no trade is open (reduced for accuracy)

  // Silence all info/debug logs - only keep warn for progress
  logger.level = 'warn';

  logger.warn(`[${symbol}] Starting backtest loop over ${candles15m.length} 15m candles...`);

  for (let i = 0; i < candles15m.length; i++) {
    // Progress logging every 1000 candles
    if (i % 1000 === 0) {
      logger.warn(`[${symbol}] Backtest processing candle ${i}/${candles15m.length} (${((i / candles15m.length) * 100).toFixed(1)}%)`);
    }

    const candle15m = candles15m[i];
    const candleTime = candle15m.timestamp;

    // HARD CHECK: If we have an open trade, ONLY check TP/SL. Skip ALL heavy math (router, patternRecognizer)
    if (state.openTrade) {
      if (state.openTrade.entryTime !== candleTime) {
        const { state: stateAfterCheck, tradeResult, mitigatedZone } = checkAndCloseTrade(state, candle15m);
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

    const valid4hTimestamps = fourHourTimestamps.filter(ts => ts <= candleTime);
    const current4hCandles = valid4hTimestamps.map(ts => fourHourMap.get(ts)!).filter(Boolean);

    if (current4hCandles.length < 50) continue;

    // Cache pattern data - only rebuild when mitigated zones change or every CACHE_REBUILD_INTERVAL candles
    const shouldRebuildCache = 
      cachedPatternData === null ||
      mitigatedZones.length !== lastCachedMitigatedZonesLength ||
      (i - lastCachedCandleIndex) >= CACHE_REBUILD_INTERVAL;

    if (shouldRebuildCache) {
      // SLIDING WINDOW: Only pass last 200 LTF candles and last 50 HTF candles
      const ltfStart = Math.max(0, i - 200 + 1);
      const currentLtfCandles = candles15m.slice(ltfStart, i + 1);
      
      // For HTF, we need last 50 candles up to current time
      const htfEndIdx = current4hCandles.length - 1;
      const htfStartIdx = Math.max(0, htfEndIdx - 50 + 1);
      const currentHtfWindow = current4hCandles.slice(htfStartIdx, htfEndIdx + 1);

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
            candle15m,
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
        logger.error(`[${symbol}] Backtest ERROR at index ${i} (${new Date(candleTime).toISOString()}) | Candle: O=${candle15m.open} H=${candle15m.high} L=${candle15m.low} C=${candle15m.close} V=${candle15m.volume} | Error: ${err instanceof Error ? err.message : String(err)}`);
        logger.error(`[${symbol}] Stack: ${err instanceof Error ? err.stack : 'no stack'}`);
        continue;
      }
  }

  logger.info(`[${symbol}] Backtest finished successfully. Processed ${candles15m.length} candles, generated ${results.length} trades. Max Drawdown: ${state.maxDrawdown.toFixed(2)}%`);
  // Cleanup memory after each symbol
  cleanupMemory(candles15m, candles4h, router, null);
  return { trades: results, maxDrawdown: state.maxDrawdown };
}

async function main(): Promise<void> {
  logger.info('Starting SMC Backtester...');

  const config = loadConfig();
  const client = BybitClient.create(config);

  const symbolsToTest = parseArgs(config);
  logger.info(`Testing symbols: ${symbolsToTest.join(', ')}`);

  const instruments = new Map<string, InstrumentInfo>();
  for (const symbol of symbolsToTest) {
    const info = await client.getInstrumentInfo(symbol);
    instruments.set(symbol, info);
  }

  const recognizer = new PatternRecognizer(client);

  const { fromMs, toMs } = getTimeRangeForSixMonths();
  logger.info(`Backtest period: ${new Date(fromMs).toISOString()} - ${new Date(toMs).toISOString()}`);

  for (const symbol of symbolsToTest) {
    logger.info(`\n=== Backtesting ${symbol} ===`);

    const instrument = instruments.get(symbol);
    if (!instrument) {
      logger.error(`No instrument info for ${symbol}`);
      continue;
    }

    const [candles15m, candles4h] = await Promise.all([
      loadCachedOrFetch(client, symbol, '15', fromMs, toMs),
      loadCachedOrFetch(client, symbol, '240', fromMs, toMs),
    ]);

    logger.info(`Loaded ${candles15m.length} 15m candles, ${candles4h.length} 4H candles for ${symbol}`);

    if (candles15m.length === 0 || candles4h.length === 0) {
      logger.warn(`No data for ${symbol}, skipping`);
      continue;
    }

    await recognizer.initializeMacroContext(symbol, config.macroCandles);

    const result = await runBacktestForSymbol(
      symbol,
      instrument,
      recognizer,
      candles15m,
      candles4h
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

    // Print Scenario 5 rejection stats
    const stats = Scenario5_HTFLiquiditySweep.getRejectionStats();
    console.log(`[DEBUG] Scenario 5 Rejection Stats: ${JSON.stringify(stats, null, 2)}`);
    Scenario5_HTFLiquiditySweep.resetStats();

    // Print PatternRecognizer displacement rejection stats
    const displacementRejections = recognizer.getDisplacementRejections();
    console.log(`[DEBUG] PatternRecognizer Displacement Rejections: ${displacementRejections}`);
    recognizer.resetDisplacementRejections();

    // Force cleanup between symbols to prevent memory leak
    if (global.gc) global.gc();
  }

  logger.info('\nBacktest completed!');
  process.exit(0);
}

main().catch(err => {
  logger.error(`Backtest fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});