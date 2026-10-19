import "dotenv/config";
import { BybitClient } from "../api/bybitClient";
import { PatternRecognizer } from "../smc/patternRecognizer";
import { ScenarioRouter } from "../engine/scenarioRouter";
import { loadConfig } from "../config/env";
import { logger } from "../utils/logger";
import { Candle, Timeframe } from "../types";
import { InstrumentInfo } from "./executionSimulator";
import { MitigatedStructure } from "../types";
import { Decimal } from "decimal.js";
import { loadCachedOrFetch, getTimeRangeForDays } from "./historyLoader";
import {
  openTrade,
  checkAndCloseTrade,
  getInitialState,
  TradeResult,
} from "./executionSimulator";
import { printReport, writeBacktestArtifacts } from "./reporter";

function parseArgs(config: any): string[] {
  const args = process.argv.slice(2);
  const targetSymbol = args.find((a) => !a.startsWith("-"));
  if (targetSymbol && config.symbols.includes(targetSymbol)) {
    return [targetSymbol];
  }
  return config.symbols;
}

function cleanupMemory(
  candlesLtf: any[],
  candlesHtf: any[],
  candles1m: any[],
  router: any,
  _recognizer: any,
): void {
  if (candlesLtf) candlesLtf.length = 0;
  if (candlesHtf) candlesHtf.length = 0;
  if (candles1m) candles1m.length = 0;
  if (router) {
    router.scenarios = [];
    router.patternRecognizer = null;
  }
  if (global.gc) global.gc();
}

interface MitigatedZone {
  type: "OB" | "FVG" | "BREAKER" | "MITIGATION";
  top: string;
  bottom: string;
  timeframe: string;
  direction: string;
  timestamp: number;
}

function calculateDailyLevels(
  candles: Candle[],
  ltfMinutes: number,
): { pdh: Decimal; pdl: Decimal; doPrice: Decimal } | null {
  const candlesPerDay = Math.floor(1440 / ltfMinutes);
  if (candles.length < candlesPerDay) return null;

  const yesterdayCandles = candles.slice(-candlesPerDay);
  let pdh = new Decimal(0);
  let pdl = new Decimal("Infinity");

  for (const c of yesterdayCandles) {
    const high = new Decimal(c.high);
    const low = new Decimal(c.low);
    if (high.gt(pdh)) pdh = high;
    if (low.lt(pdl)) pdl = low;
  }

  const doPrice = new Decimal(candles[candles.length - 1].open);
  return { pdh, pdl, doPrice };
}

