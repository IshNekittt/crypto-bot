import { BybitClient } from '../api/bybitClient';
import { KlineUpdate } from '../api/wsClient';
import { ExecutionEngine } from '../execution/executionEngine';
import { CandleFeed } from '../feed/candleFeed';
import { StateDatabase } from '../db/database';
import { PositionPlan, RiskManager } from '../risk/riskManager';
import {
  calculateStopLoss,
  detectStructureBreaks,
  findFVGs,
  findOrderBlocks,
  hasRecentLiquiditySweep,
} from '../smc/smc';
import { TelegramNotifier } from '../telegram/notifier';
import {
  Direction,
  FVG,
  InstrumentInfo,
  OrderBlock,
  StrategyState,
  Timeframe,
} from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';

export const WAITING_ANTI_STUCK_CANDLES_4H = 30;

export interface StrategyEngineDeps {
  readonly symbol: string;
  readonly instrument: InstrumentInfo;
  readonly client: BybitClient;
  readonly db: StateDatabase;
  readonly riskManager: RiskManager;
  readonly executionEngine: ExecutionEngine;
  readonly notifier: TelegramNotifier;
}

interface SetupContext {
  direction: Direction;
  orderBlock4h: OrderBlock;
  waitingCandlesCount4h: number;
  orderBlock15m: OrderBlock | null;
  fvg15m: FVG | null;
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

function bodyClosesBeyond(candle: { close: string }, block: OrderBlock, direction: Direction): boolean {
  const close = new Decimal(candle.close);
  return direction === 'BULLISH'
    ? close.lessThan(block.bottom)
    : close.greaterThan(block.top);
}

export class StrategyEngine {
  readonly symbol: string;
  private readonly deps: StrategyEngineDeps;
  private readonly feed15m: CandleFeed;
  private readonly feed4h: CandleFeed;
  private state: StrategyState = StrategyState.SCANNING;
  private setup: SetupContext | null = null;
  private plan: PositionPlan | null = null;
  private processing = false;

  constructor(deps: StrategyEngineDeps) {
    this.symbol = deps.symbol;
    this.deps = deps;
    this.feed15m = new CandleFeed(deps.symbol, '15', 200);
    this.feed4h = new CandleFeed(deps.symbol, '240', 200);
  }

  getState(): StrategyState {
    return this.state;
  }

