import "dotenv/config";
import { DateTime } from "luxon";
import { BybitClient } from "../api/bybitClient";
import { PatternRecognizer, createPatternConfigFromBotConfig } from "../smc/patternRecognizer";
import type { PatternData } from "../smc/patternRecognizer";
import { ScenarioRouter } from "../engine/scenarioRouter";
import type { RouterResult } from "../engine/scenarioRouter";
import { loadConfig, resolveLimitExpirationCandles, resolveSymbolConfig } from "../config/env";
import { logger } from "../utils/logger";
import { Candle } from "../types";
import { candleCloseTime, timeframeLabel, timeframeToMinutes } from "../utils/timeframe";
import { InstrumentInfo } from "./executionSimulator";
import { Decimal } from "decimal.js";
import { formatPrice } from "../utils/precision";
import { shouldUseMarketEntry } from "../config/fees";
import { loadCachedOrFetch, getTimeRangeForDays } from "./historyLoader";
import {
  loadCandlesFromCSV,
  detectCsvIntervalMinutes,
  aggregateCandles,
} from "./csvLoader";
import { resolveOfflineInstrument } from "./offlineInstruments";
import {
  openTrade,
  checkAndCloseTrade,
  getInitialState,
  TradeResult,
} from "./executionSimulator";
import type { BacktestState } from "./executionSimulator";
import { printReport, writeBacktestArtifacts, resetScenarioRejectionStats } from "./reporter";
import { CalendarMacro } from "./calendarMacro";

/**
 * Live `CandleFeed` capacities — the backtester MUST feed `buildPatternData()`
 * the identical lookback window, otherwise scenarios 1/5/9 see different 4H
 * structures than the deployed engine.
 *
 *  - LTF / HTF: `historyCandles` closed candles (StrategyEngine constructor).
 *  - Sniper 1m feed: hardcoded to 300 candles (5 hours) in StrategyEngine.
 */
const SNIPER_1M_WINDOW = 300;

/**
 * Minimum candles per timeframe before evaluation — mirrors the guard in
 * `StrategyEngine.process()` (`candlesLtf.length < 20 || candlesHtf.length < 20`).
 * Live scans as soon as 20 candles exist; a larger backtest-only gate would
 * suppress setups the live engine would have taken.
 */
const MIN_PATTERN_CANDLES = 20;

function parseArgs(config: any): string[] {
  const args = process.argv.slice(2);
  const targetSymbol = args.find((a) => !a.startsWith("-"));
  if (targetSymbol) {
    return [targetSymbol];
  }
  return config.symbols;
}

function cleanupMemory(
  candlesHtf: any[],
  candles1m: any[],
  router: any,
  _recognizer: any,
): void {
  // LTF candles are intentionally NOT cleared here: they are handed back to the
  // caller to render the price chart in the HTML artifact. HTF/1m buffers are
  // dead weight after the simulation loop.
  if (candlesHtf) candlesHtf.length = 0;
  if (candles1m) candles1m.length = 0;
  if (router) {
    router.scenarios = [];
    router.patternRecognizer = null;
  }
  if (global.gc) global.gc();
}

function requiredLtfWarmup(historyCandles: number, ltfMinutes: number, htfMinutes: number): number {
  const candlesPerWeek = Math.ceil(timeframeToMinutes("W") / ltfMinutes);
  return Math.max(historyCandles, candlesPerWeek + 1, Math.ceil(MIN_PATTERN_CANDLES * htfMinutes / ltfMinutes));
}

/**
 * Burn a rejected setup exactly like live `StrategyEngine.burnSetup()`:
 * the trigger zone and structure are added to the mitigation lists so the
 * router cannot re-detect the same dead setup on the next candle.
 *
 * Macro liquidity pools (PDH/PDL/PWH/PWL) are never carried in `zoneDetails`
 * by design — Scenario 12 emits only `structureDetails` (Invariant 21).
 */
