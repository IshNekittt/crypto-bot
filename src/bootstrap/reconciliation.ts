import { PositionListSource } from '../api/bybitClient';
import { PostgresDatabase } from '../db/database';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { BotConfig, resolveLimitExpirationCandles, resolveLimitExpirationMs, resolveSymbolConfig } from '../config/env';

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;
export const CLOCK_DRIFT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface ReconcilableEngine {
  readonly symbol: string;
  readonly deps?: {
    readonly notifier: {
      notifyTradeClosed(symbol: string, pnl: string, pnlPercent: string, reason?: string): Promise<boolean>;
    };
  };
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
    order_type: string | null;
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
      this.tick().catch((e) =>
        logger.error(`Reconciliation tick failed: ${e instanceof Error ? e.message : String(e)}`),
      );
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
          // Check for active limit orders before force-reset
          const openOrders = await this.source.getOpenOrders(engine.symbol);
          
          // Expiration is mode-aware: Sniper Mode counts 1m candles, Classic counts LTF
          // candles. Resolving through the shared helper keeps live and backtest aligned;
          // the symbol-resolved config honours SNIPER_LIMIT_EXPIRATION_CANDLES_<SYMBOL>.
          const symbolConfig = resolveSymbolConfig(this.config, engine.symbol);
          const expirationCandles = resolveLimitExpirationCandles(symbolConfig);
          const expirationMs = resolveLimitExpirationMs(symbolConfig);
          const now = Date.now();
          
          const activeLimits = openOrders.filter(
            (o) => o.orderType === 'Limit' && (o.status === 'New' || o.status === 'PartiallyFilled')
          );
          
          let hasValidLimit = false;
          
          for (const order of activeLimits) {
            const orderAgeMs = now - order.createdAt;
            if (orderAgeMs > expirationMs) {
              logger.info(`[${engine.symbol}] Cancelling expired LIMIT order ${order.orderId} (age: ${Math.round(orderAgeMs/60000)}m, limit: ${expirationCandles} candles)`);
              try {
                await this.source.cancelOrder(engine.symbol, order.orderId);

                if (order.status === 'PartiallyFilled') {
                  // A partially filled limit leaves REAL exposure on the exchange. Closing the DB
                  // row as CANCELLED would orphan the filled portion (no OPEN row => no Adaptive
                  // Fractioning, no reconciliation adoption). Keep IN_TRADE for management.
                  hasValidLimit = true;
                  logger.info(`[${engine.symbol}] Cancelled resting portion of PartiallyFilled Limit ${order.orderId}. Filled portion remains IN_TRADE for management.`);
                } else {
                  const dbOk = await this.db.closeTrade(order.orderId, '0', order.price || '0', Date.now(), 'CANCELLED');
                  if (!dbOk) {
                    logger.warn(`[${engine.symbol}] Cancelled limit not found in DB for closure.`);
                  } else {
                    logger.info(`[${engine.symbol}] Cancelled order closed in DB safely.`);

                    // Safely trigger notification — engine may be a mock without deps/notifier
                    if (engine.deps && engine.deps.notifier) {
                      engine.deps.notifier.notifyTradeClosed(engine.symbol, '0', '0', 'CANCELLED')
                        .catch(e => logger.error(`[${engine.symbol}] TG Cancel Notify error: ${e instanceof Error ? e.message : String(e)}`));
                    }
                  }
                }
              } catch (err) {
                logger.error(`[${engine.symbol}] Failed to cancel/close expired limit order: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              hasValidLimit = true;
            }
          }
          
          if (hasValidLimit) {
            logger.info(`[${engine.symbol}] Reconciliation: Keeping IN_TRADE state due to active Limit order`);
            continue; // Skip force-reset, limit order is still active
          }

          // Snapshot positions AFTER the cancellation loop: a limit cancelled above may have
          // left a partial fill (or none at all), and reconcile() must judge the current reality.
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
          const hasPosition = positions.some((p) => new Decimal(p.size).gt(0));

          // Check for active limit orders before force-reset
          const openOrders = await this.source.getOpenOrders(trade.symbol);
          const hasActiveLimitOrder = openOrders.some(
            (o: { orderType: string; status: string }) => o.orderType === 'Limit' && (o.status === 'New' || o.status === 'PartiallyFilled')
          );
          if (hasActiveLimitOrder) {
            // SILENT CONTINUE to avoid duplicate logs (already logged in Step 1)
            continue;
          }

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
              order_type: trade.order_type,
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
    // Mode-aware lifetime: 1m candles in Sniper Mode, LTF candles in Classic.
    // Resolved per engine so a per-symbol lifetime applies to its own orders only.
    const now = Date.now();

    for (const engine of this.engines) {
      const symbol = engine.symbol;
      const symbolConfig = resolveSymbolConfig(this.config, symbol);
      const expirationCandles = resolveLimitExpirationCandles(symbolConfig);
      const limitExpirationMs = resolveLimitExpirationMs(symbolConfig);
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
              await this.source.cancelOrder(order.symbol, order.orderId);

              if (order.status === 'PartiallyFilled') {
                // Resting remainder cancelled, but the filled portion is live exposure:
                // never close the DB row as CANCELLED (see Step 1 of tick()).
                logger.info(`[${symbol}] Cancelled resting portion of PartiallyFilled Limit ${order.orderId} (age: ${(orderAge / 60000).toFixed(1)} min, limit: ${expirationCandles} candles). Filled portion remains IN_TRADE for management.`);
              } else {
                // Explicitly close in DB with 0 PnL and CANCELLED reason
                // This prevents Step 2 from hallucinating PnL
                try {
                  const dbOk = await this.db.closeTrade(order.orderId, '0', order.price || '0', Date.now(), 'CANCELLED');
                  logger.info(`[${symbol}] Cancelled expired LIMIT order ${order.orderId} (age: ${(orderAge / 60000).toFixed(1)} min, limit: ${expirationCandles} candles)`);

                  if (!dbOk) {
                    logger.warn(`[${symbol}] Cancelled limit not found in DB for closure.`);
                  } else {
                    logger.info(`[${symbol}] Cancelled order closed in DB safely.`);

                    // Safely trigger notification — engine may be a mock without deps/notifier
                    if (engine.deps && engine.deps.notifier) {
                      engine.deps.notifier.notifyTradeClosed(symbol, '0', '0', 'CANCELLED')
                        .catch((e) => logger.error(`[${symbol}] TG Cancel Notify error: ${e instanceof Error ? e.message : String(e)}`));
                    }
                  }
                } catch (dbError) {
                  logger.error(`[${symbol}] Failed to close cancelled order in DB: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
                }
              }
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