  async initialize(): Promise<void> {
    await this.reloadHistory();
    const saved = this.deps.db.getSymbolState(this.symbol);
    const openTrade = this.deps.db.getOpenTrade(this.symbol);
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

  private async onExchangePositionClosed(pnl: string | null): Promise<void> {
    const trade = this.deps.db.getOpenTrade(this.symbol);
    if (trade) {
      this.deps.db.closeTrade(trade.id, pnl, null, Date.now());
    }
    if (pnl !== null) {
      await this.deps.notifier.notifyTradeClosed(pnl);
    } else {
      logger.warn(`${this.symbol}: position closed by exchange event, PnL unknown`);
    }
    logger.info(`${this.symbol}: IN_TRADE → SCANNING (position close event)`);
    this.transition(StrategyState.SCANNING);
  }

  private transition(state: StrategyState): void {
    this.state = state;
    if (state === StrategyState.SCANNING) {
      this.setup = null;
      this.plan = null;
    }
    this.deps.db.setSymbolState(this.symbol, state);
    logger.info(`${this.symbol}: state → ${state}`);
  }

  private last4h() {
    return this.feed4h.getLastClosed();
  }

  private last15m() {
    return this.feed15m.getLastClosed();
  }

  private async process(timeframe: Timeframe): Promise<void> {
    switch (this.state) {
      case StrategyState.SCANNING:
        if (timeframe === '240') await this.scan();
        return;
      case StrategyState.WAITING:
        if (timeframe === '240') this.checkWaiting();
        return;
      case StrategyState.CONFIRMATION:
        if (timeframe === '15') await this.checkConfirmation();
        else this.check4hInvalidation();
        return;
      case StrategyState.ENTRY_STAGED:
        if (timeframe === '15') await this.checkEntryTrigger();
        else this.check4hInvalidation();
        return;
      case StrategyState.IN_TRADE:
        return;
    }
  }

  private async scan(): Promise<void> {
    const candles = this.feed4h.getCandles();
    const breaks = detectStructureBreaks(candles);
    if (breaks.length === 0) return;
    const blocks = findOrderBlocks(candles, breaks)
      .filter((block) => !block.invalidated)
      .sort((a, b) => b.breakEvent.candleIndex - a.breakEvent.candleIndex);
    const latest = blocks[0];
    if (!latest) return;
    this.setup = {
      direction: latest.direction,
      orderBlock4h: latest,
      waitingCandlesCount4h: 0,
      orderBlock15m: null,
      fvg15m: null,
    };
    logger.info(
      `${this.symbol}: found ${latest.direction} 4H OB [${latest.bottom.toFixed()}..${latest.top.toFixed()}]`,
    );
    this.transition(StrategyState.WAITING);
  }

  private checkWaiting(): void {
    const candle = this.last4h();
    const setup = this.setup;
    if (!candle || !setup) {
      this.transition(StrategyState.SCANNING);
      return;
    }
    if (bodyClosesBeyond(candle, setup.orderBlock4h, setup.direction)) {
      logger.info(`${this.symbol}: 4H OB invalidated by body close, back to scanning`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    setup.waitingCandlesCount4h += 1;
    const touched = new Decimal(candle.low).lessThanOrEqualTo(setup.orderBlock4h.top)
      && new Decimal(candle.high).greaterThanOrEqualTo(setup.orderBlock4h.bottom);

    if (touched) {
      logger.info(
        `${this.symbol}: price touched 4H OB [${setup.orderBlock4h.bottom.toFixed()}..${setup.orderBlock4h.top.toFixed()}]`,
      );
      this.transition(StrategyState.CONFIRMATION);
      return;
    }

    if (setup.waitingCandlesCount4h >= WAITING_ANTI_STUCK_CANDLES_4H) {
      logger.info(`${this.symbol}: anti-stuck timeout (${WAITING_ANTI_STUCK_CANDLES_4H}x4H without touch), back to scanning`);
      this.transition(StrategyState.SCANNING);
    }
  }

  private check4hInvalidation(): void {
    const setup = this.setup;
    const candle = this.last4h();
    if (!setup || !candle) return;
    if (bodyClosesBeyond(candle, setup.orderBlock4h, setup.direction)) {
      logger.info(`${this.symbol}: 4H OB invalidated while in ${this.state}, back to scanning`);
      this.transition(StrategyState.SCANNING);
    }
  }

  private async checkConfirmation(): Promise<void> {
    const setup = this.setup;
    if (!setup) {
      this.transition(StrategyState.SCANNING);
      return;
    }
    const candles = this.feed15m.getCandles();
    const breaks = detectStructureBreaks(candles);
    const latestBreak = breaks[breaks.length - 1];
    if (!latestBreak) return;
    if (latestBreak.kind !== 'CHOCH' || latestBreak.direction !== setup.direction) return;

    if (!hasRecentLiquiditySweep(candles, setup.direction)) {
      logger.info(`${this.symbol}: ChoCh seen but no liquidity sweep yet`);
      return;
    }

    const freshFvgs = findFVGs(candles)
      .filter((fvg) => fvg.direction === setup.direction && fvg.index + 2 >= latestBreak.candleIndex)
      .sort((a, b) => b.index - a.index);
    const fvg = freshFvgs[0];
    if (!fvg) {
      logger.info(`${this.symbol}: ChoCh + sweep confirmed, waiting for fresh 15m FVG`);
      return;
    }

    const obs = findOrderBlocks(candles, [latestBreak]);
    const ob15m = obs.length > 0 ? obs[obs.length - 1] : null;
    if (!ob15m) {
      logger.info(`${this.symbol}: ChoCh + sweep confirmed, waiting for 15m OB`);
      return;
    }

    setup.fvg15m = fvg;
    setup.orderBlock15m = ob15m;

    const stopLossRaw = calculateStopLoss(ob15m, setup.direction);
    const entryEstimate = setup.direction === 'BULLISH' ? fvg.top : fvg.bottom;
    const planResult = await this.deps.riskManager.calculatePosition({
      symbol: this.symbol,
      side: setup.direction === 'BULLISH' ? 'Buy' : 'Sell',
      entryPrice: entryEstimate,
      stopLossRaw,
      instrument: this.deps.instrument,
    });
    if (!planResult.ok) {
      logger.warn(`${this.symbol}: setup discarded — ${planResult.reason}`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    this.plan = planResult.plan;
    logger.info(
      `${this.symbol}: ENTRY_STAGED plan qty=${planResult.plan.qty} entry≈${planResult.plan.entryPrice} sl=${planResult.plan.stopLoss} tp=${planResult.plan.takeProfit}`,
    );
    await this.deps.notifier.notifySetupFound(
      this.symbol,
      planResult.plan.entryPrice,
      planResult.plan.stopLoss,
      planResult.plan.takeProfit,
    );
    this.transition(StrategyState.ENTRY_STAGED);
  }

  private async checkEntryTrigger(): Promise<void> {
    const setup = this.setup;
    const plan = this.plan;
    const candle = this.last15m();
    if (!setup || !plan || !setup.fvg15m || !setup.orderBlock15m || !candle) {
      this.transition(StrategyState.SCANNING);
      return;
    }

    if (bodyClosesBeyond(candle, setup.orderBlock15m, setup.direction)) {
      logger.info(`${this.symbol}: 15m OB invalidated before entry, setup cancelled`);
      this.transition(StrategyState.SCANNING);
      return;
    }

    const pulledBack = setup.direction === 'BULLISH'
      ? new Decimal(candle.low).lessThanOrEqualTo(setup.fvg15m.top)
      : new Decimal(candle.high).greaterThanOrEqualTo(setup.fvg15m.bottom);
    if (!pulledBack) return;

    logger.info(`${this.symbol}: pullback into 15m FVG detected, executing market order`);
    const result = await this.deps.executionEngine.execute(plan);
    if (!result.ok) {
      this.transition(StrategyState.SCANNING);
      return;
    }
    this.deps.db.openTrade({
      symbol: this.symbol,
      side: plan.side,
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      qty: plan.qty,
      openedAt: Date.now(),
      orderId: result.orderId,
    });
    logger.info(`${this.symbol}: order ${result.orderId} recorded, entering trade`);
    this.transition(StrategyState.IN_TRADE);
  }

  async reconcile(positions: readonly { size: unknown }[]): Promise<boolean> {
    if (this.state !== StrategyState.IN_TRADE) return false;
    const hasOpenPosition = positions.some((position) => Number(position.size) > 0);
    if (hasOpenPosition) return false;
    const trade = this.deps.db.getOpenTrade(this.symbol);
    if (trade && trade.pnl === null) {
      this.deps.db.closeTrade(trade.id, null, null, Date.now());
    }
    logger.warn(`${this.symbol}: reconciliation force-reset IN_TRADE → SCANNING (no position on exchange)`);
    this.transition(StrategyState.SCANNING);
    return true;
  }
}
