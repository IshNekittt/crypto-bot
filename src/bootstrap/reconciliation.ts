import { PositionListSource } from '../api/bybitClient';
import { logger } from '../utils/logger';

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export interface ReconcilableEngine {
  readonly symbol: string;
  getState(): import('../types').StrategyState;
  reconcile(positions: readonly { size: unknown }[]): Promise<boolean>;
}

export class ReconciliationLoop {
  private readonly source: PositionListSource;
  private readonly engines: readonly ReconcilableEngine[];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(source: PositionListSource, engines: readonly ReconcilableEngine[]) {
    this.source = source;
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
    } finally {
      this.running = false;
    }
    return resets;
  }
}
