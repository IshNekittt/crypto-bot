import "dotenv/config";
import { BybitClient } from "../api/bybitClient";
import { PatternRecognizer } from "../smc/patternRecognizer";
import { ScenarioRouter } from "../engine/scenarioRouter";
import { loadConfig } from "../config/env";
import { logger } from "../utils/logger";
import { Candle, Timeframe } from "../types";
import { InstrumentInfo } from "./executionSimulator";
import { MitigatedStructure } from "../engine/scenarioRouter";
import { Decimal } from "decimal.js";
import { loadCachedOrFetch, getTimeRangeForSixMonths } from "./historyLoader";
import {
  openTrade,
  checkAndCloseTrade,
  getInitialState,
  TradeResult,
} from "./executionSimulator";
import { printReport } from "./reporter";

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
    breakevenRrTrigger?: number;
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

  let cachedPatternData: any = null;
  let cachedRouterResult: any = null;
  let lastCachedCandleIndex = -1;
  let lastCachedMitigatedZonesLength = 0;
  let lastCachedMitigatedStructuresLength = 0;
  const CACHE_REBUILD_INTERVAL = 10;

  let currentDayUtc = -1;
  let currentWeekUtc = -1;
  let runningAth = new Decimal(0);
  let runningAtl = new Decimal("Infinity");

  logger.level = "warn";

  // --- СНАЙПЕРСКИЕ ПЕРЕМЕННЫЕ (Локальный State Machine) ---
  const useSniperMode =
    config.enableSniperMode === true && candles1m.length > 0;
  let sniperModeActive = false;
  let activeSniperZone: any = null; // Хранит результат от ScenarioRouter
  let sniperEntryTime = 0;

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
      // Идем по 15m массиву, пока свечи закрываются до текущего 1m времени
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

    // === ЖЕСТКАЯ ПРОВЕРКА ОТКРЫТОЙ СДЕЛКИ (Идем по currentCandle - 1m или 15m) ===
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
            breakevenRrTrigger: config.breakevenRrTrigger || 2,
          },
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

    // === СИГНАЛЬНЫЙ ДВИЖОК ===
    if (isNew15mClose && lastClosed15m) {
      const validHtfTimestamps = htfTimestamps.filter(
        (ts) => ts <= lastClosed15m!.timestamp,
      );
      const currentHtfCandles = validHtfTimestamps
        .map((ts) => htfMap.get(ts)!)
        .filter(Boolean);

      if (currentHtfCandles.length < 50) continue;

      const shouldRebuildCache =
        cachedPatternData === null ||
        mitigatedZones.length !== lastCachedMitigatedZonesLength ||
        mitigatedStructures.length !== lastCachedMitigatedStructuresLength ||
        index15m - lastCachedCandleIndex >= CACHE_REBUILD_INTERVAL;

      if (shouldRebuildCache) {
        const ltfStart = Math.max(0, index15m - 200 + 1);
        const currentLtfCandles = candlesLtf.slice(ltfStart, index15m + 1);

        const htfEndIdx = currentHtfCandles.length - 1;
        const htfStartIdx = Math.max(0, htfEndIdx - 50 + 1);
        const currentHtfWindow = currentHtfCandles.slice(
          htfStartIdx,
          htfEndIdx + 1,
        );

        cachedRouterResult = await router.evaluate(
          currentLtfCandles,
          currentHtfWindow,
          lastClosed15m.timestamp,
          mitigatedZones,
          state.mitigatedStructures,
        );
        lastCachedCandleIndex = index15m;
        lastCachedMitigatedZonesLength = mitigatedZones.length;
        lastCachedMitigatedStructuresLength = state.mitigatedStructures.length;
      }

      const routerResult = cachedRouterResult;

      try {
        if (
          routerResult.triggered &&
          routerResult.levels &&
          routerResult.zoneDetails
        ) {
          if (useSniperMode) {
            // Уходим в засаду! (Перезаписываем, если уже в засаде — обновляем на более свежий сетап)
            const wasAlreadyInSniper = sniperModeActive;
            sniperModeActive = true;
            activeSniperZone = routerResult;
            sniperEntryTime = candleTime;
            if (wasAlreadyInSniper) {
              logger.warn(
                `[${symbol}] 🔄 Updated SNIPER_MODE target: new 15m zone [${routerResult.zoneDetails.top} - ${routerResult.zoneDetails.bottom}]`,
              );
            } else {
              logger.warn(
                `[${symbol}] 🎯 Entered SNIPER_MODE inside 15m zone [${routerResult.zoneDetails.top} - ${routerResult.zoneDetails.bottom}]`,
              );
            }
          } else {
            // Классический вход (V4)
            const levels = routerResult.levels;
            const entryDecimal = new Decimal(levels.entry);
            const slDecimal = new Decimal(levels.stopLoss);
            const tpDecimal = new Decimal(levels.takeProfit);
            const side = entryDecimal.gt(slDecimal) ? "Buy" : "Sell";

            const { state: newState, tradeOpened } = openTrade(
              state,
              currentCandle, // 15m candle
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
            );

            if (tradeOpened) Object.assign(state, newState);
          }
        }
      } catch (err) {
        logger.error(`[${symbol}] Backtest ERROR at index ${i} | ${err}`);
      }
    }
    // === СНАЙПЕРСКОЕ ИСПОЛНЕНИЕ (1m) ===
    else if (sniperModeActive && useSniperMode) {
      const closePrice = new Decimal(currentCandle.close);
      const zone = activeSniperZone.zoneDetails;
      const isLong =
        activeSniperZone.levels.entry < activeSniperZone.levels.takeProfit;

      // 1. Проверка отмены (расширяем зону на 20%, чтобы не выбивало минутными SFP-шпильками)
      const zoneHeight = new Decimal(zone.top).minus(zone.bottom).abs();
      const tolerance = zoneHeight.mul(0.2);

      const canceled = isLong
        ? closePrice.lt(new Decimal(zone.bottom).minus(tolerance))
        : closePrice.gt(new Decimal(zone.top).plus(tolerance));

      if (canceled) {
        sniperModeActive = false;
        activeSniperZone = null;
        continue;
      }

      // Ambush Timeout: если в засаде просидим > 4 часов (240 минутных свечей) — отменяем
      const ambushTimeoutMs = 240 * 60 * 1000; // 4 часа
      if (candleTime - sniperEntryTime > ambushTimeoutMs) {
        logger.warn(
          `[${symbol}] ⏰ SNIPER_MODE timeout (4h) — aborting ambush`,
        );
        sniperModeActive = false;
        activeSniperZone = null;
        continue;
      }

      // 2. Поиск CHoCH на 1 минутке
      const sliced1m = candles1m.slice(Math.max(0, i - 150), i + 1);

      // Запрашиваем ATR и ищем сломы
      const atr1m = (recognizer as any).calculateATR
        ? (recognizer as any).calculateATR(sliced1m, 14)
        : new Decimal(currentCandle.close).mul(0.001);
      const sniperDispMult = new Decimal(config.sniperDisplacementMultiplier || 0.5);
      const structures = recognizer.detectStructureBreaks(sliced1m, atr1m, sniperDispMult);

      // Ищем CHoCH: он должен произойти не раньше, чем за 45 минут до текущего момента
      // Это решает Парадокс Времени (забираем CHoCH, который сформировался внутри 15m свечи)
      const timeThreshold = candleTime - 45 * 60 * 1000;

      const freshChochs = structures.filter((s: any) => {
        if (s.type !== "CHOCH") return false;
        if (s.timestamp < timeThreshold) return false;
        // Гибкая проверка направления, если оно есть
        if (s.direction && s.direction !== (isLong ? "BULLISH" : "BEARISH"))
          return false;
        return true;
      });

      if (freshChochs.length > 0) {
        const choch = freshChochs[freshChochs.length - 1];
        const idealEntry = new Decimal(choch.price);

        // Считаем ювелирный стоп по 1m свечам (за последние 30 минут)
        const recent1mCandles = sliced1m.slice(-30);
        let localExtreme: Decimal;
        if (isLong) {
          let minLow = new Decimal(recent1mCandles[0].low);
          for (const c of recent1mCandles) {
            const low = new Decimal(c.low);
            if (low.lt(minLow)) minLow = low;
          }
          localExtreme = minLow;
        } else {
          let maxHigh = new Decimal(recent1mCandles[0].high);
          for (const c of recent1mCandles) {
            const high = new Decimal(c.high);
            if (high.gt(maxHigh)) maxHigh = high;
          }
          localExtreme = maxHigh;
        }

        // Страховка: если CHoCH кривой и стоп получается хуже входа — отменяем
        if (isLong && idealEntry.lte(localExtreme)) continue;
        if (!isLong && idealEntry.gte(localExtreme)) continue;

        const offset = localExtreme.mul(0.0005); // Микро-отступ 0.05%
        const slDecimal = isLong
          ? localExtreme.minus(offset)
          : localExtreme.plus(offset);

        // R:R 1:3
        const tpDecimal = isLong
          ? idealEntry.plus(idealEntry.minus(slDecimal).mul(3))
          : idealEntry.minus(slDecimal.minus(idealEntry).mul(3));

        logger.warn(
          `[${symbol}] 🔫 SNIPER SHOT FIRED! 1m CHoCH at ${new Date(choch.timestamp).toISOString()}! Entry: ${idealEntry.toFixed(4)}`,
        );

        const { state: newState, tradeOpened } = openTrade(
          state,
          currentCandle, // 1m candle
          idealEntry,
          slDecimal,
          tpDecimal,
          isLong ? "Buy" : "Sell",
          activeSniperZone.scenario!.id,
          activeSniperZone.scenario!.name + " (1m Snipe)",
          instrument,
          zone,
          { type: "CHoCH", timestamp: choch.timestamp, price: choch.price },
          undefined,
          undefined,
          symbol,
        );

        if (tradeOpened) Object.assign(state, newState);

        sniperModeActive = false;
        activeSniperZone = null;
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

  const config = loadConfig() as ReturnType<typeof loadConfig> & {
    enableSniperMode?: boolean;
    backtestDays?: number;
  };
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

    const { fromMs, toMs } = getTimeRangeForSixMonths();

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
        ),
        loadCachedOrFetch(
          client,
          symbol,
          config.htfTimeframe as Timeframe,
          fromMs,
          toMs,
        ),
      ]);

      const candles1m: Candle[] = [];
      if (config.enableSniperMode) {
        const days = config.backtestDays || 60;
        const from1m = toMs - days * 24 * 60 * 60 * 1000;
        logger.info(`Fetching 1m candles for Sniper Mode (${days} days)...`);
        const fetched1m = await loadCachedOrFetch(
          client,
          symbol,
          "1",
          Math.max(fromMs, from1m),
          toMs,
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
