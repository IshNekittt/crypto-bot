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
import { InstrumentInfo, StrategyState, Timeframe, BotConfig, MitigatedZone, MitigatedStructure } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { evaluateTradeManagement } from '../risk/tradeManager';

export const WAITING_ANTI_STUCK_CANDLES_4H = 30;

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
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const events: ClosedPositionEvent[] = [];
  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    if (item.symbol !== ownSymbol) continue;
    const size = Number(item.size);
    const isOpen = Number.isFinite(size) && size > 0 && item.side !== 'None';
    if (isOpen) continue;
    const rawPnl = item.closedPnl ?? item.curRealisedPnl;
    events.push({ pnl: typeof rawPnl === 'string' ? rawPnl : null });
  }
  return events;
}

export class StrategyEngine {
  readonly symbol: string;
  private readonly deps: StrategyEngineDeps;
  private readonly feedLtf: CandleFeed;
  private readonly feedHtf: CandleFeed;
  private readonly feed1m: CandleFeed; // 1m candles for Sniper Mode
  private readonly scenarioRouter: ScenarioRouter;
  private state: StrategyState = StrategyState.SCANNING;
  private plan: PositionPlan | null = null;
  private processing = false;
  private isProcessing = false;
  private lastProcessedCandleTimestamp: number = 0;
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
    return this.feedLtf.getCurrentLivePrice()?.toString() || null;
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
        const livePriceStr = this.feedLtf.getCurrentLivePrice();
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
      livePrice: this.feedLtf.getCurrentLivePrice(),
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
      this.state = StrategyState.IN_TRADE;
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
    if (!update.confirmed) return;
    const htfInterval = this.deps.config.htfTimeframe;
    
    // Handle 1m candles for Sniper Mode
    if (update.interval === '1') {
      this.feed1m.applyKline(update);
      // Check trade management on every 1m candle if we have an open position
      if (this.state === StrategyState.IN_TRADE) {
        await this.checkAndManagePosition(update.candle.close);
      }
      
      // CRITICAL: If Sniper Mode enabled and we're scanning, evaluate on every 1m close
      if (this.deps.config.enableSniperMode && this.state === StrategyState.SCANNING) {
        await this.process('1' as Timeframe);
      }
      return;
    }

    const feed = update.interval === htfInterval ? this.feedHtf : this.feedLtf;
    const previousTimestamp = feed.getLastClosed()?.timestamp;
    feed.applyKline(update);
    if (feed.getLastClosed()?.timestamp === previousTimestamp) return;
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
   * Check and manage open position using adaptive fractioning logic
   * Called on every 1m candle when in IN_TRADE state
   */
  private async checkAndManagePosition(currentPrice: string): Promise<void> {
    if (this.state !== StrategyState.IN_TRADE) return;

    try {
      // Verify actual position exists on exchange before managing
      // This prevents managing unfilled limit orders
      const positions = await this.deps.client.getOpenPositions(this.symbol);
      const position = positions.find(p => p.symbol === this.symbol);
      if (!position || position.size.isZero()) {
        // No actual position on exchange (limit order not filled yet)
        return;
      }

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
        currentPrice,
        side: trade.side as 'Buy' | 'Sell',
        initialQty: trade.qty,
        managementState,
        instrument: this.deps.instrument,
      });

      if (signal.action === 'none') return;

      logger.info(`[${this.symbol}] Trade management signal: ${signal.action} - ${signal.reason}`);