function burnBacktestSetup(
  state: BacktestState,
  routerResult: RouterResult,
  side: "Buy" | "Sell",
): void {
  const zone = routerResult.zoneDetails;
  if (zone) {
    state.mitigatedZones.push({
      type: zone.type,
      top: zone.top.toString(),
      bottom: zone.bottom.toString(),
      timeframe: zone.timeframe,
      direction: zone.direction,
      timestamp: zone.timestamp,
    });
    if (state.mitigatedZones.length > 100) {
      state.mitigatedZones = state.mitigatedZones.slice(-100);
    }
  }

  const structure = routerResult.structureDetails;
  if (structure && structure.timestamp > 0) {
    state.mitigatedStructures.push({
      type: structure.type ?? "CHoCH",
      timestamp: structure.timestamp,
      price: structure.price
        ? structure.price.toString()
        : String(routerResult.levels?.entry ?? "0"),
      direction:
        structure.direction ?? (side === "Buy" ? "BULLISH" : "BEARISH"),
    });
    if (state.mitigatedStructures.length > 100) {
      state.mitigatedStructures = state.mitigatedStructures.slice(-100);
    }
  }
}

async function runBacktestForSymbol(
  symbol: string,
  instrument: InstrumentInfo,
  recognizer: PatternRecognizer,
  candlesLtf: Candle[],
  candlesHtf: Candle[],
  candles1m: Candle[],
  config: ReturnType<typeof loadConfig> & {
    enableSniperMode?: boolean;
  },
  /**
   * Number of warmup LTF candles prepended before the simulated/report period.
   * They are pattern CONTEXT only (live boots with a fully preloaded
   * CandleFeed) — the loop starts at this index so warmup candles are never
   * traded and the report period still matches `BACKTEST_DAYS`.
   */
  ltfWarmupCount: number = 0,
): Promise<{ trades: TradeResult[]; maxDrawdown: Decimal }> {
  const state = getInitialState();
  const results: TradeResult[] = [];
  let preflightSkipped = 0;

  const symbolScenarios =
    config.symbolScenarios?.get(symbol) ?? config.activeScenarios;
  logger.warn(
    `[${symbol}] Active scenarios for backtest: ${symbolScenarios.join(",")}`,
  );

  // Asset-specific calibration is applied ONCE here and consumed by both the router
  // (scenario evaluation + tpResolver inputs) and the execution simulator (limit
  // lifetime). Resolving twice would risk the two disagreeing.
  const symbolConfig = resolveSymbolConfig(config, symbol);

  const router = new ScenarioRouter({
    symbol,
    patternRecognizer: recognizer,
    notifier: { sendMessage: async () => false } as any,
    activeScenarios: symbolScenarios,
    config: symbolConfig as any,
  });

  let cachedPatternData: PatternData | null = null;
  let ltfEnd = 0;
  let htfEnd = 0;
  let utcDay: number | undefined;
  let utcHour: number | undefined;
  const macro = new CalendarMacro();

  logger.level = "warn";

  const useSniperMode =
    config.enableSniperMode === true && candles1m.length > 0;

  // === PATTERN WINDOW PARITY (live CandleFeed capacities) ===
  // Live feeds buildPatternData() the last `historyCandles` CLOSED candles for
  // BOTH LTF and HTF — `CandleFeed.getCandles()` never exposes the forming
  // candle. This keeps the market structure window aligned with live.
  const historyWindow = config.historyCandles ?? 200;
  const { ltfTimeframe, htfTimeframe } = config;
  const dayMs = timeframeToMinutes("D") * 60_000;

  const mainCandles = useSniperMode ? candles1m : candlesLtf;

  // Warmup candles exist only as pattern context: the simulated/report period
  // starts at the first candle of the requested range. Sniper mode drives the
  // loop with the 1m series, which is loaded without warmup.
  const loopStart = useSniperMode
    ? 0
    : Math.max(0, Math.min(ltfWarmupCount, mainCandles.length));

  logger.warn(
    `[${symbol}] Starting backtest loop over ${mainCandles.length - loopStart} ${timeframeLabel(useSniperMode ? "1" : ltfTimeframe)} candles...`,
  );

  for (let i = loopStart; i < mainCandles.length; i++) {
    if (i % (useSniperMode ? 10000 : 1000) === 0) {
      logger.warn(
        `[${symbol}] Processing candle ${i}/${mainCandles.length} (${((i / mainCandles.length) * 100).toFixed(1)}%)`,
      );
    }

    const currentCandle = mainCandles[i];
    const candleTime = currentCandle.timestamp;

    // Consume warmup and trading history alike. A source timestamp denotes the
    // OPEN of its bar; an extreme is visible only once that bar has closed.
    const evalCloseTime = candleCloseTime(candleTime, useSniperMode ? "1" : ltfTimeframe);
    const previousLtfEnd = ltfEnd;
    const previousHtfEnd = htfEnd;
    while (ltfEnd < candlesLtf.length && candleCloseTime(candlesLtf[ltfEnd].timestamp, ltfTimeframe) <= evalCloseTime) {
      macro.addClosed(candlesLtf[ltfEnd++]);
    }
    while (htfEnd < candlesHtf.length && candleCloseTime(candlesHtf[htfEnd].timestamp, htfTimeframe) <= evalCloseTime) {
      htfEnd++;
    }

    const day = Math.floor(candleTime / dayMs);
    if (day !== utcDay) {
      utcDay = day;
      // The open of an in-progress LTF bar is visible; its high/low are not.
      const nextLtf = candlesLtf[ltfEnd];
      const firstOpen = nextLtf && nextLtf.timestamp <= candleTime &&
        Math.floor(nextLtf.timestamp / dayMs) === day ? nextLtf : currentCandle;
      recognizer.setMacroContext(symbol, macro.snapshot(firstOpen));
      cachedPatternData = null;
    }
    // London/NY/Asian killzones change on whole hours, including when the
    // last available LTF candle predates the session transition.
    const hour = Math.floor(candleTime / 3600_000);
    if (hour !== utcHour) {
      utcHour = hour;
      cachedPatternData = null;
    }
    if (ltfEnd !== previousLtfEnd || htfEnd !== previousHtfEnd) cachedPatternData = null;

    // === ЖЕСТКАЯ ПРОВЕРКА ОТКРЫТОЙ СДЕЛКИ ===
    if (state.openTrade || state.pendingLimitOrder) {
      if (
        (state.openTrade && state.openTrade.entryTime !== candleTime) ||
        state.pendingLimitOrder
      ) {
        const { state: stateAfterCheck, tradeResult } = checkAndCloseTrade(
          state,
          currentCandle,
          {
            cooldownCandles: config.cooldownCandles,
            ltfTimeframe: config.ltfTimeframe,
            // Effective lifetime in EXECUTION candles: Sniper counts 1m candles,
            // Classic counts LTF candles. Resolved centrally so live and backtest
            // agree, from the SYMBOL-resolved config so a per-symbol lifetime holds.
            limitExpirationCandles: resolveLimitExpirationCandles(symbolConfig),
            enableSniperMode: config.enableSniperMode,
          },
          instrument,
          symbol,
        );

        Object.assign(state, stateAfterCheck);

        if (tradeResult) {
          results.push(tradeResult);
        }
      }
      if (state.openTrade || state.pendingLimitOrder) continue;
    }

    // The router applies mitigation to copies. Rebuild the base pattern only
    // when closed history or the calendar context changes.
    if (
      state.cooldownUntil <= candleTime &&
      Math.min(ltfEnd, historyWindow) >= MIN_PATTERN_CANDLES &&
      Math.min(htfEnd, historyWindow) >= MIN_PATTERN_CANDLES
    ) {
      cachedPatternData ??= await recognizer.buildPatternData(
        symbol,
        candlesLtf.slice(Math.max(0, ltfEnd - historyWindow), ltfEnd),
        candlesHtf.slice(Math.max(0, htfEnd - historyWindow), htfEnd),
        candleTime,
      );
      const candles1mForRouter = useSniperMode
        ? candles1m.slice(Math.max(0, i + 1 - SNIPER_1M_WINDOW), i + 1)
        : [];
      const routerResult = await router.evaluate(
        cachedPatternData.candles15m,
        cachedPatternData.candles4h,
        candleTime,
        state.mitigatedZones,
        state.mitigatedStructures,
        candles1mForRouter,
        cachedPatternData,
      );

        try {
          if (
            routerResult.triggered &&
            routerResult.levels &&
            (routerResult.zoneDetails || routerResult.structureDetails)
          ) {
            const levels = routerResult.levels;
            const idealEntry = new Decimal(levels.entry);
            const slDecimal = new Decimal(levels.stopLoss);
            const tpDecimal = new Decimal(levels.takeProfit);
            // STRICT MATHEMATICAL SIDE (Invariant 16.10): math never lies.
            // Text labels (zoneDetails/structureDetails.direction) are never used.
            const side = idealEntry.gt(slDecimal) ? "Buy" : "Sell";
            const isLong = side === "Buy";

            const currentPrice = new Decimal(currentCandle.close);

            // === PRE-FLIGHT GUARDS (live parity: executeStagedEntry / handleTradeApproval) ===
            // The setup is evaluated at the candle close and a Market order fills at
            // that same price. If price has already crossed the SL (or reached the
            // TP), the setup is dead: live burns it and never sends the order.
            // Without this guard a Market fill can produce invalid SL geometry
            // (e.g. Sell with SL below entry) and the simulator assertion throws on
            // every subsequent candle.
            const preflightBuffer = currentPrice.mul(
              new Decimal(config.preflightBufferPct || "0.0005"),
            );
            const slBreached = isLong
              ? currentPrice.lte(slDecimal.plus(preflightBuffer))
              : currentPrice.gte(slDecimal.minus(preflightBuffer));

            if (slBreached) {
              logger.debug(
                `[${symbol}] Pre-flight DEAD SETUP at ${new Date(currentCandle.timestamp).toISOString()}: price ${currentPrice} breached SL ${slDecimal}. Burning and skipping.`,
              );
              preflightSkipped++;
              burnBacktestSetup(state, routerResult, side);
              continue;
            }

            const tpReached = isLong
              ? currentPrice.gte(tpDecimal)
              : currentPrice.lte(tpDecimal);

            if (tpReached) {
              logger.debug(
                `[${symbol}] Pre-flight DEAD SETUP at ${new Date(currentCandle.timestamp).toISOString()}: price ${currentPrice} already reached TP ${tpDecimal}. Burning and skipping.`,
              );
              preflightSkipped++;
              burnBacktestSetup(state, routerResult, side);
              continue;
            }

            // Hybrid Smart Entry — parity with live execution.
            // Any favorable discount uses Market (Discount Trap). At-entry and
            // adverse movement can use Market only inside the tight threshold.
            const threshold = new Decimal(
              config.smartEntryThresholdPct || "0.0015",
            );
            const useMarket = shouldUseMarketEntry(
              idealEntry,
              currentPrice,
              isLong,
              threshold,
            );

            const orderType: "Market" | "Limit" = useMarket
              ? "Market"
              : "Limit";
            const limitPrice = useMarket
              ? undefined
              : new Decimal(
                  formatPrice(idealEntry, new Decimal(instrument.tickSize)),
                );
            // Market fills at the current price (parity with exchange avgPrice);
            // Limit waits for a pullback to the zone equilibrium.
            const entryPriceDecimal = useMarket ? currentPrice : idealEntry;

            const { state: newState } = openTrade(
              state,
              currentCandle,
              entryPriceDecimal,
              slDecimal,
              tpDecimal,
              side,
              routerResult.scenario!.id,
              routerResult.scenario!.name,
              instrument,
              routerResult.zoneDetails ?? undefined,
              routerResult.structureDetails ?? undefined,
              orderType,
              limitPrice,
              symbol,
              new Decimal(config.maxWorkingCapital || 0),
              {
                leverage: config.leverage,
                riskPercent: config.riskPercent,
                reducedRiskPercent: config.reducedRiskPercent,
              },
            );

            logger.warn(
              `[${symbol}] Scenario ${routerResult.scenario!.id} signal at ${new Date(candleTime).toISOString()} | ${orderType} entry=${entryPriceDecimal.toString()} live=${currentPrice.toString()} SL=${slDecimal.toString()} TP=${tpDecimal.toString()} | filled=${!!newState.openTrade}`,
            );

            // Commit the state even when tradeOpened === false: the Limit branch
            // returns false (not filled yet) but still carries pendingLimitOrder
            // and the burned mitigation anchors. The old `if (tradeOpened)` guard
            // silently discarded every Limit setup.
            Object.assign(state, newState);
          }
        } catch (err) {
          logger.error(`[${symbol}] Backtest ERROR at index ${i} | ${err}`);
        }
      }
    }

  if (preflightSkipped > 0) {
    logger.warn(
      `[${symbol}] Pre-flight skipped ${preflightSkipped} dead setup(s) (SL breach / TP reached).`,
    );
  }

  logger.warn(
    `[${symbol}] End state: closedTrades=${results.length} | openPosition=${state.openTrade ? state.openTrade.side : 'none'} | pendingLimit=${state.pendingLimitOrder ? state.pendingLimitOrder.limitPrice.toString() : 'none'}`,
  );

  logger.info(
    `[${symbol}] Backtest finished successfully. Processed ${mainCandles.length - loopStart} candles, generated ${results.length} trades. Max Drawdown: ${state.maxDrawdown.toFixed(2)}%`,
  );
  cleanupMemory(candlesHtf, candles1m, router, null);
  return { trades: results, maxDrawdown: state.maxDrawdown };
}