function calculateWeeklyLevels(
  candles: Candle[],
  ltfMinutes: number,
): { pwh: Decimal; pwl: Decimal; woPrice: Decimal } | null {
  const candlesPerWeek = Math.floor((1440 * 7) / ltfMinutes);
  if (candles.length < candlesPerWeek) return null;

  const lastWeekCandles = candles.slice(-candlesPerWeek);
  let pwh = new Decimal(0);
  let pwl = new Decimal("Infinity");

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
  candles1m: Candle[],
  ltfMinutes: number,
  config: ReturnType<typeof loadConfig> & {
    enableSniperMode?: boolean;
  },
): Promise<{ trades: TradeResult[]; maxDrawdown: Decimal }> {
  const state = getInitialState();
  const results: TradeResult[] = [];
  const mitigatedZones: MitigatedZone[] = [];
  let mitigatedStructures: MitigatedStructure[] = [];

  const htfMap = new Map<number, Candle>();
  for (const c of candlesHtf) {
    htfMap.set(c.timestamp, c);
  }
  const htfTimestamps = candlesHtf
    .map((c) => c.timestamp)
    .sort((a, b) => a - b);

  const symbolScenarios =
    config.symbolScenarios?.get(symbol) ?? config.activeScenarios;
  logger.warn(
    `[${symbol}] Active scenarios for backtest: ${symbolScenarios.join(",")}`,
  );

  const router = new ScenarioRouter({
    symbol,
    patternRecognizer: recognizer,
    notifier: { sendMessage: async () => false } as any,
    activeScenarios: symbolScenarios,
    config: config as any,
  });

  // --- Кэширование PatternData (только 15m контекст) ---
  let cachedPatternData: any = null;
  let cachedRouterResult: any = null;
  let lastCachedMitigatedZonesLength = 0;
  let lastCachedMitigatedStructuresLength = 0;
  let currentHtfCandles: Candle[] = [];
  let currentLtfCandles: Candle[] = [];

  let currentDayUtc = -1;
  let currentWeekUtc = -1;
  let runningAth = new Decimal(0);
  let runningAtl = new Decimal("Infinity");

  logger.level = "warn";

  const useSniperMode =
    config.enableSniperMode === true && candles1m.length > 0;

  let index15m = 0;
  const mainCandles = useSniperMode ? candles1m : candlesLtf;

  logger.warn(
    `[${symbol}] Starting backtest loop over ${mainCandles.length} candles (Sniper Mode: ${useSniperMode ? "ON (1m)" : "OFF (15m)"})...`,
  );

  for (let i = 0; i < mainCandles.length; i++) {
    if (i % (useSniperMode ? 10000 : 1000) === 0) {
      logger.warn(
        `[${symbol}] Processing candle ${i}/${mainCandles.length} (${((i / mainCandles.length) * 100).toFixed(1)}%)`,
      );
    }

    const currentCandle = mainCandles[i];
    const candleTime = currentCandle.timestamp;

    // === СИНХРОНИЗАЦИЯ ТАЙМФРЕЙМОВ ===
    let isNew15mClose = false;
    let lastClosed15m: Candle | null = null;

    if (useSniperMode) {
      while (
        index15m + 1 < candlesLtf.length &&
        candlesLtf[index15m + 1].timestamp <= candleTime
      ) {
        index15m++;
        isNew15mClose = true;
      }
      lastClosed15m = index15m > 0 ? candlesLtf[index15m - 1] : null;
    } else {
      index15m = i;
      lastClosed15m = currentCandle;
      isNew15mClose = true;
    }

    // === МАКРО-КОНТЕКСТ (Обновляется по 15m свечам) ===
    if (lastClosed15m) {
      const candleDate = new Date(lastClosed15m.timestamp);
      const candleDay = candleDate.getUTCDate();
      const candleWeek = Math.floor(
        lastClosed15m.timestamp / (7 * 24 * 60 * 60 * 1000),
      );

      const candleHigh = new Decimal(lastClosed15m.high);
      const candleLow = new Decimal(lastClosed15m.low);
      if (candleHigh.gt(runningAth)) runningAth = candleHigh;
      if (candleLow.lt(runningAtl)) runningAtl = candleLow;

      if (candleDay !== currentDayUtc) {
        currentDayUtc = candleDay;
        const dailyLevels = calculateDailyLevels(
          candlesLtf.slice(0, index15m),
          ltfMinutes,
        );

        let pwh = new Decimal(0);
        let pwl = new Decimal(0);
        let wo = new Decimal(0);

        if (candleWeek !== currentWeekUtc) {
          currentWeekUtc = candleWeek;
          const weeklyLevels = calculateWeeklyLevels(
            candlesLtf.slice(0, index15m),
            ltfMinutes,
          );
          if (weeklyLevels) {
            pwh = weeklyLevels.pwh;
            pwl = weeklyLevels.pwl;
            wo = weeklyLevels.woPrice;
          }
        } else {
          const existing = recognizer.getMacroContext(symbol);
          pwh = existing?.weeklyLevels.pwh ?? new Decimal(0);
          pwl = existing?.weeklyLevels.pwl ?? new Decimal(0);
          wo = existing?.weeklyLevels.wo ?? new Decimal(0);
        }

        if (dailyLevels) {
          recognizer.setMacroContext(symbol, {
            ath: runningAth,
            atl: runningAtl,
            htfFvgs: [],
            htfObs: [],
            weeklyLevels: { pwh, pwl, wo },
            dailyLevels: {
              pdh: dailyLevels.pdh,
              pdl: dailyLevels.pdl,
              do: dailyLevels.doPrice,
            },
            liquidityPools: [
              {
                type: "PDH",
                priceLevel: dailyLevels.pdh,
                points: [],
                isTaken: false,
                timestamp: lastClosed15m.timestamp,
              },
              {
                type: "PDL",
                priceLevel: dailyLevels.pdl,
                points: [],
                isTaken: false,
                timestamp: lastClosed15m.timestamp,
              },
              {
                type: "PWH",
                priceLevel: pwh,
                points: [],
                isTaken: false,
                timestamp: lastClosed15m.timestamp,
              },
              {
                type: "PWL",
                priceLevel: pwl,
                points: [],
                isTaken: false,
                timestamp: lastClosed15m.timestamp,
              },
            ],
          });
        }
      }
    }

    // === ЖЕСТКАЯ ПРОВЕРКА ОТКРЫТОЙ СДЕЛКИ ===
    if (state.openTrade || state.pendingLimitOrder) {
      if (
        (state.openTrade && state.openTrade.entryTime !== candleTime) ||
        state.pendingLimitOrder
      ) {
        const {
          state: stateAfterCheck,
          tradeResult,
          mitigatedZone,
        } = checkAndCloseTrade(
          state,
          currentCandle,
          {
            cooldownCandles: config.cooldownCandles,
            ltfTimeframe: config.ltfTimeframe,
            limitExpirationCandles: config.limitExpirationCandles || 6,
          },
          instrument,
          symbol,
        );

        Object.assign(state, stateAfterCheck);
        mitigatedStructures = state.mitigatedStructures;

        if (tradeResult) {
          results.push(tradeResult);
          if (mitigatedZone) mitigatedZones.push(mitigatedZone);
        }
      }
      if (state.openTrade || state.pendingLimitOrder) continue;
    }

    // === СИГНАЛЬНЫЙ ДВИЖОК (Единый вызов Router) ===
    // В Sniper Mode: вызываем на каждой 1m свече, передаем свежие 1m свечи
    // В обычном режиме: только на закрытии 15m свечи
    const shouldEvaluateRouter = useSniperMode ? true : isNew15mClose;

    // Пересчитываем 15m/4H окна и PatternData ТОЛЬКО при новой 15m свече
    if (isNew15mClose && lastClosed15m) {
      const validHtfTimestamps = htfTimestamps.filter(
        (ts) => ts <= lastClosed15m!.timestamp,
      );
      currentHtfCandles = validHtfTimestamps
        .map((ts) => htfMap.get(ts)!)
        .filter(Boolean);

      if (currentHtfCandles.length >= 50) {
        const ltfStart = Math.max(0, index15m - 200 + 1);
        currentLtfCandles = candlesLtf.slice(ltfStart, index15m + 1);

        const htfEndIdx = currentHtfCandles.length - 1;
        const htfStartIdx = Math.max(0, htfEndIdx - 50 + 1);
        const currentHtfWindow = currentHtfCandles.slice(
          htfStartIdx,
          htfEndIdx + 1,
        );

        // Условие пересчета паттернов: только на новой 15m свече или при изменении митигированных зон/структур
        const shouldRebuildCache =
          cachedPatternData === null ||
          mitigatedZones.length !== lastCachedMitigatedZonesLength ||
          mitigatedStructures.length !== lastCachedMitigatedStructuresLength ||
          isNew15mClose; // Пересчитываем ТОЛЬКО на закрытии 15m или при сделке

        if (shouldRebuildCache) {
          cachedPatternData = await recognizer.buildPatternData(
            symbol,
            currentLtfCandles,
            currentHtfWindow,
            lastClosed15m.timestamp,
          );
          lastCachedMitigatedZonesLength = mitigatedZones.length;
          lastCachedMitigatedStructuresLength = state.mitigatedStructures.length;
        }
      }
    }

    // Вызываем Router на каждой итерации (1m свече в Sniper Mode, или 15m в обычном)
    if (shouldEvaluateRouter && lastClosed15m && currentHtfCandles.length >= 50) {
      // Подготовка 1m свечей для Снайперских сценариев
      let candles1mForRouter: Candle[] = [];
      if (useSniperMode) {
        // Берем последние 200 1m свечей до текущего времени
        const endIdx = candles1m.findIndex(c => c.timestamp > candleTime);
        const sliceEnd = endIdx > 0 ? endIdx : candles1m.length;
        const sliceStart = Math.max(0, sliceEnd - 200);
        candles1mForRouter = candles1m.slice(sliceStart, sliceEnd);
      }

      cachedRouterResult = await router.evaluate(
        currentLtfCandles,
        currentHtfCandles,
        lastClosed15m.timestamp,
        mitigatedZones,
        state.mitigatedStructures,
        candles1mForRouter,
        cachedPatternData,
      );
      lastCachedMitigatedZonesLength = mitigatedZones.length;
      lastCachedMitigatedStructuresLength = state.mitigatedStructures.length;

      const routerResult = cachedRouterResult;

        try {
          if (
            routerResult.triggered &&
            routerResult.levels &&
            routerResult.zoneDetails
          ) {
            const levels = routerResult.levels;
            const entryDecimal = new Decimal(levels.entry);
            const slDecimal = new Decimal(levels.stopLoss);
            const tpDecimal = new Decimal(levels.takeProfit);
            const side = entryDecimal.gt(slDecimal) ? "Buy" : "Sell";

            // В Sniper Mode текущая свеча - это 1m, иначе 15m
            const entryCandle = useSniperMode ? currentCandle : lastClosed15m;

            const { state: newState, tradeOpened } = openTrade(
              state,
              entryCandle,
              entryDecimal,
              slDecimal,
              tpDecimal,
              side,
              routerResult.scenario!.id,
              routerResult.scenario!.name,
              instrument,
              routerResult.zoneDetails,
              routerResult.structureDetails,
              undefined,
              undefined,
              symbol,
              new Decimal(config.maxWorkingCapital || 0)
            );

            if (tradeOpened) Object.assign(state, newState);
          }
        } catch (err) {
          logger.error(`[${symbol}] Backtest ERROR at index ${i} | ${err}`);
        }
      }
    }

  logger.info(
    `[${symbol}] Backtest finished successfully. Processed ${mainCandles.length} candles, generated ${results.length} trades. Max Drawdown: ${state.maxDrawdown.toFixed(2)}%`,
  );
  cleanupMemory(candlesLtf, candlesHtf, candles1m, router, null);
  return { trades: results, maxDrawdown: state.maxDrawdown };
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
    logger.info(
      `CSV MODE is not fully supported for Sniper Mode data yet. Please use Online Mode for 1m testing.`,
    );
    process.exit(1);
  } else {
    client = BybitClient.create(config as any);
    recognizer = new PatternRecognizer(client, {
      displacementMultiplier: new Decimal(
        config.smcDisplacementMultiplier || 1.5,
      ),
    });

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

      const [candlesLtf, candlesHtf] = await Promise.all([
        loadCachedOrFetch(
          client,
          symbol,
          config.ltfTimeframe as Timeframe,
          fromMs,
          toMs,
          config.useLocalCacheOnly
        ),
        loadCachedOrFetch(
          client,
          symbol,
          config.htfTimeframe as Timeframe,
          fromMs,
          toMs,
          config.useLocalCacheOnly
        ),
      ]);

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
        candles1m.push(...fetched1m);
      }

      if (
        candlesLtf.length === 0 ||
        candlesHtf.length === 0 ||
        (config.enableSniperMode && candles1m.length === 0)
      ) {
        logger.warn(`Missing required candle data for ${symbol}, skipping`);
        continue;
      }

      const result = await runBacktestForSymbol(
        symbol,
        instrument,
        recognizer,
        candlesLtf,
        candlesHtf,
        candles1m,
        Number(config.ltfTimeframe),
        config,
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