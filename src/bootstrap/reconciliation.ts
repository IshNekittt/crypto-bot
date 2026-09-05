import { PositionListSource } from '../api/bybitClient';
import { PostgresDatabase } from '../db/database';
import { logger } from '../utils/logger';

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

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
  }): Promise<boolean>;
}

export class ReconciliationLoop {
  private readonly source: PositionListSource;
  private readonly db: PostgresDatabase;
  private readonly engines: readonly ReconcilableEngine[];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(source: PositionListSource, db: PostgresDatabase, engines: readonly ReconcilableEngine[]) {
    this.source = source;
    this.db = db;
    this.engines = engines;
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
      const openTrades = await this.db.getAllOpenTrades();
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
              side: trade.side,
              openedAt: trade.openedAt,
              orderId: trade.orderId,
            });
            if (changed) resets += 1;
          }
        } catch (error) {
          logger.error(
            `Trade audit failed for ${trade.symbol} (trade ${trade.id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return resets;
  }
}