/**
 * Offline `BybitClient` guard for CSV mode.
 *
 * `PatternRecognizer` only needs a client for `initializeMacroContext()`, which
 * the dynamic backtester never calls (macro context is rebuilt causally from
 * the candle stream). Any accidental network call therefore hits this proxy
 * and fails loudly instead of silently reaching Bybit.
 */
function createOfflineBybitClient(): BybitClient {
  return new Proxy({} as BybitClient, {
    get: (_target, property) => {
      throw new Error(
        `Network access is disabled in CSV backtest mode (BybitClient.${String(property)} was requested).`,
      );
    },
  });
}

/**
 * Full CSV backtest branch.
 *
 * Contract:
 *  - exactly one symbol per file (a warning is emitted when more are queued);
 *  - Sniper Mode requires a raw 1m file and derives LTF/HTF by aggregation;
 *  - Classic mode requires the file interval to match `LTF_TIMEFRAME`;
 *  - zero network calls: instrument specs come from `resolveOfflineInstrument`.
 */
async function runCsvBacktest(
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const csvPath = config.backtestCsvPath;
  if (!csvPath) {
    throw new Error("CSV backtest requested without BACKTEST_CSV_PATH");
  }

  const requestedSymbols = parseArgs(config);
  const symbol = requestedSymbols[0];
  if (!symbol) {
    throw new Error("CSV backtest requires at least one symbol in SYMBOLS");
  }
  if (requestedSymbols.length > 1) {
    logger.warn(
      `[CSV MODE] ${requestedSymbols.length} symbols configured (${requestedSymbols.join(", ")}); ` +
        `CSV mode supports one file per run — using ${symbol}.`,
    );
  }

  logger.info(`[CSV MODE] Loading candles from ${csvPath} ...`);
  const rawCandles = loadCandlesFromCSV(csvPath);
  if (rawCandles.length < 2) {
    throw new Error(`[CSV MODE] ${csvPath} must contain at least 2 candles`);
  }

  const intervalMinutes = detectCsvIntervalMinutes(rawCandles);
  const ltfMinutes = timeframeToMinutes(config.ltfTimeframe);
  const htfMinutes = timeframeToMinutes(config.htfTimeframe);
  const sniperMode = config.enableSniperMode === true;

  if (sniperMode && intervalMinutes !== 1) {
    throw new Error(
      "Sniper Mode requires 1m CSV data. Please provide 1m CSV or set ENABLE_SNIPER_MODE=false",
    );
  }

  if (!sniperMode && intervalMinutes !== ltfMinutes) {
    throw new Error(
      `[CSV MODE] CSV interval is ${intervalMinutes}m but LTF_TIMEFRAME=${ltfMinutes}m. ` +
        `Provide ${ltfMinutes}m candles or set LTF_TIMEFRAME=${intervalMinutes}.`,
    );
  }

  logger.info(
    `[CSV MODE] ${rawCandles.length} candles loaded (${new Date(rawCandles[0].timestamp).toISOString()} → ` +
      `${new Date(rawCandles[rawCandles.length - 1].timestamp).toISOString()}, detected interval: ${intervalMinutes}m).`,
  );

  const candles1m = sniperMode ? rawCandles : [];
  const sourceEnd = candleCloseTime(rawCandles[rawCandles.length - 1].timestamp, sniperMode ? "1" : config.ltfTimeframe);
  const candlesLtf = sniperMode
    ? aggregateCandles(rawCandles, config.ltfTimeframe)
        .filter(c => candleCloseTime(c.timestamp, config.ltfTimeframe) <= sourceEnd)
    : rawCandles;
  const candlesHtf = aggregateCandles(candlesLtf, config.htfTimeframe)
    .filter(c => candleCloseTime(c.timestamp, config.htfTimeframe) <= sourceEnd);

  const ltfWarmup = requiredLtfWarmup(config.historyCandles, ltfMinutes, htfMinutes);
  if (candlesLtf.length < ltfWarmup) {
    throw new Error(
      `[CSV MODE] Insufficient warmup: ${candlesLtf.length} ${ltfMinutes}m candles, ` +
        `but at least ${ltfWarmup} are required for the configured history, weekly levels and HTF warmup.`,
    );
  }

  if (candlesHtf.length < MIN_PATTERN_CANDLES) {
    throw new Error(
      `[CSV MODE] Insufficient ${htfMinutes}m candles: ${candlesHtf.length}, ` +
        `at least ${MIN_PATTERN_CANDLES} are required.`,
    );
  }

  const instrument = resolveOfflineInstrument(symbol);
  const recognizer = new PatternRecognizer(createOfflineBybitClient(), createPatternConfigFromBotConfig(config));

  logger.warn(
    `[CSV MODE] Offline instrument for ${symbol}: tickSize=${instrument.tickSize}, qtyStep=${instrument.qtyStep}, ` +
      `minOrderQty=${instrument.minOrderQty}, maxOrderQty=${instrument.maxOrderQty}`,
  );
  logger.warn(
    `[CSV MODE] Network access is disabled — all market data comes from ${csvPath}.`,
  );

  // Rejection counters are static (class-level); reset before this run so the
  // report reflects only this CSV.
  resetScenarioRejectionStats();

  const result = await runBacktestForSymbol(
    symbol,
    instrument,
    recognizer,
    candlesLtf,
    candlesHtf,
    candles1m,
    config,
    0,
  );

  const trades = result.trades;
  const initialBalance = new Decimal("1000");
  const finalBalance = trades.reduce(
    (bal, t) => bal.plus(t.pnl),
    initialBalance,
  );
  const periodStart = new Date(candlesLtf[0].timestamp);
  const periodEnd = new Date(candlesLtf[candlesLtf.length - 1].timestamp);
  const periodDays = Math.max(
    1,
    Math.round(
      (periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000),
    ),
  );

  printReport(
    symbol,
    initialBalance,
    finalBalance,
    trades,
    periodStart,
    periodEnd,
    periodDays,
    result.maxDrawdown,
    candlesLtf,
  );

  try {
    const artifacts = writeBacktestArtifacts(
      symbol,
      initialBalance,
      finalBalance,
      trades,
      periodStart,
      periodEnd,
      periodDays,
      result.maxDrawdown,
      config.dataDir,
      candlesLtf,
    );
    logger.warn(`[${symbol}] Report saved: ${artifacts.reportPath}`);
    logger.warn(`[${symbol}] Equity curve saved: ${artifacts.chartPath}`);
  } catch (err) {
    logger.warn(
      `[${symbol}] Failed to write backtest artifacts: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (global.gc) global.gc();
}

async function main(): Promise<void> {
  logger.info("Starting SMC Backtester (V5 Capable)...");

  const config = loadConfig();
  const useCsvMode = config.backtestCsvPath !== null;

  let client: BybitClient | null = null;
  let instruments = new Map<string, InstrumentInfo>();
  let recognizer: PatternRecognizer;
  let symbolsToTest = parseArgs(config);

  if (useCsvMode) {
    await runCsvBacktest(config);
    logger.info("\nBacktest completed!");
    process.exit(0);
  } else {
    client = BybitClient.create(config as any);
    recognizer = new PatternRecognizer(client, createPatternConfigFromBotConfig(config));

    for (const symbol of symbolsToTest) {
      const info = await client.getInstrumentInfo(symbol);
      instruments.set(symbol, info);
    }

    const backtestDays = config.backtestDays;
    const { fromMs, toMs } = getTimeRangeForDays(backtestDays);
    logger.info(
      `[Backtest Range] BACKTEST_DAYS=${backtestDays} → ${new Date(fromMs).toISOString()} - ${new Date(toMs).toISOString()}`,
    );

    for (const symbol of symbolsToTest) {
      logger.info(`\n=== Backtesting ${symbol} ===`);

      const instrument = instruments.get(symbol);
      if (!instrument) continue;

      // Warmup preload: fetch extra LTF/HTF candles BEFORE the report window.
      // Live boots with a fully preloaded CandleFeed (historyCandles closed
      // candles per timeframe), so without the warmup the first ~200 HTF candles
      // of a run would be evaluated against a truncated pattern window (≈ 33 days
      // of a 60-day backtest). LTF warmup additionally guarantees a full 7-day
      // history for weekly macro levels. Warmup candles are CONTEXT ONLY:
      // `ltfWarmupCount` marks where the simulated/report period begins.
      const historyWindow = config.historyCandles;
      const ltfMinutes = timeframeToMinutes(config.ltfTimeframe);
      const htfMinutes = timeframeToMinutes(config.htfTimeframe);
      const ltfWarmupCandles = requiredLtfWarmup(historyWindow, ltfMinutes, htfMinutes);
      const ltfWarmupMs = ltfWarmupCandles * ltfMinutes * 60_000;
      const htfWarmupMs = Math.max(historyWindow, MIN_PATTERN_CANDLES) * htfMinutes * 60_000;
      // A rolling seven days may start halfway through the previous ISO week.
      const priorMonday = DateTime.fromMillis(fromMs, { zone: "utc" }).startOf("week").minus({ weeks: 1 }).toMillis();

      const [loadedLtf, candlesHtf] = await Promise.all([
        loadCachedOrFetch(
          client,
          symbol,
          config.ltfTimeframe,
          Math.min(fromMs - ltfWarmupMs, priorMonday),
          toMs,
          config.useLocalCacheOnly
        ),
        loadCachedOrFetch(
          client,
          symbol,
          config.htfTimeframe,
          fromMs - htfWarmupMs,
          toMs,
          config.useLocalCacheOnly
        ),
      ]);

      // The simulated/report period starts at `fromMs`; everything before is warmup.
      const candlesLtfWithWarmup = loadedLtf.filter(c => candleCloseTime(c.timestamp, config.ltfTimeframe) <= toMs);
      const firstTradingBar = candlesLtfWithWarmup.findIndex(c => c.timestamp >= fromMs);
      const ltfWarmupCount = firstTradingBar === -1 ? candlesLtfWithWarmup.length : firstTradingBar;
      const candlesLtf = candlesLtfWithWarmup.slice(ltfWarmupCount);
      if (ltfWarmupCount > 0) {
        logger.info(
          `[${symbol}] Pattern warmup preloaded: ${ltfWarmupCount} ${timeframeLabel(config.ltfTimeframe)} candles.`,
        );
      }
      if (ltfWarmupCount < ltfWarmupCandles) {
        logger.warn(
          `[${symbol}] LTF warmup covers only ${ltfWarmupCount}/${ltfWarmupCandles} candles; calendar levels may have incomplete history.`,
        );
      }

      const candles1m: Candle[] = [];
      if (config.enableSniperMode) {
        logger.info(
          `Fetching 1m candles for Sniper Mode (${backtestDays} days)...`,
        );
        const fetched1m = await loadCachedOrFetch(
          client,
          symbol,
          "1",
          fromMs,
          toMs,
          config.useLocalCacheOnly
        );
        // Memory-safe copy: spreading a long Sniper history (>~100k 1m candles)
        // into push() exceeds V8's argument stack and throws
        // "Maximum call stack size exceeded" AFTER the data was fetched.
        for (const candle of fetched1m) {
          if (candleCloseTime(candle.timestamp, "1") <= toMs) candles1m.push(candle);
        }
      }

      if (
        candlesLtf.length === 0 ||
        candlesHtf.length === 0 ||
        (config.enableSniperMode && candles1m.length === 0)
      ) {
        logger.warn(`Missing required candle data for ${symbol}, skipping`);
        continue;
      }

      // Rejection counters are static (class-level) and printReport() runs once per
      // symbol. Reset here so this symbol's report reflects only this symbol's run.
      resetScenarioRejectionStats();

      const result = await runBacktestForSymbol(
        symbol,
        instrument,
        recognizer,
        candlesLtfWithWarmup,
        candlesHtf,
        candles1m,
        config,
        ltfWarmupCount,
      );

      const trades = result.trades;
      const initialBalance = new Decimal("1000");
      const finalBalance = trades.reduce(
        (bal, t) => bal.plus(t.pnl),
        initialBalance,
      );

      printReport(
        symbol,
        initialBalance,
        finalBalance,
        trades,
        new Date(fromMs),
        new Date(toMs),
        Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)),
        result.maxDrawdown,
        candlesLtf,
      );

      // Persist artifacts (text report + HTML equity curve) to the data directory.
      // Non-fatal: a disk/permission error must never abort the whole backtest run.
      try {
        const artifacts = writeBacktestArtifacts(
          symbol,
          initialBalance,
          finalBalance,
          trades,
          new Date(fromMs),
          new Date(toMs),
          Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)),
          result.maxDrawdown,
          config.dataDir,
          candlesLtf,
        );
        logger.info(`[${symbol}] Report saved: ${artifacts.reportPath}`);
        logger.info(`[${symbol}] Equity curve saved: ${artifacts.chartPath}`);
      } catch (err) {
        logger.warn(
          `[${symbol}] Failed to write backtest artifacts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (global.gc) global.gc();
    }
    logger.info("\nBacktest completed!");
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error(
    `Backtest fatal error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
