import { BybitClient } from '../api/bybitClient';
import { KlineUpdate } from '../api/wsClient';
import { ExecutionEngine } from '../execution/executionEngine';
import { CandleFeed } from '../feed/candleFeed';
import { PostgresDatabase } from '../db/database';
import { PositionPlan, RiskManager } from '../risk/riskManager';
import { ScenarioRouter } from './scenarioRouter';
import { TelegramNotifier } from '../telegram/notifier';
import { PendingTradeManager } from './pendingTradeManager';
import { NewsService } from '../services/newsService';
import { timeframeToMinutes } from '../utils/timeframe';
import { InstrumentInfo, StrategyState, Timeframe, BotConfig, MitigatedZone, MitigatedStructure } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { evaluateTradeManagement, initializeTradeManagement } from '../risk/tradeManager';
import { formatPrice, formatQuantity } from '../utils/precision';
import { shouldUseMarketEntry } from '../config/fees';

export const WAITING_ANTI_STUCK_CANDLES_4H = 30;
const NO_POSITION_RECHECK_MS = 30_000;

export interface StrategyEngineDeps {
  readonly symbol: string;
  readonly instrument: InstrumentInfo;
  readonly client: BybitClient;
  readonly db: PostgresDatabase;
  readonly riskManager: RiskManager;
  readonly executionEngine: ExecutionEngine;
  readonly notifier: TelegramNotifier;
  readonly patternRecognizer: any;
  readonly autoTrading: boolean;
  readonly pendingTradeManager: PendingTradeManager;
  readonly newsService: NewsService;
  readonly config: BotConfig;
  readonly activeScenarios: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ClosedPositionEvent {
  readonly pnl: string | null;
}

function parseClosedPositions(payload: unknown, ownSymbol: string): ClosedPositionEvent[] {
  // wsClient.routeUpdate() hands over the raw `event.data` array, while the full Bybit
  // envelope `{ topic, data: [...] }` may still be passed by other callers/tests.
  // Accept BOTH shapes so the Position channel is never silently dead (Invariant 35).
  const dataArray = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : null;
  if (!dataArray) return [];
  const events: ClosedPositionEvent[] = [];
  for (const item of dataArray) {
    if (!isRecord(item)) continue;
    if (item.symbol !== ownSymbol) continue;

    // Check if position size is 0 or side is None (handles string sizes like "0", "0.0000")
    const sizeStr = String(item.size ?? '0');
    let isZeroSize = false;
    try {
      isZeroSize = new Decimal(sizeStr).isZero();
    } catch {
      isZeroSize = Number(sizeStr) === 0;
    }

    const isClosedSide = item.side === 'None' || !item.side;

    if (isZeroSize || isClosedSide) {
      const rawPnl = item.closedPnl ?? item.curRealisedPnl;
      events.push({ pnl: typeof rawPnl === 'string' ? rawPnl : null });
    }
  }
  return events;
}

export class StrategyEngine {
  readonly symbol: string;
  readonly deps: StrategyEngineDeps;
  private readonly feedLtf: CandleFeed;
  private readonly feedHtf: CandleFeed;
  private readonly feed1m: CandleFeed; // 1m candles for Sniper Mode
  private readonly scenarioRouter: ScenarioRouter;
  private state: StrategyState = StrategyState.SCANNING;
  private plan: PositionPlan | null = null;
  private processing = false;
  private isProcessing = false;
  private isManaging = false;
  private isClosingPosition = false;
  private noPositionRecheckAt = 0;
  private lastProcessedCandleTimestamp: number = 0;
  private latestTickPrice: string | null = null;
  private mitigatedZones: MitigatedZone[] = [];
  private mitigatedStructures: MitigatedStructure[] = [];
  // Cooldown after SL hit (4 hours = 16 * 15min candles)
  private cooldownUntil: number = 0;
  // Sniper Mode: active zone waiting for 1m entry trigger (reserved for live engine implementation)
  // @ts-expect-error - Reserved for live engine Sniper Mode implementation
  private _activeSniperZone: { top: Decimal; bottom: Decimal; direction: 'BULLISH' | 'BEARISH'; scenarioId: string; scenarioName: string } | null = null;

  constructor(deps: StrategyEngineDeps) {
    this.symbol = deps.symbol;
    this.deps = deps;
    const historyCandles = deps.client.config?.historyCandles ?? 200;
    this.feedLtf = new CandleFeed(deps.symbol, deps.config.ltfTimeframe as Timeframe, historyCandles);
    this.feedHtf = new CandleFeed(deps.symbol, deps.config.htfTimeframe as Timeframe, historyCandles);
    // 1m candle feed for Sniper Mode (capacity: 300 candles = 5 hours)
    this.feed1m = new CandleFeed(deps.symbol, '1' as Timeframe, 300);

    this.scenarioRouter = new ScenarioRouter({
      symbol: deps.symbol,
      patternRecognizer: deps.patternRecognizer,
      notifier: deps.notifier,
      activeScenarios: deps.activeScenarios,
      config: deps.config,
    });
  }

  getState(): StrategyState {
    return this.state;
  }

  getInstrument(): InstrumentInfo {
    return this.deps.instrument;
  }

  getLastClosedCandle(): { close: Decimal; timestamp: number } | null {
    const candle = this.feedLtf.getLastClosed();
    if (!candle) return null;
    return { close: new Decimal(candle.close), timestamp: candle.timestamp };
  }

  getLivePrice(): string | null {
    return this.latestTickPrice;
  }

  async getDiagnostics(): Promise<{
    symbol: string;
    livePrice: string | null;
    lastCandleTime: number | null;
    trend4h: 'BULLISH' | 'BEARISH' | 'NONE';
    zonesCount: number;
    nearestMacroDistancePct: string | null;
    state: StrategyState;
  }> {
    // Last closed LTF candle time
    const lastClosed = this.feedLtf.getLastClosed();
    const lastCandleTime = lastClosed ? lastClosed.timestamp : null;

    // HTF Trend from structures
    let trendHtf: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';
    const candlesHtf = this.feedHtf.getCandles() as any[];
    if (candlesHtf.length >= 2) {
      const lastHtf = candlesHtf[candlesHtf.length - 1];
      const prevHtf = candlesHtf[candlesHtf.length - 2];
      const lastClose = new Decimal(lastHtf.close);
      const prevClose = new Decimal(prevHtf.close);
      if (lastClose.gt(prevClose)) trendHtf = 'BULLISH';
      else if (lastClose.lt(prevClose)) trendHtf = 'BEARISH';
    }

    // Count zones in memory (OB + FVG from LTF and HTF)
    const candlesLtf = this.feedLtf.getCandles() as any[];
    const candlesHtfAll = this.feedHtf.getCandles() as any[];
    let zonesCount = 0;
    if (candlesLtf.length >= 20 && candlesHtfAll.length >= 20) {
      try {
        const patternData = await this.deps.patternRecognizer.buildPatternData(
          this.symbol,
          candlesLtf,
          candlesHtfAll,
          Date.now()
        );
        zonesCount = patternData.zones?.length || 0;
      } catch {
        zonesCount = 0;
      }
    }

    // Nearest macro level distance (PDH or PDL) - use LIVE price
    let nearestMacroDistancePct: string | null = null;
    try {
      const macroContext = await this.deps.patternRecognizer['macroCache'].get(`${this.symbol}_macro`);
      if (macroContext) {
        const livePriceStr = this.getLivePrice();
        if (livePriceStr) {
          const currentPrice = new Decimal(livePriceStr);
          const pdh = macroContext.dailyLevels.pdh;
          const pdl = macroContext.dailyLevels.pdl;
          
          const distToPdh = pdh.gt(currentPrice) ? pdh.minus(currentPrice).div(currentPrice).mul(100) : currentPrice.minus(pdh).div(currentPrice).mul(100);
          const distToPdl = pdl.gt(currentPrice) ? pdl.minus(currentPrice).div(currentPrice).mul(100) : currentPrice.minus(pdl).div(currentPrice).mul(100);
          
          const nearestDist = Decimal.min(pdh.gt(currentPrice) ? distToPdh : distToPdl);
          nearestMacroDistancePct = nearestDist.toFixed(2);
        }
      }
    } catch {
      nearestMacroDistancePct = null;
    }

    return {
      symbol: this.symbol,
      livePrice: this.getLivePrice(),
      lastCandleTime,
      trend4h: trendHtf, // keep key as trend4h for compatibility with Telegram /status
      zonesCount,
      nearestMacroDistancePct,
      state: this.state,
    };
  }

  async initialize(): Promise<void> {
    await this.reloadHistory();
    const saved = await this.deps.db.getSymbolState(this.symbol);
    const openTrade = await this.deps.db.getOpenTrade(this.symbol);
    if (saved?.state === StrategyState.IN_TRADE && openTrade) {
      this.transition(StrategyState.IN_TRADE);
      logger.warn(
        `${this.symbol}: restored IN_TRADE after restart (orderId=${openTrade.orderId ?? 'n/a'}), reconciliation will verify`,
      );
    } else {
      this.transition(StrategyState.SCANNING);
    }
  }

