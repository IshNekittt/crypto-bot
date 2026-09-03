import { BybitClient } from '../api/bybitClient';
import { KlineUpdate } from '../api/wsClient';
import { ExecutionEngine } from '../execution/executionEngine';
import { CandleFeed } from '../feed/candleFeed';
import { PostgresDatabase } from '../db/database';
import { PositionPlan, RiskManager } from '../risk/riskManager';
import { ScenarioRouter } from './scenarioRouter';
import { TelegramNotifier } from '../telegram/notifier';
import { PendingTradeManager } from './pendingTradeManager';
import { InstrumentInfo, StrategyState, Timeframe } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';

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
  private readonly feed15m: CandleFeed;
  private readonly feed4h: CandleFeed;
  private readonly scenarioRouter: ScenarioRouter;
  private state: StrategyState = StrategyState.SCANNING;
  private plan: PositionPlan | null = null;
  private processing = false;

  constructor(deps: StrategyEngineDeps) {
    this.symbol = deps.symbol;
    this.deps = deps;
    this.feed15m = new CandleFeed(deps.symbol, '15', 200);
    this.feed4h = new CandleFeed(deps.symbol, '240', 200);

    this.scenarioRouter = new ScenarioRouter({
      symbol: deps.symbol,
      patternRecognizer: deps.patternRecognizer,
      notifier: deps.notifier,
    });
  }

  getState(): StrategyState {
    return this.state;
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
    await this.feed15m.loadHistory(this.deps.client);
    await this.feed4h.loadHistory(this.deps.client);
    logger.info(
      `${this.symbol}: history ready (15m=${this.feed15m.getCandles().length}, 4h=${this.feed4h.getCandles().length})`,
    );
  }

  async handleKline(update: KlineUpdate): Promise<void> {
    if (!update.confirmed) return;
    const feed = update.interval === '240' ? this.feed4h : this.feed15m;
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
    const handled = this.deps.pendingTradeManager.handleApproval(tradeId, approved);
    if (!handled) {
      logger.warn(`${this.symbol}: approval for unknown/expired trade ${tradeId}`);
      return;
    }

    if (!approved) {
      logger.info(`${this.symbol}: trade ${tradeId} rejected by user`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    // Approved - execute the trade
    if (!this.plan) {
      logger.error(`${this.symbol}: no plan for approved trade ${tradeId}`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    logger.info(`${this.symbol}: trade ${tradeId} approved, executing market order`);
    const result = await this.deps.executionEngine.execute(this.plan);
    if (!result.ok) {
      logger.error(`${this.symbol}: order execution failed after approval: ${result.reason}`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    await this.deps.db.openTrade({
      symbol: this.symbol,
      scenario_id: this.plan.scenarioId ?? null,
      entry_price: this.plan.entryPrice,
      sl_price: this.plan.stopLoss,
      tp_price: this.plan.takeProfit,
      qty: this.plan.qty,
      reason: `Scenario ${this.plan.scenarioId ?? 'N/A'}`,
      opened_at: Date.now(),
      side: this.plan.side,
    });
    logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
    this.transition(StrategyState.IN_TRADE);
  }

  private async onExchangePositionClosed(pnl: string | null): Promise<void> {
    const trade = await this.deps.db.getOpenTrade(this.symbol);
    if (trade) {
      await this.deps.db.closeTrade(trade.id, pnl, null, Date.now());
    }
    if (pnl !== null) {
      await this.deps.notifier.notifyTradeClosed(this.symbol, pnl, '0%');
    } else {
      logger.warn(`${this.symbol}: position closed by exchange event, PnL unknown`);
    }
    logger.info(`${this.symbol}: IN_TRADE → SCANNING (position close event)`);
    this.transition(StrategyState.SCANNING);
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
    // Only evaluate on 15m confirmed candles for scenario matching
    if (timeframe !== '15') return;

    if (this.state === StrategyState.IN_TRADE) return;
    if (this.state === StrategyState.ENTRY_STAGED) return;

    const candles15m = this.feed15m.getCandles() as any[];
    const candles4h = this.feed4h.getCandles() as any[];

    if (candles15m.length < 20 || candles4h.length < 20) return;

    const result = await this.scenarioRouter.evaluate(candles15m, candles4h);

    if (result.triggered && result.levels) {
      const riskResult = await this.deps.riskManager.calculatePosition({
        symbol: this.symbol,
        side: 'Buy',
        entryPrice: new Decimal(result.levels.entry),
        stopLossRaw: new Decimal(result.levels.stopLoss),
        instrument: this.deps.instrument,
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
      logger.debug(`No scenario matched`, {
        symbol: this.symbol,
        reason: result.reason,
      });
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
      symbol: this.symbol,
      scenario_id: this.plan.scenarioId ?? null,
      entry_price: this.plan.entryPrice,
      sl_price: this.plan.stopLoss,
      tp_price: this.plan.takeProfit,
      qty: this.plan.qty,
      reason: `Scenario ${this.plan.scenarioId ?? 'N/A'}`,
      opened_at: Date.now(),
      side: this.plan.side,
    });
    logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
    this.transition(StrategyState.IN_TRADE);
  }

  private async queueForApproval(result: { levels: any; scenario?: any; reason: string }): Promise<void> {
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
      await this.deps.db.closeTrade(trade.id, null, null, Date.now());
    }
    logger.warn(`${this.symbol}: reconciliation force-reset IN_TRADE → SCANNING (no position on exchange)`);
    this.transition(StrategyState.SCANNING);
    return true;
  }

  async reconcileWithTrade(trade: {
    id: number;
    symbol: string;
    entryPrice: string;
    qty: string;
    side: 'Buy' | 'Sell';
    openedAt: number;
    orderId: string | null;
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

      const pnlString = foundClosingExecution ? totalPnl.toFixed(8) : null;

      // Close the trade in DB
      await this.deps.db.closeTrade(trade.id, pnlString, exitPrice, Date.now());

      // Notify Telegram
      if (pnlString !== null) {
        await this.deps.notifier.notifyTradeClosed(this.symbol, pnlString, '0%');
        logger.info(`${this.symbol}: reconciliation closed trade ${trade.id} with PnL ${pnlString}`);
      } else {
        logger.warn(`${this.symbol}: reconciliation closed trade ${trade.id} but PnL unknown (no closing execution found)`);
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