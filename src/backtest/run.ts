import "dotenv/config";
import { BybitClient } from "../api/bybitClient";
import { PatternRecognizer } from "../smc/patternRecognizer";
import { ScenarioRouter } from "../engine/scenarioRouter";
import type { RouterResult } from "../engine/scenarioRouter";
import { loadConfig, resolveLimitExpirationCandles, resolveSymbolConfig } from "../config/env";
import { logger } from "../utils/logger";
import { Candle, Timeframe } from "../types";
import { InstrumentInfo } from "./executionSimulator";
import { Decimal } from "decimal.js";
import { formatPrice } from "../utils/precision";
import { shouldUseMarketEntry } from "../config/fees";
import { loadCachedOrFetch, getTimeRangeForDays } from "./historyLoader";
import {
  openTrade,
  checkAndCloseTrade,
  getInitialState,
  TradeResult,
} from "./executionSimulator";
import type { BacktestState } from "./executionSimulator";
import { printReport, writeBacktestArtifacts, resetScenarioRejectionStats } from "./reporter";

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
  ltfMinutes: number,
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

  // === PATTERN WINDOW PARITY (live CandleFeed capacities) ===
  // Live feeds buildPatternData() the last `historyCandles` CLOSED candles for
  // BOTH LTF and HTF — `CandleFeed.getCandles()` never exposes the forming
  // candle. The backtester MUST use the identical window, otherwise scenarios
  // 1/5/9 evaluate different 4H structures than the deployed engine.
  const historyWindow = config.historyCandles ?? 200;
  const ltfMs = ltfMinutes * 60 * 1000;
  const htfMs = Number(config.htfTimeframe) * 60 * 1000;

  let index15m = 0;
  const mainCandles = useSniperMode ? candles1m : candlesLtf;

  // Warmup candles exist only as pattern context: the simulated/report period
  // starts at the first candle of the requested range. Sniper mode drives the
  // loop with the 1m series, which is loaded without warmup.
  const loopStart = useSniperMode
    ? 0
    : Math.max(0, Math.min(ltfWarmupCount, mainCandles.length));

  logger.warn(
    `[${symbol}] Starting backtest loop over ${mainCandles.length - loopStart} candles (Sniper Mode: ${useSniperMode ? "ON (1m)" : "OFF (15m)"})...`,
  );

  for (let i = loopStart; i < mainCandles.length; i++) {
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

    // === СИГНАЛЬНЫЙ ДВИЖОК (Единый вызов Router) ===
    // В Sniper Mode: вызываем на каждой 1m свече, передаем свежие 1m свечи
    // В обычном режиме: только на закрытии 15m свечи
    const shouldEvaluateRouter = useSniperMode ? true : isNew15mClose;

    // Evaluation timestamp: live passes the timestamp of the candle that just
    // closed — the 1m candle in Sniper Mode, the 15m candle in Classic mode
    // (StrategyEngine.process). Session and killzone are derived from it, so a
    // 15m anchor would mis-gate the first 15 minutes of every hour in Sniper Mode.
    const evalTimestamp = useSniperMode
      ? candleTime
      : lastClosed15m?.timestamp ?? candleTime;

    // Пересчитываем 15m/4H окна и PatternData ТОЛЬКО при новой 15m свече
    if (isNew15mClose && lastClosed15m) {
      // Evaluation instant = the moment the trigger candle closed (live evaluates
      // on confirmed klines, milliseconds after that instant).
      const evalCloseTimeMs = useSniperMode
        ? candleTime + 60 * 1000
        : candleTime + ltfMs;

      // HTF window: only 4H candles fully CLOSED by the evaluation instant. The
      // old `ts <= lastClosed15m.timestamp` filter leaked the still-forming 4H
      // candle — up to 4 hours of future price action (lookahead).
      const validHtfTimestamps = htfTimestamps.filter(
        (ts) => ts + htfMs <= evalCloseTimeMs,
      );
      currentHtfCandles = validHtfTimestamps
        .map((ts) => htfMap.get(ts)!)
        .filter(Boolean);

      // LTF window: drop the 15m candle still forming at the evaluation instant.
      // Classic mode keeps the current candle (it has just closed:
      // `timestamp + ltfMs === evalCloseTimeMs`); Sniper mode drops the candle
      // containing the current 1m tick. Guard also handles data gaps correctly.
      let ltfEndExclusive = index15m + 1;
      const lastLtf = candlesLtf[ltfEndExclusive - 1];
      if (lastLtf && lastLtf.timestamp + ltfMs > evalCloseTimeMs) {
        ltfEndExclusive -= 1;
      }
      const ltfStart = Math.max(0, ltfEndExclusive - historyWindow);
      currentLtfCandles = candlesLtf.slice(ltfStart, ltfEndExclusive);

      if (
        currentLtfCandles.length >= MIN_PATTERN_CANDLES &&
        currentHtfCandles.length >= MIN_PATTERN_CANDLES
      ) {
        const htfEndIdx = currentHtfCandles.length - 1;
        const htfStartIdx = Math.max(0, htfEndIdx - historyWindow + 1);
        const currentHtfWindow = currentHtfCandles.slice(
          htfStartIdx,
          htfEndIdx + 1,
        );

        // Условие пересчета паттернов: только на новой 15m свече или при изменении митигированных зон/структур
        const shouldRebuildCache =
          cachedPatternData === null ||
          state.mitigatedZones.length !== lastCachedMitigatedZonesLength ||
          state.mitigatedStructures.length !== lastCachedMitigatedStructuresLength ||
          isNew15mClose; // Пересчитываем ТОЛЬКО на закрытии 15m или при сделке

        if (shouldRebuildCache) {
          cachedPatternData = await recognizer.buildPatternData(
            symbol,
            currentLtfCandles,
            currentHtfWindow,
            evalTimestamp,
          );
          lastCachedMitigatedZonesLength = state.mitigatedZones.length;
          lastCachedMitigatedStructuresLength = state.mitigatedStructures.length;
        }
      }
    }

    // Вызываем Router на каждой итерации (1m свече в Sniper Mode, или 15m в обычном)
    // Gate mirrors the live StrategyEngine.process() guard (>= 20 candles per side).
    if (
      shouldEvaluateRouter &&
      lastClosed15m &&
      // Live parity: StrategyEngine.process() returns early while the post-SL
      // cooldown is active, so no scenario is evaluated. Without this the
      // backtester re-fires the same setup every minute for the whole cooldown
      // window (observed: 5 phantom SOL triggers after one stop-out), inflating
      // the trigger funnel with signals that can never become trades.
      !(state.cooldownUntil > 0 && state.cooldownUntil > candleTime) &&
      currentLtfCandles.length >= MIN_PATTERN_CANDLES &&
      currentHtfCandles.length >= MIN_PATTERN_CANDLES
    ) {
      // Подготовка 1m свечей для Снайперских сценариев
      let candles1mForRouter: Candle[] = [];
      if (useSniperMode) {
        // Live feed1m capacity is 300 candles (5h) — StrategyEngine constructor.
        // Only candles already closed (timestamp <= candleTime) are visible.
        const endIdx = candles1m.findIndex(c => c.timestamp > candleTime);
        const sliceEnd = endIdx > 0 ? endIdx : candles1m.length;
        const sliceStart = Math.max(0, sliceEnd - SNIPER_1M_WINDOW);
        candles1mForRouter = candles1m.slice(sliceStart, sliceEnd);
      }

      cachedRouterResult = await router.evaluate(
        currentLtfCandles,
        currentHtfCandles,
        evalTimestamp,
        state.mitigatedZones,
        state.mitigatedStructures,
        candles1mForRouter,
        cachedPatternData,
      );
      lastCachedMitigatedZonesLength = state.mitigatedZones.length;
      lastCachedMitigatedStructuresLength = state.mitigatedStructures.length;

      const routerResult = cachedRouterResult;

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

            // The candle whose close is used as the Market fill:
            // Sniper -> current 1m candle, Classic -> current (closed) 15m candle.
            const entryCandle = useSniperMode ? currentCandle : lastClosed15m;
            const currentPrice = new Decimal(entryCandle.close);

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
              entryCandle,
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
              `[${symbol}] Scenario ${routerResult.scenario!.id} signal at ${new Date(entryCandle.timestamp).toISOString()} | ${orderType} entry=${entryPriceDecimal.toString()} live=${currentPrice.toString()} SL=${slDecimal.toString()} TP=${tpDecimal.toString()} | filled=${!!newState.openTrade}`,
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

      // Warmup preload: fetch extra LTF/HTF candles BEFORE the report window.
      // Live boots with a fully preloaded CandleFeed (historyCandles closed
      // candles per timeframe), so without the warmup the first ~200 HTF candles
      // of a run would be evaluated against a truncated pattern window (≈ 33 days
      // of a 60-day backtest). LTF warmup additionally guarantees a full 7-day
      // history for weekly macro levels. Warmup candles are CONTEXT ONLY:
      // `ltfWarmupCount` marks where the simulated/report period begins.
      const historyWindow = config.historyCandles ?? 200;
      const ltfMinutesConfig = Number(config.ltfTimeframe);

      // Weekly macro context (PWH/PWL/WO) is derived from a full 7-day window of
      // LTF candles (`calculateWeeklyLevels`). Preloading fewer than that leaves
      // weekly levels at zero for the opening days of the run. The warmup must
      // therefore cover at least one week; the extra candle absorbs a `fromMs`
      // anchored mid-candle (`getTimeRangeForDays` uses `Date.now()`), so a full
      // week always sits strictly before the first simulated candle. Warmup is
      // closed history only — strictly causal, never future data.
      const candlesPerWeek = Math.floor((1440 * 7) / ltfMinutesConfig);
      const ltfWarmupCandles = Math.max(historyWindow, candlesPerWeek + 1);
      const ltfWarmupMs = ltfWarmupCandles * ltfMinutesConfig * 60 * 1000;
      const htfWarmupMs = historyWindow * Number(config.htfTimeframe) * 60 * 1000;

      const [candlesLtfWithWarmup, candlesHtf] = await Promise.all([
        loadCachedOrFetch(
          client,
          symbol,
          config.ltfTimeframe as Timeframe,
          fromMs - ltfWarmupMs,
          toMs,
          config.useLocalCacheOnly
        ),
        loadCachedOrFetch(
          client,
          symbol,
          config.htfTimeframe as Timeframe,
          fromMs - htfWarmupMs,
          toMs,
          config.useLocalCacheOnly
        ),
      ]);

      // The simulated/report period starts at `fromMs`; everything before is warmup.
      const ltfWarmupCount = Math.max(
        0,
        candlesLtfWithWarmup.findIndex((c) => c.timestamp >= fromMs),
      );
      const candlesLtf = candlesLtfWithWarmup.slice(ltfWarmupCount);
      if (ltfWarmupCount > 0) {
        logger.info(
          `[${symbol}] Pattern warmup preloaded: ${ltfWarmupCount} extra ${config.ltfTimeframe}m candles (weekly window ${candlesPerWeek} candles; HTF fetch extended by ${historyWindow} × ${config.htfTimeframe}m).`,
        );
      }
      if (ltfWarmupCount > 0 && ltfWarmupCount < candlesPerWeek) {
        // Only reachable with a truncated source (e.g. `USE_LOCAL_CACHE_ONLY=true`
        // against a cache that does not reach back a full week). Never silent:
        // weekly macro levels stay zero until enough context exists.
        logger.warn(
          `[${symbol}] LTF warmup covers only ${ltfWarmupCount}/${candlesPerWeek} candles — PWH/PWL/WO will remain zero until a full week of history is available. Extend the cache or run online.`,
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
        Number(config.ltfTimeframe),
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