  async reloadHistory(): Promise<void> {
    await this.feedLtf.loadHistory(this.deps.client);
    await this.feedHtf.loadHistory(this.deps.client);
    logger.info(
      `${this.symbol}: history ready (${this.deps.config.ltfTimeframe}=${this.feedLtf.getCandles().length}, ${this.deps.config.htfTimeframe}=${this.feedHtf.getCandles().length})`,
    );
  }

  async handleKline(update: KlineUpdate): Promise<void> {
    this.latestTickPrice = update.candle.close;

    // Trade management (Adaptive Fractioning) on every incoming tick — confirmed or not.
    // checkAndManagePosition() is lazy: zero exchange API calls unless a milestone action fires.
    if (this.state === StrategyState.IN_TRADE) {
      try {
        await this.checkAndManagePosition();
      } catch (error) {
        logger.error(`${this.symbol}: checkAndManagePosition error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!update.confirmed) return;
    const isLtfUpdate = update.interval === this.feedLtf.interval;
    const previousTimestamp = this.feedLtf.getLastClosed()?.timestamp;
    if (update.interval === this.feedHtf.interval) this.feedHtf.applyKline(update);
    if (isLtfUpdate) this.feedLtf.applyKline(update);

    if (update.interval === '1' && this.deps.config.enableSniperMode) {
      this.feed1m.applyKline(update);

      if (this.state === StrategyState.SCANNING) {
        try {
          await this.process('1' as Timeframe);
        } catch (error) {
          logger.error(`${this.symbol}: process(1m) error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    if (this.deps.config.enableSniperMode || !isLtfUpdate ||
        this.feedLtf.getLastClosed()?.timestamp === previousTimestamp) return;
    if (this.processing) {
      logger.debug(`${this.symbol}: kline skipped, previous cycle still running`);
      return;
    }
    this.processing = true;
    try {
      await this.process(update.interval as Timeframe);
    } catch (error) {
      logger.error(
        `${this.symbol}: strategy error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.processing = false;
    }
  }

  /**
   * Check and manage open position using adaptive fractioning logic.
   * Called on every incoming tick when in IN_TRADE state (any timeframe).
   * Lazy API evaluation: DB read + local signal first; exchange REST calls
   * happen only when a milestone action is actually required.
   */
  private async checkAndManagePosition(): Promise<void> {
    if (this.state !== StrategyState.IN_TRADE) return;

    const livePriceStr = this.getLivePrice();
    if (!livePriceStr) return;

    if (this.isManaging || Date.now() < this.noPositionRecheckAt) return;
    this.isManaging = true;

    try {
      const trade = await this.deps.db.getOpenTrade(this.symbol);
      if (!trade) return;

      const managementState = trade.managementState || {
        milestone1Triggered: false,
        milestone2Triggered: false,
        initialTotalR: '0',
        initialQty: trade.qty,
      };

      const signal = evaluateTradeManagement({
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        currentPrice: livePriceStr,
        side: trade.side as 'Buy' | 'Sell',
        initialQty: trade.qty,
        managementState,
        instrument: this.deps.instrument,
      });

      // Lazy evaluation: no milestone action → zero exchange API calls
      if (signal.action === 'none') return;

      // Verify the physical position exists on exchange only when an action is required
      // This prevents managing unfilled limit orders
      const positions = await this.deps.client.getOpenPositions(this.symbol);
      const position = positions.find(p => p.symbol === this.symbol);
      if (!position || position.size.isZero()) {
        // No actual position on exchange (limit order not filled yet) — back off before re-checking
        this.noPositionRecheckAt = Date.now() + NO_POSITION_RECHECK_MS;
        return;
      }

      logger.info(`[${this.symbol}] Trade management signal: ${signal.action} - ${signal.reason}`);

      const actualPosSize = new Decimal(position.size);
      let actionPerformed = false;

      // (a) Exchange partial close FIRST — reduce-only qty clamped to the real position size.
      // An oversized reduce-only order is rejected by Bybit and the milestone would never
      // progress, so the DB update must never run ahead of a confirmed exchange action.
      if (signal.action === 'close_partial_25' || signal.action === 'close_partial_50') {
        if (signal.closeQty) {
          let intendedCloseQty = new Decimal(signal.closeQty);
          if (intendedCloseQty.gt(actualPosSize)) {
            logger.warn(`[${this.symbol}] Clamped partial close qty ${intendedCloseQty.toString()} -> actual position size ${actualPosSize.toString()}`);
            intendedCloseQty = actualPosSize;
          }
          // Invariant 16.21: never send an unformatted qty to the exchange.
          const formattedCloseQty = formatQuantity(
            intendedCloseQty,
            new Decimal(this.deps.instrument.qtyStep),
          );

          const closeSide = trade.side === 'Buy' ? 'Sell' : 'Buy';

          const partialCloseResult = await this.deps.executionEngine.executePartialClose({
            symbol: this.symbol,
            side: closeSide as 'Buy' | 'Sell',
            qty: formattedCloseQty,
            orderLinkId: `partial_${Date.now()}`,
          });

          if (!partialCloseResult.ok) {
            logger.warn(`[${this.symbol}] Partial close failed: ${partialCloseResult.reason}. Aborting milestone update; will retry on next tick.`);
            return;
          }

          actionPerformed = true;
          logger.info(`[${this.symbol}] Partial close executed: ${formattedCloseQty} ${closeSide}`);
        }
      }

      // (b) SL move only AFTER the partial close succeeded (if one was required).
      if (signal.newStopLoss) {
        // Use setTradingStop for position SL/TP updates (not amendOrder which is for pending orders)
        await this.deps.client.setTradingStop({
          symbol: this.symbol,
          stopLoss: signal.newStopLoss,
        });
        actionPerformed = true;
        logger.info(`[${this.symbol}] Stop loss updated to ${signal.newStopLoss}`);
      }

      if (!actionPerformed) return;

      // (c) Persist the milestone exactly once, after every exchange action succeeded.
      const dbOk = await this.deps.db.updateTradeManagementState(trade.id, signal.updatedState);
      if (!dbOk) {
        logger.error(`[${this.symbol}] CRITICAL: DB failed to update milestone state for trade ${trade.id} — exchange is managed but DB is stale.`);
      }
    } catch (error) {
      logger.error(`[${this.symbol}] Trade management error: ${error instanceof Error ? error.message : String(error)}`);
      // Apply a 5-second penalty backoff if the exchange API throws an error
      this.noPositionRecheckAt = Date.now() + 5000;
    } finally {
      this.isManaging = false;
    }
  }

  async handlePositionPayload(payload: unknown): Promise<void> {
    if (this.state !== StrategyState.IN_TRADE) return;
    let closedEvents;
    try {
      closedEvents = parseClosedPositions(payload, this.symbol);
    } catch (error) {
      logger.error(`${this.symbol}: parseClosedPositions error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (closedEvents.length === 0) return;
    try {
      await this.onExchangePositionClosed(closedEvents[0].pnl);
    } catch (error) {
      logger.error(
        `${this.symbol}: failed to process position close event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handleExecutionPayload(payload: unknown): Promise<void> {
    if (this.state !== StrategyState.IN_TRADE) return;
    try {
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) {
        if (item.symbol === this.symbol && item.execType === 'Trade') {
          const closedSize = new Decimal(item.closedSize ?? '0');
          if (closedSize.gt(0)) {
            const execPrice = item.execPrice ? item.execPrice.toString() : undefined;
            logger.info(`[${this.symbol}] Execution WS: Position closed (size=${closedSize}, execPrice=${execPrice ?? 'unknown'}), triggering reconciliation`);
            await this.onExchangePositionClosed(null, execPrice);
            return;
          }
        }
      }
    } catch (error) {
      logger.error(`${this.symbol}: handleExecutionPayload error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async handleTradeApproval(tradeId: string, approved: boolean): Promise<void> {
    // State guard: ignore approvals if not in ENTRY_STAGED
    if (this.state !== StrategyState.ENTRY_STAGED) {
      logger.warn(`[${this.symbol}] Ignored approval for ${tradeId}: bot is in ${this.state}`);
      return;
    }

    const approvalResult = this.deps.pendingTradeManager.handleApproval(tradeId, approved);
    if (!approvalResult.approved) {
      if (approved) {
        logger.info(`${this.symbol}: trade ${tradeId} rejected by user`);
      } else {
        logger.warn(`${this.symbol}: approval for unknown/expired trade ${tradeId}`);
      }
      if (this.plan) {
        await this.burnSetup(this.plan);
      }
      this.transition(StrategyState.SCANNING);
      return;
    }

    // Approved - execute the trade with dynamic order type
    if (!this.plan) {
      logger.error(`${this.symbol}: no plan for approved trade ${tradeId}`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    // === PRE-FLIGHT CHECK: Price must not have crossed our SL during approval wait ===
    const currentPrice = this.getLivePrice() ?? this.feedLtf.getCandles().slice(-1)[0]?.close;
    if (!currentPrice) {
      logger.error(`[${this.symbol}] CRITICAL: Cannot determine live price for pre-flight check at approval. Aborting approval to prevent blind firing.`);
      this.burnSetup(this.plan);
      this.transition(StrategyState.SCANNING);
      return;
    }

    const currentPriceDecimal = new Decimal(currentPrice);
    const slDecimal = new Decimal(this.plan.stopLoss);
    const isLong = this.plan.side === 'Buy';
    const slBuffer = currentPriceDecimal.mul(new Decimal(this.deps.config.preflightBufferPct));
    const slBreached = isLong
      ? currentPriceDecimal.lte(slDecimal.plus(slBuffer))
      : currentPriceDecimal.gte(slDecimal.minus(slBuffer));

    if (slBreached) {
      logger.warn(`[${this.symbol}] Setup DEAD: Live price (${currentPrice}) breached SL (${this.plan.stopLoss}) — aborting approval.`);
      this.burnSetup(this.plan);
      this.transition(StrategyState.SCANNING);
      return;
    }

    // Create updated plan with dynamic order type (PositionPlan is readonly)
    const updatedPlan: PositionPlan = {
      ...this.plan,
      orderType: approvalResult.orderType,
      limitPrice: approvalResult.limitPrice ?? null,
      structureDetails: approvalResult.structureDetails,
    };

    logger.info(`${this.symbol}: trade ${tradeId} approved, executing ${approvalResult.orderType} order${approvalResult.limitPrice ? ` @ ${approvalResult.limitPrice}` : ''}`);
    const result = await this.deps.executionEngine.execute(updatedPlan);
    if (!result.ok) {
      // AMBIGUOUS FAILURE: a network timeout / retCode 0 may still have placed the order.
      // Never reset to SCANNING before proving the exchange is flat (Invariant 23).
      logger.error(`[${this.symbol}] Order execution failed: ${result.reason}. Verifying exchange state via orderLinkId=${result.orderLinkId}`);
      const flattened = await this.panicCloseOrphan({
        orderLinkId: result.orderLinkId,
        orderType: updatedPlan.orderType,
        verifyFlat: true,
      });

      if (flattened) {
        this.burnSetup(updatedPlan);
        this.plan = null;
        this.transition(StrategyState.SCANNING);
      } else {
        logger.error(`[${this.symbol}] CRITICAL: ambiguous order failure could NOT be verified flat. Engine remains ${this.state}; manual intervention required.`);
        // Exposure may still exist on Bybit. Force IN_TRADE so Reconciliation can see it —
        // resetting to SCANNING here would orphan a live order (Invariant 23).
        this.transition(StrategyState.IN_TRADE);
      }

      // Throw error so Telegram handler catches it and shows rejection to user
      throw new Error(`Exchange Error: ${result.reason}`);
    }

    // Exchange confirmed the order. Burn the trigger structure (in-memory) and enter
    // IN_TRADE BEFORE the Telegram round-trip settles and BEFORE any DB/REST bookkeeping,
    // so an SL hit inside that window is caught by the WS closure handlers.
    if (updatedPlan.structureDetails && updatedPlan.structureDetails.timestamp) {
      this.mitigatedStructures.push({
        type: (updatedPlan.structureDetails.type || 'CHoCH') as MitigatedStructure['type'],
        timestamp: updatedPlan.structureDetails.timestamp,
        price: updatedPlan.structureDetails.price?.toString() || updatedPlan.entryPrice.toString(),
        direction: updatedPlan.structureDetails.direction || (updatedPlan.side === 'Buy' ? 'BULLISH' : 'BEARISH'),
      });
      if (this.mitigatedStructures.length > 100) {
        this.mitigatedStructures = this.mitigatedStructures.slice(-100);
      }
      logger.info(`[${this.symbol}] Trigger structure burned on entry (timestamp=${updatedPlan.structureDetails.timestamp})`);
    }

    this.transition(StrategyState.IN_TRADE);

    try {
      // Fetch actual entry price from exchange (No Assumed Fill) — same as auto-trading.
      let actualEntryPrice = updatedPlan.entryPrice;
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const positions = await this.deps.client.getOpenPositions(this.symbol);
        if (positions.length > 0) {
          const pos = positions[0];
          if (pos.avgPrice && pos.avgPrice.gt(0)) {
            actualEntryPrice = pos.avgPrice.toString();
            logger.info(`[${this.symbol}] Actual entry price from exchange: ${actualEntryPrice} (planned: ${updatedPlan.entryPrice})`);
          }
        }
      } catch (e) {
        logger.warn(`[${this.symbol}] Failed to fetch actual entry price, using planned: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Adaptive Fractioning: persist the initial R:R + qty NOW. Without this the DB state
      // stays `{}` and evaluateTradeManagement() treats every trade as Classic (TotalR=0),
      // so the two-milestone Sniper branch (TotalR >= 4) can never activate live.
      const managementState = initializeTradeManagement(
        actualEntryPrice,
        updatedPlan.stopLoss,
        updatedPlan.takeProfit,
        updatedPlan.qty,
      );

      await this.deps.db.openTrade({
        id: result.orderId || tradeId,
        symbol: this.symbol,
        scenario_id: updatedPlan.scenarioId ?? null,
        entry_price: actualEntryPrice,
        sl_price: updatedPlan.stopLoss,
        tp_price: updatedPlan.takeProfit,
        qty: updatedPlan.qty,
        reason: `Scenario ${updatedPlan.scenarioId ?? 'N/A'}`,
        opened_at: Date.now(),
        side: updatedPlan.side,
        zone_type: updatedPlan.zoneDetails?.type ?? null,
        zone_top: updatedPlan.zoneDetails?.top?.toString() ?? null,
        zone_bottom: updatedPlan.zoneDetails?.bottom?.toString() ?? null,
        zone_timeframe: updatedPlan.zoneDetails?.timeframe ?? null,
        zone_direction: updatedPlan.zoneDetails?.direction ?? null,
        zone_timestamp: updatedPlan.zoneDetails?.timestamp ?? null,
        order_type: updatedPlan.orderType,
        limit_price: updatedPlan.limitPrice,
        management_state: managementState,
        order_id: result.orderId,
      });
      logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
      // No second transition: the engine is already IN_TRADE since the exchange confirmation.
    } catch (dbError) {
      // The order is live. Resetting to SCANNING without flattening would orphan the
      // position and burnSetup would mark a genuinely traded setup as aborted.
      logger.error(
        `[${this.symbol}] CRITICAL: order is live on the exchange but db.openTrade failed: ${dbError instanceof Error ? dbError.message : String(dbError)}. Attempting emergency flat close.`,
      );

      const flattened = await this.panicCloseOrphan({
        orderId: result.orderId ?? null,
        orderLinkId: result.orderLinkId,
        orderType: updatedPlan.orderType,
      });

      if (flattened) {
        logger.error(
          `[${this.symbol}] CRITICAL DB FAILURE: orphan exposure verified flat. Burning setup and resetting to SCANNING.`,
        );
        this.burnSetup(updatedPlan);
        this.plan = null;
        this.transition(StrategyState.SCANNING);
        return;
      }

      // Exposure could not be verified flat — keep the engine IN_TRADE (Invariant 23).
      logger.error(
        `[${this.symbol}] CRITICAL: emergency flat close FAILED. Engine remains ${this.state}; manual intervention required.`,
      );
    }
  }

  private async onExchangePositionClosed(pnl: string | null, wsExitPrice?: string): Promise<void> {
    // Dual-channel dedupe: the Position and Execution topics can both report the same closure.
    // Running the close pipeline once prevents duplicate PnL sums, REST round-trips and
    // Telegram notifications (Invariant 35 keeps BOTH channels subscribed).
    if (this.isClosingPosition) {
      logger.debug(`${this.symbol}: close event ignored — another close handler is already in flight`);
      return;
    }
    this.isClosingPosition = true;
    try {
      await this.processClosedPosition(pnl, wsExitPrice);
    } finally {
      this.isClosingPosition = false;
    }
  }

  private async processClosedPosition(pnl: string | null, wsExitPrice?: string): Promise<void> {
    const trade = await this.deps.db.getOpenTrade(this.symbol);
    if (!trade) {
      // ENTRY-PIPELINE OWNERSHIP — the state machine MUST NOT be touched here.
      //
      // `executeStagedEntry()` / `handleTradeApproval()` transition to IN_TRADE the
      // instant the exchange confirms the order (Invariant 47) and only write the
      // `trades` row afterwards — 500 ms wait, then `getOpenPositions()`, then the
      // DB round-trip. A WS Execution/Position close event landing inside that
      // window finds an empty table. Resetting to SCANNING here (the v2026-10-26
      // defect) handed the state machine away from the entry pipeline while the
      // bookkeeping was still in flight: the row then appeared one tick later and
      // the engine was left SCANNING with a live trade whose Adaptive Fractioning
      // was permanently disabled, riding an unmanaged position into a full SL.
      //
      // The event is dropped and the state is left exactly as the entry pipeline
      // (or the trade that is actually open) put it. If the position genuinely
      // closed during bookkeeping, the row lands as OPEN and the 10-minute
      // ReconciliationLoop detects the missing exchange position and closes it
      // safely (Invariant 27, §3.4). A bounded, self-healing delay is strictly
      // better than blinding the state machine mid-entry.
      logger.warn(
        `${this.symbol}: position close event but no open trade found — entry bookkeeping still in flight, state left as ${this.state}`,
      );
      return;
    }

    // Retry loop for PnL fetch - give Bybit up to 6 seconds (3 attempts × 2s) to finalize
    let closedPnls: any[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const endTime = Date.now();
        const startTime = trade.openedAt;
        const result = await this.deps.client.getClosedPnl(trade.symbol, startTime, endTime);
        closedPnls = result.filter(p => new Decimal(p.createdTime).gte(trade.openedAt));
        if (closedPnls.length > 0) break; // Found it, exit loop
      } catch (err) {
        logger.debug(`[${this.symbol}] PnL fetch attempt ${attempt} failed: ${err}`);
      }
    }

    let finalPnlString = pnl;
    let finalExitPrice: string | null = null;

    try {
      // === ACCURATE PNL: Fetch real closed PnL from Bybit (includes fees + funding) ===
      // Filter all closedPnl records for this symbol that were created after trade opened
      const relevantPnls = closedPnls.filter(p =>
        p.symbol === trade.symbol &&
        Number(p.createdTime) >= trade.openedAt
      );

      if (relevantPnls.length > 0) {
        // Sum all closedPnl values using Decimal for precision
        const totalClosedPnl = relevantPnls.reduce(
          (sum, p) => sum.plus(p.closedPnl),
          new Decimal('0')
        );

        // Use exitPrice from the record with the latest createdTime (last partial close)
        const lastRecord = relevantPnls.reduce((latest, current) =>
          Number(current.createdTime) > Number(latest.createdTime) ? current : latest
        );

        finalPnlString = totalClosedPnl.toFixed(8);
        finalExitPrice = lastRecord.exitPrice.toFixed(8);
        logger.info(`${this.symbol}: Using exchange closedPnl (with funding/fees): ${finalPnlString} vs WS pnl: ${pnl ?? 'null'}`);
      } else {
        logger.warn(`${this.symbol}: No matching closedPnl found, using WS PnL`);
      }

      // Ensure we never pass null to closeTrade - calculate fallback PnL if needed
      if (finalPnlString === null) {
        // Calculate PnL from trade data if exchange data unavailable
        const entryPrice = new Decimal(trade.entryPrice);
        const exitPriceStr = wsExitPrice ?? this.getLivePrice() ?? trade.entryPrice; // USE WS PRICE FIRST
        const exitPrice = new Decimal(exitPriceStr);
        const qty = new Decimal(trade.qty);
        const isLong = trade.side === 'Buy';

        if (isLong) {
          finalPnlString = exitPrice.minus(entryPrice).mul(qty).toFixed(8);
        } else {
          finalPnlString = entryPrice.minus(exitPrice).mul(qty).toFixed(8);
        }
        logger.warn(`[${this.symbol}] Calculated fallback PnL from trade data: ${finalPnlString}`);
      }

      if (finalExitPrice === null) {
        // Use live price as fallback for exit price. This is the single source
        // of the "Using fallback exit price" log — never log it twice.
        finalExitPrice = wsExitPrice ?? this.getLivePrice() ?? trade.entryPrice;
        logger.warn(`[${this.symbol}] Using fallback exit price: ${finalExitPrice}`);
      }

      // Determine close reason from PnL sign
      const pnlValue = new Decimal(finalPnlString || '0');
      const closeReason = pnlValue.lt(0) ? 'SL' : 'TP';
      await this.deps.db.closeTrade(trade.id, finalPnlString, finalExitPrice, Date.now(), closeReason);

      // Add the zone used for entry to mitigated zones
      if (trade.zoneDetails) {
        this.addMitigatedZone(trade.zoneDetails);
      }
      if (finalPnlString !== null) {
        await this.deps.notifier.notifyTradeClosed(this.symbol, finalPnlString, '0');
      } else {
        logger.warn(`${this.symbol}: position closed by exchange event, PnL unknown`);
      }
      logger.info(`${this.symbol}: IN_TRADE → SCANNING (position close event)`);

      // Set cooldown ONLY after stop-loss (negative PnL)
      if (pnlValue.lt(0)) {
        const tradeTfMinutes = this.deps.config.enableSniperMode ? 1 : timeframeToMinutes(this.deps.config.ltfTimeframe);
        const cooldownMs = this.deps.config.cooldownCandles * tradeTfMinutes * 60 * 1000;
        this.cooldownUntil = Date.now() + cooldownMs;
        const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
        const tfLabel = this.deps.config.enableSniperMode ? '1m (Sniper)' : `${tradeTfMinutes}m`;
        logger.info(`[${this.symbol}] Cooldown active after stop-loss. Skipping scan for ${cooldownHours}h (${this.deps.config.cooldownCandles} candles × ${tfLabel}).`);
      }
    } catch (error) {
      logger.error(`[${this.symbol}] Failed to process closed position: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // GUARANTEED STATE RESET
      this.transition(StrategyState.SCANNING);
      logger.info(`[${this.symbol}] Position closed processing finished. State reset to SCANNING.`);
    }
  }

  private burnSetup(plan: PositionPlan): void {
  if (!plan) {
    logger.warn(`[${this.symbol}] burnSetup called with null plan, skipping`);
    return;
  }
  
  let burnedZone = false;
  let burnedStructure = false;

  // 1. Burn Zone - use the actual types from PositionPlan (strings, not Decimals)
  const zd = plan.zoneDetails;
  if (zd && zd.type && zd.timestamp != null && zd.top != null && zd.bottom != null && zd.timeframe != null && zd.direction != null) {
    this.addMitigatedZone({
      type: zd.type,
      top: zd.top,
      bottom: zd.bottom,
      timeframe: zd.timeframe,
      direction: zd.direction,
      timestamp: zd.timestamp,
    });
    burnedZone = true;
  }

  // 2. Burn Structure
  const sd = plan.structureDetails;
  if (sd && sd.timestamp != null && sd.timestamp > 0) {
    this.mitigatedStructures.push({
      type: (sd.type || 'CHoCH') as MitigatedStructure['type'],
      timestamp: sd.timestamp,
      price: sd.price?.toString() || plan.entryPrice.toString(),
      direction: sd.direction || 'BULLISH',
    });
    burnedStructure = true;
  } else if (zd && zd.timestamp != null && zd.timestamp > 0 && zd.direction && (zd.direction === 'BULLISH' || zd.direction === 'BEARISH')) {
    // Fallback ONLY if no structure details
    this.mitigatedStructures.push({
      type: 'CHoCH',
      timestamp: zd.timestamp,
      price: plan.entryPrice.toString(),
      direction: zd.direction,
    });
    burnedStructure = true;
  }

  // Prevent memory leak
  if (this.mitigatedStructures.length > 100) {
    this.mitigatedStructures = this.mitigatedStructures.slice(-100);
  }

  // Honest logging
  if (burnedZone && burnedStructure) {
    logger.info(`[${this.symbol}] Setup burned: zone ${zd?.type} mitigated, structure added to mitigatedStructures`);
  } else if (burnedZone) {
    logger.info(`[${this.symbol}] Setup burned: ONLY zone ${zd?.type} mitigated (no structure)`);
  } else if (burnedStructure) {
    logger.info(`[${this.symbol}] Setup burned: ONLY structure added to mitigatedStructures (no zone)`);
  } else {
    logger.error(`[${this.symbol}] CRITICAL: burnSetup called but found neither valid zoneDetails nor structureDetails! Ghost signals may occur.`);
  }
}

  private addMitigatedZone(zoneDetails: any): void {
    const zone: MitigatedZone = {
      type: zoneDetails.type,
      top: zoneDetails.top.toString(),
      bottom: zoneDetails.bottom.toString(),
      timeframe: zoneDetails.timeframe,
      direction: zoneDetails.direction,
      timestamp: zoneDetails.timestamp,
    };
    this.mitigatedZones.push(zone);
    // Keep only last 100 mitigated zones to prevent memory leak
    if (this.mitigatedZones.length > 100) {
      this.mitigatedZones = this.mitigatedZones.slice(-100);
    }
  }

  /**
   * Clean up mitigated zones older than 14 days to prevent memory leak
   * Call this periodically (e.g., daily via macro context refresh)
   */
  cleanupMitigatedZones(): void {
    const now = Date.now();
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    const before = this.mitigatedZones.length;
    this.mitigatedZones = this.mitigatedZones.filter(
      zone => now - zone.timestamp < fourteenDaysMs
    );
    const removed = before - this.mitigatedZones.length;
    if (removed > 0) {
      logger.debug(`[${this.symbol}] Cleaned up ${removed} old mitigated zones (older than 14 days)`);
    }
  }

  private transition(state: StrategyState): void {
    this.state = state;
    if (state === StrategyState.SCANNING) {
      this.plan = null;
      this._activeSniperZone = null;
    }
    this.deps.db.setSymbolState(this.symbol, state).catch((err) =>
      logger.error(`Failed to update symbol state in DB: ${err}`),
    );
    logger.info(`${this.symbol}: state → ${state}`);
  }

  private async process(timeframe: Timeframe): Promise<void> {
    // Concurrency lock: prevent race condition between 1m and 15m candle processing
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Only evaluate on LTF confirmed candles for scenario matching
      const ltfInterval = this.deps.config.ltfTimeframe;
      const isSniper1m = this.deps.config.enableSniperMode && timeframe === '1';
      if (timeframe !== ltfInterval && !isSniper1m) return;

      // Only process in SCANNING state
      if (this.state !== StrategyState.SCANNING) return;

    // For Sniper Mode 1m execution, use 15m radar candles as LTF reference
    const candlesLtf = this.feedLtf.getCandles() as any[];
    const candlesHtf = this.feedHtf.getCandles() as any[];

    if (candlesLtf.length < 20 || candlesHtf.length < 20) return;

    let lastCandle: any;
    let candleTimestamp: number;

    if (isSniper1m) {
      // For 1m evaluation, use the latest 1m candle as trigger but 15m radar for levels
      const candles1m = this.feed1m.getCandles() as any[];
      lastCandle = candles1m[candles1m.length - 1];
      candleTimestamp = lastCandle?.timestamp ?? 0;
      
      // Deduplication for 1m: skip if already processed
      const timeDiff = Math.abs(candleTimestamp - this.lastProcessedCandleTimestamp);
      if (timeDiff < 60000 && this.lastProcessedCandleTimestamp > 0) {
        logger.debug(`[${this.symbol}] Skipping duplicate 1m candle at ${candleTimestamp} (diff: ${timeDiff}ms)`);
        return;
      }
    } else {
      // Normal 15m/4H evaluation
      lastCandle = candlesLtf[candlesLtf.length - 1];
      candleTimestamp = lastCandle?.timestamp ?? 0;

      // Deduplication: skip if we already processed this candle (within 1 minute window)
      const timeDiff = Math.abs(candleTimestamp - this.lastProcessedCandleTimestamp);
      if (timeDiff < 60000 && this.lastProcessedCandleTimestamp > 0) {
        logger.debug(`[${this.symbol}] Skipping duplicate/near-duplicate candle at ${candleTimestamp} (diff: ${timeDiff}ms)`);
        return;
      }
    }
    this.lastProcessedCandleTimestamp = candleTimestamp;

    // News Embargo check: skip scan if high-impact USD news is within 30 minutes
    if (this.deps.newsService.isNewsEmbargo(candleTimestamp)) {
      logger.info(`[${this.symbol}] ${isSniper1m ? '1m' : ltfInterval}m candle closed, but HIGH IMPACT NEWS EMBARGO is active. Skipping scan.`);
      return;
    }

    // Cooldown after SL hit
    const now = Date.now();
    if (this.cooldownUntil > 0 && this.cooldownUntil > now) {
      logger.info(`[${this.symbol}] Cooldown active after stop-loss. Skipping scan.`);
      return;
    }

    // Pass 1m candles to router if Sniper Mode is enabled
    const candles1m = this.deps.config.enableSniperMode ? [...this.feed1m.getCandles()] : [];

    const result = await this.scenarioRouter.evaluate(candlesLtf, candlesHtf, candleTimestamp, this.mitigatedZones, this.mitigatedStructures, candles1m);

    if (result.triggered && result.levels) {
      // Smart Pullback Entry: Determine order type based on price deviation from ideal entry
      const idealEntry = new Decimal(result.levels.entry);
      const currentPrice = new Decimal(lastCandle.close);
      const smartThreshold = new Decimal(this.deps.config.smartEntryThresholdPct); // e.g., 0.0015 = 0.15%
      const isLong = idealEntry.gt(new Decimal(result.levels.stopLoss));
      const useMarketOrder = shouldUseMarketEntry(idealEntry, currentPrice, isLong, smartThreshold);
      const priceDiffPct = idealEntry.minus(currentPrice).div(idealEntry).abs();

      const orderType = useMarketOrder ? 'Market' : 'Limit';
      const limitPrice = useMarketOrder
        ? null
        : formatPrice(idealEntry, new Decimal(this.deps.instrument.tickSize));
      
      logger.info(
        `[${this.symbol}] Smart Entry: idealEntry=${idealEntry.toFixed(4)} currentPrice=${currentPrice.toFixed(4)} diff=${priceDiffPct.mul(100).toFixed(4)}% threshold=${smartThreshold.mul(100).toFixed(2)}% -> ${orderType}${orderType === 'Limit' ? ` @ ${limitPrice}` : ''}`
      );

      const riskResult = await this.deps.riskManager.calculatePosition({
        symbol: this.symbol,
        // STRICT MATH: side determined by Entry vs SL geometry, not text direction
        side: idealEntry.gt(new Decimal(result.levels.stopLoss)) ? 'Buy' : 'Sell',
        entryPrice: idealEntry,
        stopLossRaw: new Decimal(result.levels.stopLoss),
        takeProfitRaw: new Decimal(result.levels.takeProfit),
        instrument: this.deps.instrument,
        zoneDetails: result.zoneDetails ? {
          type: result.zoneDetails.type,
          top: result.zoneDetails.top.toString(),
          bottom: result.zoneDetails.bottom.toString(),
          timeframe: result.zoneDetails.timeframe,
          direction: result.zoneDetails.direction,
          timestamp: result.zoneDetails.timestamp,
        } : null,
        orderType,
        limitPrice: limitPrice ?? undefined,
      });

      if (!riskResult.ok) {
        logger.warn(`${this.symbol}: setup discarded — ${riskResult.reason}`);
        this.transition(StrategyState.SCANNING);
        return;
      }

      const newPlan: PositionPlan = {
        ...riskResult.plan,
        scenarioId: result.scenario?.id ?? null,
        structureDetails: result.structureDetails ?? undefined,
      };
      this.plan = newPlan;

      logger.info(
        `${this.symbol}: ENTRY_STAGED plan qty=${riskResult.plan.qty} entry≈${riskResult.plan.entryPrice} sl=${riskResult.plan.stopLoss} tp=${riskResult.plan.takeProfit} [${result.scenario?.name}]`,
      );

      this.transition(StrategyState.ENTRY_STAGED);

      // Handle AUTO_TRADING logic
      if (this.deps.autoTrading) {
        // ZERO-LATENCY AUTO PATH: Do NOT call or await Telegram before execution!
        // Immediately execute on exchange
        await this.executeStagedEntry();
      } else {
        // Manual mode: queue for approval
        await this.deps.notifier.notifySetupFound(
          this.symbol,
          result.levels.entry,
          result.levels.stopLoss,
          result.levels.takeProfit,
          result.scenario?.id ?? 0,
          result.reason,
        );
        await this.queueForApproval(result);
      }
      return;
    }

    if (!result.triggered) {
      logger.info(`[${this.symbol}] Scan complete: no setups triggered.`);
    }
  } finally {
    this.isProcessing = false;
  }
}

  private async executeStagedEntry(): Promise<void> {
    if (!this.plan) return;

    // Strict Guard Clause: Must have live price for pre-flight checks
    // Attempt to get the absolute latest tick price
    // Fallback: 1m feed in Sniper Mode (max 1 min stale), otherwise LTF feed
    const fallbackFeed = this.deps.config.enableSniperMode ? this.feed1m.getCandles() : this.feedLtf.getCandles();
    const fallbackClose = fallbackFeed.length > 0 ? fallbackFeed[fallbackFeed.length - 1].close : undefined;

    const livePriceStr = this.getLivePrice() ?? fallbackClose;

    if (!livePriceStr) {
      logger.error(`[${this.symbol}] CRITICAL: Cannot determine live price for pre-flight check. Aborting execution to prevent blind firing.`);
      this.burnSetup(this.plan);
      this.plan = null;
      this.transition(StrategyState.SCANNING);
      return;
    }

    // Proceed with normal checks WITHOUT the 'if (livePriceStr)' wrapper
    const livePrice = new Decimal(livePriceStr);
    const sl = new Decimal(this.plan.stopLoss);
    const tp = new Decimal(this.plan.takeProfit);
    const entry = new Decimal(this.plan.entryPrice);
    const isLong = this.plan.side === 'Buy';

    // 1. Pre-flight SL breach check (unconditional for ALL orders) WITH spread buffer
    const slBuffer = livePrice.mul(new Decimal(this.deps.config.preflightBufferPct));
    const slBreached = isLong ? livePrice.lte(sl.plus(slBuffer)) : livePrice.gte(sl.minus(slBuffer));
    if (slBreached) {
      logger.info(`[${this.symbol}] Pre-flight DEAD SETUP (Auto): Live price (${livePriceStr}) breached SL (${this.plan.stopLoss}). Aborting & burning.`);
      this.burnSetup(this.plan);
      this.plan = null;
      this.transition(StrategyState.SCANNING);
      return;
    }

    // 2. Pre-flight TP reached check (unconditional for ALL orders)
    const tpReached = isLong ? livePrice.gte(tp) : livePrice.lte(tp);
    if (tpReached) {
      logger.info(`[${this.symbol}] Pre-flight DEAD SETUP (Auto): Live price (${livePriceStr}) already reached TP (${this.plan.takeProfit}). Aborting & burning.`);
      this.burnSetup(this.plan);
      this.plan = null;
      this.transition(StrategyState.SCANNING);
      return;
    }

    // Dynamic Market vs Limit Re-evaluation at Live Tick (BEFORE Slippage Guard)
    // This determines order type BEFORE checking slippage
    const idealEntry = new Decimal(this.plan.entryPrice);
    const threshold = new Decimal(this.deps.config.smartEntryThresholdPct || 0.0015);

    // Discount Trap: any favorable discount uses Market. At-entry/adverse prices
    // may use Market only while they remain inside the tight execution threshold.
    const useMarket = shouldUseMarketEntry(idealEntry, livePrice, isLong, threshold);

    // Create new PositionPlan with updated orderType and limitPrice (both are readonly)
    // Use instrument's tickSize for proper price formatting (anti-pattern 16.3)
    const limitPrice = useMarket
      ? null
      : formatPrice(idealEntry, new Decimal(this.deps.instrument.tickSize));

    this.plan = {
      ...this.plan,
      orderType: useMarket ? 'Market' : 'Limit',
      limitPrice,
    };

    // Slippage Guard toward TP (0.2% max acceptable deviation toward target)
    // ONLY for Market orders - Limit orders wait for pullback by design
    if (useMarket) {
      const priceMovedTowardTp = isLong ? livePrice.minus(entry) : entry.minus(livePrice);
      if (priceMovedTowardTp.gt(0)) {
        const deviationPct = priceMovedTowardTp.div(entry);
        if (deviationPct.gt(0.002)) { // > 0.2%
          logger.info(`[${this.symbol}] Slippage Guard (Auto): Market price moved ${deviationPct.mul(100).toFixed(3)}% toward TP. R:R degraded. Aborting & burning.`);
          this.burnSetup(this.plan);
          this.plan = null;
          this.transition(StrategyState.SCANNING);
          return;
        }
      }
    }

    logger.info(`${this.symbol}: AUTO_TRADING=true, executing staged entry (${useMarket ? 'Market' : 'Limit'})`);
    let orderLive = false;
    let liveOrderId: string | null = null;
    let liveOrderLinkId: string | null = null;
    let livePlanRef: PositionPlan | null = null;
    try {
      const result = await this.deps.executionEngine.execute(this.plan);
      if (!result.ok) {
        // AMBIGUOUS FAILURE: the submitter may have reached Bybit (timeout / retCode 0)
        // while the SDK reported an error. Verify by orderLinkId, never blind-reset.
        logger.warn(`[${this.symbol}] Auto-trading order rejected/ambiguous: ${result.reason}. Verifying exchange state via orderLinkId=${result.orderLinkId}`);
        const flattened = await this.panicCloseOrphan({
          orderLinkId: result.orderLinkId,
          orderType: this.plan.orderType,
          verifyFlat: true,
        });

        if (!flattened) {
          logger.error(`[${this.symbol}] CRITICAL: ambiguous order failure could NOT be verified flat. Engine remains ${this.state} for reconciliation supervision; manual intervention required.`);
          if (this.state !== StrategyState.IN_TRADE) {
            this.transition(StrategyState.IN_TRADE);
          }
          return;
        }

        logger.warn(`[${this.symbol}] Ambiguous order failure verified flat. Burning setup.`);
        this.burnSetup(this.plan);
        this.plan = null;
        this.transition(StrategyState.SCANNING);
        return;
      }

      // Exchange confirmed the order. Freeze the plan (a WS close event can null this.plan
      // once the state machine leaves ENTRY_STAGED) and enter IN_TRADE BEFORE any
      // Telegram/DB/REST bookkeeping. An SL hit inside the reconciliation window must be
      // visible to handleExecutionPayload/handlePositionPayload (both require IN_TRADE).
      orderLive = true;
      liveOrderId = result.orderId;
      liveOrderLinkId = result.orderLinkId;
      const livePlan = this.plan;
      livePlanRef = livePlan;

      // Burn the trigger structure immediately on entry (in-memory, zero latency).
      if (livePlan.structureDetails && livePlan.structureDetails.timestamp) {
        this.mitigatedStructures.push({
          type: (livePlan.structureDetails.type || 'CHoCH') as MitigatedStructure['type'],
          timestamp: livePlan.structureDetails.timestamp,
          price: livePlan.structureDetails.price?.toString() || livePlan.entryPrice.toString(),
          direction: livePlan.structureDetails.direction || (livePlan.side === 'Buy' ? 'BULLISH' : 'BEARISH'),
        });
        if (this.mitigatedStructures.length > 100) {
          this.mitigatedStructures = this.mitigatedStructures.slice(-100);
        }
        logger.info(`[${this.symbol}] Trigger structure burned on entry (timestamp=${livePlan.structureDetails.timestamp})`);
      }

      this.transition(StrategyState.IN_TRADE);

      // Fetch actual entry price from exchange to handle slippage (Market orders) or limit fills
      let actualEntryPrice = livePlan.entryPrice;
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const positions = await this.deps.client.getOpenPositions(this.symbol);
        if (positions.length > 0) {
          const pos = positions[0];
          if (pos.avgPrice && pos.avgPrice.gt(0)) {
            actualEntryPrice = pos.avgPrice.toString();
            logger.info(`[${this.symbol}] Actual entry price from exchange: ${actualEntryPrice} (planned: ${livePlan.entryPrice})`);
          }
        }
      } catch (e) {
        logger.warn(`[${this.symbol}] Failed to fetch actual entry price, using planned: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Adaptive Fractioning: persist the initial R:R + qty at entry (see manual path note).
      const managementState = initializeTradeManagement(
        actualEntryPrice,
        livePlan.stopLoss,
        livePlan.takeProfit,
        livePlan.qty,
      );

      await this.deps.db.openTrade({
        id: result.orderId,
        symbol: this.symbol,
        scenario_id: livePlan.scenarioId ?? null,
        entry_price: actualEntryPrice,
        sl_price: livePlan.stopLoss,
        tp_price: livePlan.takeProfit,
        qty: livePlan.qty,
        reason: `Scenario ${livePlan.scenarioId ?? 'N/A'}`,
        opened_at: Date.now(),
        side: livePlan.side,
        zone_type: livePlan.zoneDetails?.type ?? null,
        zone_top: livePlan.zoneDetails?.top?.toString() ?? null,
        zone_bottom: livePlan.zoneDetails?.bottom?.toString() ?? null,
        zone_timeframe: livePlan.zoneDetails?.timeframe ?? null,
        zone_direction: livePlan.zoneDetails?.direction ?? null,
        zone_timestamp: livePlan.zoneDetails?.timestamp ?? null,
        order_type: livePlan.orderType,
        limit_price: livePlan.limitPrice,
        management_state: managementState,
        order_id: result.orderId,
      });
      logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
      // No second transition: the state machine is already IN_TRADE since the exchange
      // confirmation. If a WS close event reset it to SCANNING meanwhile, do not clobber it.

      // NO notifySetupFound in auto-trading - execution notification is handled by ExecutionEngine
    } catch (error) {
      if (orderLive) {
        // The order is already live on the exchange. Resetting to SCANNING here would
        // orphan the position (Reconciliation only audits IN_TRADE engines and DB rows),
        // and burnSetup would incorrectly mark a genuinely traded setup as aborted.
        logger.error(
          `[${this.symbol}] CRITICAL: order is live on the exchange but post-execution bookkeeping failed: ${error instanceof Error ? error.message : String(error)}. Attempting emergency flat close.`,
        );

        // PANIC CLOSE: flatten the orphan so no unmanaged exposure survives the failure.
        // A reset to SCANNING is allowed only after the exchange is verified flat.
        const flattened = await this.panicCloseOrphan({
          orderId: liveOrderId,
          orderLinkId: liveOrderLinkId,
          orderType: livePlanRef?.orderType ?? 'Market',
        });

        if (flattened) {
          logger.error(
            `[${this.symbol}] CRITICAL DB FAILURE: orphan exposure verified flat. Burning setup and resetting to SCANNING.`,
          );
          const recoveryPlan = livePlanRef ?? this.plan;
          if (recoveryPlan) {
            this.burnSetup(recoveryPlan);
          }
          this.plan = null;
          this.transition(StrategyState.SCANNING);
          return;
        }

        // Exposure could not be verified flat. Keep the engine under state-machine
        // supervision (Invariant 23): resetting to SCANNING would recreate the zombie.
        logger.error(
          `[${this.symbol}] CRITICAL: emergency flat close FAILED. Engine remains ${this.state}; manual intervention required.`,
        );
        if (this.state !== StrategyState.IN_TRADE) {
          this.transition(StrategyState.IN_TRADE);
        }
        return;
      }
      logger.error(`[${this.symbol}] Exception during auto-trading execution: ${error instanceof Error ? error.message : String(error)}. Burning setup.`);
      if (this.plan) {
        this.burnSetup(this.plan);
      }
      this.plan = null;
      this.transition(StrategyState.SCANNING);
    }
  }

  /**
   * Emergency flat close for an order that reached the exchange but whose DB record
   * could not be written ("zombie position"). Cancels a still-resting limit order
   * first, then flattens any filled position with a reduce-only market order.
   *
   * Returns true ONLY when the exchange is verified flat and no live order remains.
   * A false result means exposure may still exist — the caller MUST keep the engine
   * IN_TRADE so Reconciliation and manual supervision can see it (Invariant 23).
   */
  private async panicCloseOrphan(ref: {
    orderId?: string | null;
    orderLinkId?: string | null;
    orderType: 'Market' | 'Limit';
    /** Ambiguous submission: no confirmed orderId and no settle window — poll for flatness. */
    verifyFlat?: boolean;
  }): Promise<boolean> {
    const { orderId, orderLinkId, orderType, verifyFlat } = ref;
    try {
      // 1. Cancel a resting LIMIT order first so a partially filled order cannot keep filling.
      // Market orders are IOC and can never rest, so they skip this REST round-trip entirely.
      // Matching accepts EITHER identifier: a post-fill failure knows orderId, while an
      // ambiguous submission failure (timeout / retCode 0) only knows orderLinkId.
      let orderCancelled = true;
      let cancelledOrder = false;
      if (orderType === 'Limit') {
        if (orderId || orderLinkId) {
          try {
            const openOrders = await this.deps.client.getOpenOrders(this.symbol);
            const liveOrder = openOrders.find(
              (order) =>
                ((orderId !== null && orderId !== undefined && order.orderId === orderId) ||
                  (orderLinkId !== null &&
                    orderLinkId !== undefined &&
                    order.orderLinkId === orderLinkId)) &&
                (order.status === 'New' || order.status === 'PartiallyFilled'),
            );
            if (liveOrder) {
              await this.deps.client.cancelOrder(this.symbol, liveOrder.orderId);
              cancelledOrder = true;
              logger.error(
                `[${this.symbol}] PANIC CANCEL: cancelled live ${liveOrder.orderType} order ${liveOrder.orderId} (status=${liveOrder.status}).`,
              );
            }
          } catch (cancelError) {
            orderCancelled = false;
            logger.error(
              `[${this.symbol}] PANIC CANCEL failed for order ${orderId ?? orderLinkId}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
            );
          }
        } else {
          orderCancelled = false;
        }
      }

      // 2. Flatten any filled exposure with a reduce-only market order.
      const positions = await this.deps.client.getOpenPositions(this.symbol);
      const openPosition = positions.find(
        (position) => position.symbol === this.symbol && position.size.gt(0),
      );

      if (openPosition) {
        const closeSide: 'Buy' | 'Sell' = openPosition.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = formatQuantity(
          openPosition.size,
          new Decimal(this.deps.instrument.qtyStep),
        );
        if (new Decimal(qty).lte(0)) {
          logger.error(
            `[${this.symbol}] PANIC CLOSE aborted: formatted qty is zero (size=${openPosition.size.toString()}, qtyStep=${this.deps.instrument.qtyStep}).`,
          );
          await this.notifyCriticalSafe(
            'CRITICAL DB FAILURE: Orphan position detected. Emergency Market Close FAILED (qty below instrument step) — manual intervention required.',
          );
          return false;
        }

        const orderLinkId = `${this.symbol}_panic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const closeOrderId = await this.deps.client.placeReduceOnlyMarketOrder({
          symbol: this.symbol,
          side: closeSide,
          qty,
          orderLinkId,
        });
        logger.error(
          `[${this.symbol}] PANIC CLOSE submitted: reduce-only ${closeSide} qty=${qty} orderId=${closeOrderId}`,
        );

        const flat = await this.isExchangeFlat();
        if (!flat) {
          logger.error(
            `[${this.symbol}] PANIC CLOSE submitted but the position is still open on the exchange.`,
          );
          await this.notifyCriticalSafe(
            'CRITICAL DB FAILURE: Orphan position detected. Emergency Market Close submitted but position is still open — manual intervention required.',
          );
          return false;
        }

        await this.notifyCriticalSafe(
          'CRITICAL DB FAILURE: Orphan position detected. Emergency Market Close executed.',
        );
        return orderCancelled;
      }

      // 3. No position: either the order was an unfilled limit (now cancelled) or the
      // exchange is already flat (SL/TP fired before bookkeeping completed).
      if (!orderCancelled) {
        await this.notifyCriticalSafe(
          'CRITICAL DB FAILURE: Could not verify/cancel the orphaned exchange order. Manual intervention required.',
        );
        return false;
      }

      // Ambiguous submission failures have no confirmed orderId and no 500 ms settle window:
      // Bybit may not yet reflect a just-filled IOC. Bounded polling confirms "strictly flat"
      // before the caller is allowed to reset to SCANNING (Invariant 49).
      if (verifyFlat === true && !cancelledOrder) {
        const flat = await this.isExchangeFlat();
        if (!flat) {
          logger.error(
            `[${this.symbol}] PANIC VERIFY: exchange still reports exposure after an ambiguous submission.`,
          );
          await this.notifyCriticalSafe(
            'CRITICAL DB FAILURE: Ambiguous order submission — exposure still detected on the exchange. Manual intervention required.',
          );
          return false;
        }
      }

      if (cancelledOrder) {
        await this.notifyCriticalSafe(
          'CRITICAL DB FAILURE: Orphan LIMIT order detected. Emergency Order Cancel executed.',
        );
      } else {
        await this.notifyCriticalSafe(
          'CRITICAL DB FAILURE: DB record missing, but the exchange is flat. No emergency order required.',
        );
      }
      return true;
    } catch (panicError) {
      logger.error(
        `[${this.symbol}] CRITICAL: emergency orphan close failed: ${panicError instanceof Error ? panicError.message : String(panicError)}`,
      );
      await this.notifyCriticalSafe(
        `CRITICAL DB FAILURE: Orphan position detected. Emergency Market Close FAILED — manual intervention required. (${panicError instanceof Error ? panicError.message : String(panicError)})`,
      );
      return false;
    }
  }

  /** Verify the exchange reports no open position for this symbol (bounded polling). */
  private async isExchangeFlat(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const positions = await this.deps.client.getOpenPositions(this.symbol);
      if (!positions.some((position) => position.symbol === this.symbol && position.size.gt(0))) {
        return true;
      }
    }
    return false;
  }

  /** Critical alert delivery that can never break the recovery path. */
  private async notifyCriticalSafe(message: string): Promise<void> {
    try {
      await this.deps.notifier.notifyCriticalError(message);
    } catch (error) {
      logger.error(
        `[${this.symbol}] Failed to deliver critical alert: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async queueForApproval(result: { levels: any; scenario?: any; reason: string; structureDetails?: any }): Promise<void> {
    if (!this.plan) return;

    logger.info(`${this.symbol}: AUTO_TRADING=false, queuing for manual approval`);
    
    const queued = await this.deps.pendingTradeManager.queueTrade(
      this.symbol,
      result.levels.entry,
      result.levels.stopLoss,
      result.levels.takeProfit,
      result.scenario?.id ?? 0,
      result.reason,
      this.plan.side,
      this.plan.qty,
      result.levels.entry,  // idealEntry for dynamic Market/Limit decision at approval time
      result.structureDetails,  // structureDetails for ghost signal mitigation
      this.deps.instrument.tickSize  // tickSize for proper limit price formatting
    );

    if (!queued) {
      logger.warn(`${this.symbol}: failed to queue trade for approval`);
      this.transition(StrategyState.SCANNING);
    }
  }

  async reconcile(positions: readonly { size: unknown }[]): Promise<boolean> {
    if (this.state !== StrategyState.IN_TRADE) return false;
    const hasOpenPosition = positions.some((position) => new Decimal(String(position.size)).gt(0));
    if (hasOpenPosition) return false;
    const trade = await this.deps.db.getOpenTrade(this.symbol);
    if (trade && trade.pnl === null) {
      // Calculate fallback PnL for reconciliation close
      const entryPrice = new Decimal(trade.entryPrice);
      const exitPrice = new Decimal(this.getLivePrice() ?? trade.entryPrice);
      const qty = new Decimal(trade.qty);
      const isLong = trade.side === 'Buy';
      
      let pnlString: string;
      if (isLong) {
        pnlString = exitPrice.minus(entryPrice).mul(qty).toFixed(8);
      } else {
        pnlString = entryPrice.minus(exitPrice).mul(qty).toFixed(8);
      }
      
      const exitPriceStr = this.getLivePrice() ?? trade.entryPrice;
      await this.deps.db.closeTrade(trade.id, pnlString, exitPriceStr, Date.now(), 'RECONCILIATION');

      // Cooldown after SL hit via reconciliation (uses execution timeframe: 1m for Sniper, LTF for Classic)
      if (new Decimal(pnlString).lt(0)) {
        const tradeTfMinutes = this.deps.config.enableSniperMode ? 1 : timeframeToMinutes(this.deps.config.ltfTimeframe);
        const cooldownMs = this.deps.config.cooldownCandles * tradeTfMinutes * 60 * 1000;
        this.cooldownUntil = Date.now() + cooldownMs;
        const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
        logger.info(`[${this.symbol}] Cooldown activated via reconciliation for ${cooldownHours}h (until ${new Date(this.cooldownUntil).toISOString()}).`);
      }
    }
    logger.info(`${this.symbol}: reconciliation force-reset IN_TRADE → SCANNING (no position on exchange)`);
    this.transition(StrategyState.SCANNING);
    return true;
  }

  async reconcileWithTrade(trade: {
    id: string;
    symbol: string;
    entryPrice: string;
    qty: string;
    side: 'Buy' | 'Sell';
    openedAt: number;
    orderId: string | null;
    order_type: string | null;
    zoneDetails: {
      type: string | null;
      top: Decimal | null;
      bottom: Decimal | null;
      timeframe: string | null;
      direction: string | null;
      timestamp: number | null;
    } | null;
  }): Promise<boolean> {
    // Fetch executions from Bybit to calculate PnL
    try {
      const endTime = Date.now();
      const startTime = trade.openedAt;
      const executions = await this.deps.client.getExecutions(trade.symbol, startTime, endTime);

      // Find closing executions (opposite side of our position)
      let totalPnl = new Decimal(0);
      let exitPrice: string | null = null;
      let foundClosingExecution = false;

      for (const exec of executions) {
        // For a LONG position (Buy), closing is SELL. For SHORT (Sell), closing is BUY.
        const isClosingExec = trade.side === 'Buy' ? exec.side === 'Sell' : exec.side === 'Buy';
        if (!isClosingExec) continue;
        if (exec.execQty.lte(0)) continue;

        // Calculate PnL from this closing execution
        const entryPrice = new Decimal(trade.entryPrice);
        const execPrice = exec.execPrice;
        const qty = exec.execQty;

        if (trade.side === 'Buy') {
          totalPnl = totalPnl.plus(execPrice.minus(entryPrice).mul(qty));
        } else {
          totalPnl = totalPnl.plus(entryPrice.minus(execPrice).mul(qty));
        }

        exitPrice = execPrice.toFixed(8);
        foundClosingExecution = true;
      }

      const calculatedPnlString = foundClosingExecution ? totalPnl.toFixed(8) : null;

      // === ACCURATE PNL: Fetch real closed PnL from Bybit (includes fees + funding) ===
      // Wait 2-3 seconds for exchange to finalize data
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      let finalPnlString = calculatedPnlString;
      let finalExitPrice = exitPrice;
      
      try {
        const closedPnls = await this.deps.client.getClosedPnl(trade.symbol, startTime, endTime);
        
// Find matching closed PnL records by symbol and createdTime after trade opened
      // Bybit closes position with a new order (different orderId), so match by symbol and createdTime
      // For Adaptive Fractioning (partial closes), we must SUM all PnL records for this trade
      let matchedPnl: { closedPnl: Decimal; exitPrice: Decimal } | null = null;
      
      // Filter all closedPnl records for this symbol that were created after trade opened
      const relevantPnls = closedPnls.filter(p => 
        p.symbol === trade.symbol && 
        Number(p.createdTime) >= trade.openedAt
      );
      
      if (relevantPnls.length > 0) {
        // Sum all closedPnl values using Decimal for precision
        const totalClosedPnl = relevantPnls.reduce(
          (sum, p) => sum.plus(p.closedPnl),
          new Decimal('0')
        );
        
        // Use exitPrice from the record with the latest createdTime (last partial close)
        const lastRecord = relevantPnls.reduce((latest, current) => 
          Number(current.createdTime) > Number(latest.createdTime) ? current : latest
        );
        
        matchedPnl = { 
          closedPnl: totalClosedPnl, 
          exitPrice: lastRecord.exitPrice 
        };
      }
        
        if (matchedPnl) {
          finalPnlString = matchedPnl.closedPnl.toFixed(8);
          finalExitPrice = matchedPnl.exitPrice.toFixed(8);
          logger.info(`${this.symbol}: Using exchange closedPnl (with funding/fees): ${finalPnlString} vs calculated: ${calculatedPnlString}`);
        } else {
          // NO PNL FOUND ON EXCHANGE
          // Check if this was a Limit order that was cancelled (no executions)
          if (trade.order_type === 'Limit') {
            logger.info(`[${this.symbol}] Limit order ${trade.id} has no closed PnL. Assuming CANCELLED unfilled.`);
            await this.deps.db.closeTrade(trade.id, '0', trade.entryPrice, Date.now(), 'CANCELLED');

            // Close the "Order Opened" Telegram loop with a distinct cancellation notice (best-effort)
            this.deps.notifier.notifyTradeClosed(this.symbol, '0', '0', 'CANCELLED').catch((e) => logger.error(`TG Notify error: ${e}`));

            this.transition(StrategyState.SCANNING);
            return true; // Reconciled
          }
          
          logger.warn(`${this.symbol}: No matching closedPnl found, using calculated PnL`);
        }
      } catch (pnlError) {
        logger.warn(`${this.symbol}: Failed to fetch closedPnl, using calculated: ${pnlError instanceof Error ? pnlError.message : String(pnlError)}`);
      }

      // Ensure we never pass null to closeTrade - use fallbacks
      if (finalPnlString === null) {
        const entryPrice = new Decimal(trade.entryPrice);
        const exitPrice = finalExitPrice ? new Decimal(finalExitPrice) : new Decimal(this.getLivePrice() ?? trade.entryPrice);
        const qty = new Decimal(trade.qty);
        const isLong = trade.side === 'Buy';
        
        if (isLong) {
          finalPnlString = exitPrice.minus(entryPrice).mul(qty).toFixed(8);
        } else {
          finalPnlString = entryPrice.minus(exitPrice).mul(qty).toFixed(8);
        }
        logger.warn(`${this.symbol}: reconciliation calculated fallback PnL: ${finalPnlString}`);
      }

      if (finalExitPrice === null) {
        finalExitPrice = this.getLivePrice() ?? trade.entryPrice;
        logger.warn(`${this.symbol}: reconciliation using fallback exit price: ${finalExitPrice}`);
      }

      // Close the trade in DB
      // Determine close reason from PnL sign
      const closeReason = finalPnlString !== null && new Decimal(finalPnlString).lt(0) ? 'SL' : 'TP';
      await this.deps.db.closeTrade(trade.id, finalPnlString, finalExitPrice, Date.now(), closeReason);

      // Cooldown after SL hit via reconciliation (uses execution timeframe: 1m for Sniper, LTF for Classic)
      if (finalPnlString !== null && new Decimal(finalPnlString).lt(0)) {
        const tradeTfMinutes = this.deps.config.enableSniperMode ? 1 : timeframeToMinutes(this.deps.config.ltfTimeframe);
        const cooldownMs = this.deps.config.cooldownCandles * tradeTfMinutes * 60 * 1000;
        this.cooldownUntil = Date.now() + cooldownMs;
        const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
        logger.info(`[${this.symbol}] Cooldown activated via reconciliation for ${cooldownHours}h (until ${new Date(this.cooldownUntil).toISOString()}).`);
      }

      // Notify Telegram
      if (finalPnlString !== null) {
        await this.deps.notifier.notifyTradeClosed(this.symbol, finalPnlString, '0');
        logger.info(`${this.symbol}: reconciliation closed trade ${trade.id} with PnL ${finalPnlString}`);
      } else {
        logger.warn(`${this.symbol}: reconciliation closed trade ${trade.id} but PnL unknown (no closing execution found)`);
      }

      // Add the zone used for entry to mitigated zones
      if (trade.zoneDetails) {
        this.addMitigatedZone(trade.zoneDetails);
      }

      // Reset state if this engine was in IN_TRADE
      if (this.state === StrategyState.IN_TRADE) {
        this.transition(StrategyState.SCANNING);
      }

      return true;
    } catch (error) {
      logger.error(`${this.symbol}: failed to calculate PnL for trade ${trade.id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

export function createStrategyEngine(deps: StrategyEngineDeps): StrategyEngine {
  return new StrategyEngine(deps);
}