      if (signal.action === 'move_sl_to_entry' || signal.action === 'trail_sl_to_profit') {
        if (signal.newStopLoss) {
          // Use setTradingStop for position SL/TP updates (not amendOrder which is for pending orders)
          await this.deps.client.setTradingStop({
            symbol: this.symbol,
            stopLoss: signal.newStopLoss,
          });
          
          // Update management state in DB
          await this.deps.db.updateTradeManagementState(trade.id, signal.updatedState);
          logger.info(`[${this.symbol}] Stop loss updated to ${signal.newStopLoss}`);
        }
      } else if (signal.action === 'close_partial_25' || signal.action === 'close_partial_50') {
        if (signal.closeQty) {
          // Place reduce-only market order to close partial position
          const closeSide = trade.side === 'Buy' ? 'Sell' : 'Buy';
          
          // Place reduce-only market order to close partial position
          await this.deps.executionEngine.executePartialClose({
            symbol: this.symbol,
            side: closeSide as 'Buy' | 'Sell',
            qty: signal.closeQty,
            orderLinkId: `partial_${Date.now()}`,
          });

          // Update management state in DB
          await this.deps.db.updateTradeManagementState(trade.id, signal.updatedState);
          logger.info(`[${this.symbol}] Partial close executed: ${signal.closeQty} ${trade.side === 'Buy' ? 'Sell' : 'Buy'}`);
          
          // If we also need to move SL
          if (signal.newStopLoss) {
            await this.deps.client.setTradingStop({
              symbol: this.symbol,
              stopLoss: signal.newStopLoss,
            });
            await this.deps.db.updateTradeManagementState(trade.id, signal.updatedState);
          }
        }
      }
    } catch (error) {
      logger.error(`[${this.symbol}] Trade management error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async handlePositionPayload(payload: unknown): Promise<void> {
    if (this.state !== StrategyState.IN_TRADE) return;
    const closedEvents = parseClosedPositions(payload, this.symbol);
    if (closedEvents.length === 0) return;
    try {
      await this.onExchangePositionClosed(closedEvents[0].pnl);
    } catch (error) {
      logger.error(
        `${this.symbol}: failed to process position close event: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const currentPrice = this.feedLtf.getCurrentLivePrice();
    if (currentPrice) {
      const currentPriceDecimal = new Decimal(currentPrice);
      const slDecimal = new Decimal(this.plan.stopLoss);
      const isLong = this.plan.side === 'Buy';

      if (isLong && currentPriceDecimal.lte(slDecimal)) {
        logger.warn(`[${this.symbol}] Setup DEAD: Live price (${currentPrice}) is already below SL (${this.plan.stopLoss})`);
        this.burnSetup(this.plan);
        this.transition(StrategyState.SCANNING);
        return;
      }
      if (!isLong && currentPriceDecimal.gte(slDecimal)) {
        logger.warn(`[${this.symbol}] Setup DEAD: Live price (${currentPrice}) is already above SL (${this.plan.stopLoss})`);
        this.burnSetup(this.plan);
        this.transition(StrategyState.SCANNING);
        return;
      }
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
      logger.error(`${this.symbol}: order execution failed after approval: ${result.reason}`);
      await this.burnSetup(this.plan);
      this.transition(StrategyState.SCANNING);
      return;
    }

    try {
      await this.deps.db.openTrade({
        id: result.orderId || tradeId,
        symbol: this.symbol,
        scenario_id: updatedPlan.scenarioId ?? null,
        entry_price: updatedPlan.entryPrice,
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
        order_id: result.orderId,
      });
      logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
      this.transition(StrategyState.IN_TRADE);
    } catch (dbError) {
      logger.error(`${this.symbol}: DB openTrade failed, burning setup: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
      await this.burnSetup(this.plan);
      this.transition(StrategyState.SCANNING);
    }
  }

  private async onExchangePositionClosed(pnl: string | null): Promise<void> {
    const trade = await this.deps.db.getOpenTrade(this.symbol);
    if (!trade) {
      logger.warn(`${this.symbol}: position close event but no open trade found`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    // === ACCURATE PNL: Fetch real closed PnL from Bybit (includes fees + funding) ===
    // Wait 2-3 seconds for exchange to finalize data
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    let finalPnlString = pnl;
    let finalExitPrice: string | null = null;
    
    try {
      const endTime = Date.now();
      const startTime = trade.openedAt;
      const closedPnls = await this.deps.client.getClosedPnl(trade.symbol, startTime, endTime);
      
// Find matching closed PnL records by symbol and createdTime after trade opened
      // Bybit closes position with a new order (different orderId), so match by symbol and createdTime
      // For Adaptive Fractioning (partial closes), we must SUM all PnL records for this trade
      let matchedPnl: { closedPnl: Decimal; exitPrice: Decimal } | null = null;
      
      // Filter all closedPnl records for this symbol that were created after trade opened
      const relevantPnls = closedPnls.filter(p => 
        p.symbol === trade.symbol && 
        Number(p.closedTime) >= trade.openedAt
      );
      
      if (relevantPnls.length > 0) {
        // Sum all closedPnl values using Decimal for precision
        const totalClosedPnl = relevantPnls.reduce(
          (sum, p) => sum.plus(p.closedPnl),
          new Decimal('0')
        );
        
        // Use exitPrice from the record with the latest closedTime (last partial close)
        const lastRecord = relevantPnls.reduce((latest, current) => 
          Number(current.closedTime) > Number(latest.closedTime) ? current : latest
        );
        
        matchedPnl = { 
          closedPnl: totalClosedPnl, 
          exitPrice: lastRecord.exitPrice 
        };
      }
      
      if (matchedPnl) {
        finalPnlString = matchedPnl.closedPnl.toFixed(8);
        finalExitPrice = matchedPnl.exitPrice.toFixed(8);
        logger.info(`${this.symbol}: Using exchange closedPnl (with funding/fees): ${finalPnlString} vs WS pnl: ${pnl ?? 'null'}`);
      } else {
        logger.warn(`${this.symbol}: No matching closedPnl found, using WS PnL`);
      }
    } catch (pnlError) {
      logger.warn(`${this.symbol}: Failed to fetch closedPnl, using WS PnL: ${pnlError instanceof Error ? pnlError.message : String(pnlError)}`);
    }

    // Ensure we never pass null to closeTrade - calculate fallback PnL if needed
    if (finalPnlString === null) {
      // Calculate PnL from trade data if exchange data unavailable
      const entryPrice = new Decimal(trade.entryPrice);
      const exitPrice = finalExitPrice ? new Decimal(finalExitPrice) : new Decimal(this.getLivePrice() ?? trade.entryPrice);
      const qty = new Decimal(trade.qty);
      const isLong = trade.side === 'Buy';
      
      if (isLong) {
        finalPnlString = exitPrice.minus(entryPrice).mul(qty).toFixed(8);
      } else {
        finalPnlString = entryPrice.minus(exitPrice).mul(qty).toFixed(8);
      }
      logger.warn(`${this.symbol}: Calculated fallback PnL from trade data: ${finalPnlString}`);
    }

if (finalExitPrice === null) {
        // Use live price as fallback for exit price
        finalExitPrice = this.getLivePrice() ?? trade.entryPrice;
        logger.warn(`${this.symbol}: Using fallback exit price: ${finalExitPrice}`);
      }

    // Determine close reason from PnL sign
    const closeReason = finalPnlString !== null && new Decimal(finalPnlString).lt(0) ? 'SL' : 'TP';
    await this.deps.db.closeTrade(trade.id, finalPnlString, finalExitPrice, Date.now(), closeReason);

    // Add the zone used for entry to mitigated zones
    if (trade.zoneDetails) {
      this.addMitigatedZone(trade.zoneDetails);
    }
    if (finalPnlString !== null) {
      await this.deps.notifier.notifyTradeClosed(this.symbol, finalPnlString, '0%');
    } else {
      logger.warn(`${this.symbol}: position closed by exchange event, PnL unknown`);
    }
    logger.info(`${this.symbol}: IN_TRADE → SCANNING (position close event)`);

    // Set cooldown after SL hit (cooldownCandles * ltfTimeframe minutes)
    if (finalPnlString !== null && new Decimal(finalPnlString).lt(0)) {
      const ltfMinutes = Number(this.deps.config.ltfTimeframe);
      const cooldownMs = this.deps.config.cooldownCandles * ltfMinutes * 60 * 1000;
      this.cooldownUntil = Date.now() + cooldownMs;
      const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
      logger.info(`[${this.symbol}] Cooldown active after stop-loss. Skipping scan for ${cooldownHours}h (${this.deps.config.cooldownCandles} candles × ${ltfMinutes}m).`);
    }

    this.transition(StrategyState.SCANNING);
  }

  private burnSetup(plan: PositionPlan): void {
    if (!plan || !plan.zoneDetails) {
      logger.warn(`[${this.symbol}] burnSetup called with invalid plan, skipping`);
      return;
    }
    const zd = plan.zoneDetails;
    // Add zone to mitigatedZones to prevent re-entry
    if (zd.type && zd.top && zd.bottom && zd.timeframe && zd.direction && zd.timestamp != null) {
      this.addMitigatedZone({
        type: zd.type,
        top: zd.top.toString(),
        bottom: zd.bottom.toString(),
        timeframe: zd.timeframe,
        direction: zd.direction,
        timestamp: zd.timestamp,
      });

      // Add structure to mitigatedStructures if available
      // Prefer structureDetails from plan if available (more accurate)
      if (plan.structureDetails) {
        const sd = plan.structureDetails;
        if (sd.timestamp != null && sd.timestamp > 0) {
          this.mitigatedStructures.push({
            type: (sd.type || 'CHoCH') as 'CHoCH' | 'SMS' | 'BOS',
            timestamp: sd.timestamp,
            price: sd.price?.toString() || plan.entryPrice.toString(),
            direction: sd.direction || 'BULLISH',
          });
        }
      } else if (zd.timestamp > 0 && (zd.direction === 'BULLISH' || zd.direction === 'BEARISH')) {
        // Fallback to zoneDetails if structureDetails not available
        this.mitigatedStructures.push({
          type: 'CHoCH',
          timestamp: zd.timestamp,
          price: plan.entryPrice.toString(),
          direction: zd.direction,
        });
      }
      // Keep only last 100 to prevent memory leak
      if (this.mitigatedStructures.length > 100) {
        this.mitigatedStructures = this.mitigatedStructures.slice(-100);
      }
      
      logger.warn(`[${this.symbol}] Setup burned: zone ${zd.type} mitigated, structure added to mitigatedStructures`);
    } else {
      logger.warn(`[${this.symbol}] burnSetup skipped: zoneDetails incomplete`);
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
    }
    void this.deps.db.setSymbolState(this.symbol, state);
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

    const result = await this.scenarioRouter.evaluate(candlesLtf, candlesHtf, candleTimestamp, this.mitigatedZones, [], candles1m);

    if (result.triggered && result.levels) {
      // Smart Pullback Entry: Determine order type based on price deviation from ideal entry
      const idealEntry = new Decimal(result.levels.entry);
      const currentPrice = new Decimal(lastCandle.close);
      const smartThreshold = new Decimal(this.deps.config.smartEntryThresholdPct); // e.g., 0.0015 = 0.15%
      
      const priceDiffPct = idealEntry.minus(currentPrice).div(idealEntry).abs();
      const useMarketOrder = priceDiffPct.lte(smartThreshold);
      
      const orderType = useMarketOrder ? 'Market' : 'Limit';
      const limitPrice = useMarketOrder ? null : idealEntry.toFixed(8);
      
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
      };
      this.plan = newPlan;

      logger.info(
        `${this.symbol}: ENTRY_STAGED plan qty=${riskResult.plan.qty} entry≈${riskResult.plan.entryPrice} sl=${riskResult.plan.stopLoss} tp=${riskResult.plan.takeProfit} [${result.scenario?.name}]`,
      );

      // Send setup found notification (always)
      await this.deps.notifier.notifySetupFound(
        this.symbol,
        result.levels.entry,
        result.levels.stopLoss,
        result.levels.takeProfit,
        result.scenario?.id ?? 0,
        result.reason,
      );

      this.transition(StrategyState.ENTRY_STAGED);

      // Handle AUTO_TRADING logic
      if (this.deps.autoTrading) {
        // Auto mode: execute immediately
        await this.executeStagedEntry();
      } else {
        // Manual mode: queue for approval
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

    logger.info(`${this.symbol}: AUTO_TRADING=true, executing staged entry`);
    const result = await this.deps.executionEngine.execute(this.plan);
    if (!result.ok) {
      this.transition(StrategyState.SCANNING);
      return;
    }

    await this.deps.db.openTrade({
      id: result.orderId,
      symbol: this.symbol,
      scenario_id: this.plan.scenarioId ?? null,
      entry_price: this.plan.entryPrice,
      sl_price: this.plan.stopLoss,
      tp_price: this.plan.takeProfit,
      qty: this.plan.qty,
      reason: `Scenario ${this.plan.scenarioId ?? 'N/A'}`,
      opened_at: Date.now(),
      side: this.plan.side,
      zone_type: this.plan.zoneDetails?.type ?? null,
      zone_top: this.plan.zoneDetails?.top?.toString() ?? null,
      zone_bottom: this.plan.zoneDetails?.bottom?.toString() ?? null,
      zone_timeframe: this.plan.zoneDetails?.timeframe ?? null,
      zone_direction: this.plan.zoneDetails?.direction ?? null,
      zone_timestamp: this.plan.zoneDetails?.timestamp ?? null,
      order_type: this.plan.orderType,
      limit_price: this.plan.limitPrice,
      order_id: result.orderId,
    });
    logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
    this.transition(StrategyState.IN_TRADE);
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
      result.structureDetails  // structureDetails for ghost signal mitigation
    );

    if (!queued) {
      logger.warn(`${this.symbol}: failed to queue trade for approval`);
      this.transition(StrategyState.SCANNING);
    }
  }

  async reconcile(positions: readonly { size: unknown }[]): Promise<boolean> {
    if (this.state !== StrategyState.IN_TRADE) return false;
    const hasOpenPosition = positions.some((position) => Number(position.size) > 0);
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
    }
    logger.warn(`${this.symbol}: reconciliation force-reset IN_TRADE → SCANNING (no position on exchange)`);
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
        Number(p.closedTime) >= trade.openedAt
      );
      
      if (relevantPnls.length > 0) {
        // Sum all closedPnl values using Decimal for precision
        const totalClosedPnl = relevantPnls.reduce(
          (sum, p) => sum.plus(p.closedPnl),
          new Decimal('0')
        );
        
        // Use exitPrice from the record with the latest closedTime (last partial close)
        const lastRecord = relevantPnls.reduce((latest, current) => 
          Number(current.closedTime) > Number(latest.closedTime) ? current : latest
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

      // Notify Telegram
      if (finalPnlString !== null) {
        await this.deps.notifier.notifyTradeClosed(this.symbol, finalPnlString, '0%');
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