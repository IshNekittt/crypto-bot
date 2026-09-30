import { PositionListSource } from '../api/bybitClient';
import { PostgresDatabase } from '../db/database';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../config/env';

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;
export const CLOCK_DRIFT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface ReconcilableEngine {
  readonly symbol: string;
  getState(): import('../types').StrategyState;
  reconcile(positions: readonly { size: unknown }[]): Promise<boolean>;
  reconcileWithTrade(trade: {
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
  }): Promise<boolean>;
}

export class ReconciliationLoop {
  private readonly source: PositionListSource;
  private readonly db: PostgresDatabase;
  private readonly engines: readonly ReconcilableEngine[];
  private readonly config: BotConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTimeSync = 0;

  constructor(source: PositionListSource, db: PostgresDatabase, engines: readonly ReconcilableEngine[], config: BotConfig) {
    this.source = source;
    this.db = db;
    this.engines = engines;
    this.config = config;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, RECONCILIATION_INTERVAL_MS);
    this.timer.unref();
    logger.info(`Reconciliation loop started (every ${RECONCILIATION_INTERVAL_MS / 60000} min)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let resets = 0;
    try {
      // Clock drift prevention: sync server time every hour
      const now = Date.now();
      if (now - this.lastTimeSync >= CLOCK_DRIFT_SYNC_INTERVAL_MS) {
        try {
          const timeSync = await this.source.syncServerTime();
          logger.info(`[Clock Drift] Reconciliation time synced: offset=${timeSync.offsetMs}ms, roundTrip=${timeSync.roundTripMs}ms`);
          this.lastTimeSync = now;
        } catch (timeError) {
          logger.warn(`[Clock Drift] Reconciliation failed to sync server time: ${timeError instanceof Error ? timeError.message : String(timeError)}`);
        }
      }

      // 1. Check engines with IN_TRADE state
      for (const engine of this.engines) {
        if (engine.getState() !== 'IN_TRADE') continue;
        try {
          const positions = await this.source.getOpenPositions(engine.symbol);
          const changed = await engine.reconcile(positions);
          if (changed) resets += 1;
        } catch (error) {
          logger.error(
            `Reconciliation failed for ${engine.symbol}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // 2. Audit all open trades in DB - find ones where position is gone on exchange
      let openTrades: typeof this.db extends { getAllOpenTrades: () => Promise<infer T> } ? T : never;
      try {
        openTrades = await this.db.getAllOpenTrades();
      } catch (dbError) {
        // DB connection timeout / error - log as warning, skip this cycle
        logger.warn(`[Reconciliation] DB query timeout/error, skipping this cycle: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        this.running = false;
        return resets;
      }

      for (const trade of openTrades) {
        const engine = this.engines.find((e) => e.symbol === trade.symbol);
        if (!engine) continue;

        try {
          const positions = await this.source.getOpenPositions(trade.symbol);
          const hasPosition = positions.some((p) => Number(p.size) > 0);

          if (!hasPosition) {
            // Position closed on exchange but DB still shows OPEN - reconcile with trade data
            const changed = await engine.reconcileWithTrade({
              id: trade.id,
              symbol: trade.symbol,
              entryPrice: trade.entryPrice,
              qty: trade.qty,
              side: trade.side as 'Buy' | 'Sell',
              openedAt: trade.openedAt,
              orderId: trade.orderId,
              zoneDetails: trade.zoneDetails,
            });
            if (changed) resets += 1;
          }
        } catch (error) {
          logger.error(
            `Trade audit failed for ${trade.symbol} (trade ${trade.id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // 3. Check and cancel expired limit orders
      await this.cancelExpiredLimitOrders();

    } finally {
      this.running = false;
    }
    return resets;
  }

  private async cancelExpiredLimitOrders(): Promise<void> {
    const limitExpirationMs = this.config.limitExpirationCandles * Number(this.config.ltfTimeframe) * 60 * 1000;
    const now = Date.now();

    for (const engine of this.engines) {
      const symbol = engine.symbol;
      try {
        const openOrders = await this.source.getOpenOrders(symbol);
        
        for (const order of openOrders) {
          // Only process limit orders that are still active (New or PartiallyFilled)
          if (order.orderType !== 'Limit') continue;
          if (order.status !== 'New' && order.status !== 'PartiallyFilled') continue;

          const orderAge = now - order.createdAt;
          if (orderAge > limitExpirationMs) {
            // Cancel the expired limit order
            try {
              const rest = (this.source as any).rest;
              await rest.cancelOrder({
                category: 'linear',
                symbol: order.symbol,
                orderId: order.orderId,
              });
              logger.info(`[${symbol}] Cancelled expired LIMIT order ${order.orderId} (age: ${(orderAge / 60000).toFixed(1)} min, limit: ${this.config.limitExpirationCandles} candles)`);
            } catch (cancelError) {
              logger.warn(`[${symbol}] Failed to cancel expired limit order ${order.orderId}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
            }
          }
        }
      } catch (error) {
        logger.error(`[${symbol}] Failed to check open orders: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}