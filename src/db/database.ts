import pg from 'pg';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';

const { Pool } = pg;

export interface TradeRow {
  id: string;
  symbol: string;
  scenario_id: number | null;
  entry_price: string;
  sl_price: string;
  tp_price: string;
  qty: string;
  pnl: string | null;
  exit_price: string | null;
  status: string;
  reason: string | null;
  opened_at: number;
  closed_at: number | null;
  order_id: string | null;
  side: string | null;
  zone_type: string | null;
  zone_top: string | null;
  zone_bottom: string | null;
  zone_timeframe: string | null;
  zone_direction: string | null;
  zone_timestamp: number | null;
  order_type: string | null;
  limit_price: string | null;
}

export interface SymbolStateRow {
  symbol: string;
  state: string;
  updated_at: number;
}

export interface TradeInput {
  symbol: string;
  scenario_id: number | null;
  entry_price: string;
  sl_price: string;
  tp_price: string;
  qty: string;
  reason: string | null;
  opened_at: number;
}

export interface TradeRecord {
  readonly id: string;
  readonly symbol: string;
  readonly scenario_id: number | null;
  readonly entry_price: string;
  readonly sl_price: string;
  readonly tp_price: string;
  readonly qty: string;
  readonly pnl: string | null;
  readonly exit_price: string | null;
  readonly status: string;
  readonly reason: string | null;
  readonly opened_at: number;
  readonly closed_at: number | null;
  readonly order_id: string | null;
  readonly side: string | null;
  readonly zone_type: string | null;
  readonly zone_top: string | null;
  readonly zone_bottom: string | null;
  readonly zone_timeframe: string | null;
  readonly zone_direction: string | null;
  readonly zone_timestamp: number | null;
  readonly order_type: string | null;
  readonly limit_price: string | null;
  readonly management_state: any | null;
}

export class PostgresDatabase {
  private readonly pool: pg.Pool;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      // Supabase/PostgreSQL connection resilience
      allowExitOnIdle: false,
      // TCP keep-alive to prevent Supabase from closing idle connections
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    this.pool.on('error', (err) => {
      logger.error(`PostgreSQL pool error (will reconnect on next query): ${err.message}`);
    });

    this.pool.on('connect', () => {
      logger.debug('PostgreSQL new connection established');
    });
  }

  /**
   * CONNECTION LEAK PREVENTION:
   * Every method that acquires a client from the pool MUST use the pattern:
   *   const client = await this.pool.connect();
   *   try {
   *     // ... queries ...
   *   } finally {
   *     client.release(); // ALWAYS release, even on error
   *   }
   * This ensures connections are returned to the pool under ALL circumstances.
   * Current pool config: max=5, idleTimeout=10s, keepAlive=true for Supabase compatibility.
   */

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS trades (
          id VARCHAR(255) PRIMARY KEY,
          symbol VARCHAR(20) NOT NULL,
          scenario_id INTEGER,
          entry_price NUMERIC(24, 8) NOT NULL,
          sl_price NUMERIC(24, 8) NOT NULL,
          tp_price NUMERIC(24, 8) NOT NULL,
          qty NUMERIC(24, 8) NOT NULL,
          pnl NUMERIC(24, 8),
          exit_price NUMERIC(24, 8),
          status VARCHAR(20) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
          reason TEXT,
          opened_at BIGINT NOT NULL,
          closed_at BIGINT,
          order_id VARCHAR(255),
          side VARCHAR(10) CHECK (side IN ('Buy', 'Sell')),
          zone_type VARCHAR(20),
          zone_top NUMERIC(24, 8),
          zone_bottom NUMERIC(24, 8),
          zone_timeframe VARCHAR(10),
          zone_direction VARCHAR(10),
          zone_timestamp BIGINT,
          order_type VARCHAR(10),
          limit_price NUMERIC(24, 8),
          management_state JSONB DEFAULT '{}'::jsonb
        );

        -- Add missing columns if they don't exist (for existing databases)
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS order_type VARCHAR(10);
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS limit_price NUMERIC(24, 8);
        ALTER TABLE trades ADD COLUMN IF NOT EXISTS management_state JSONB DEFAULT '{}'::jsonb;

        CREATE TABLE IF NOT EXISTS symbol_state (
          symbol VARCHAR(20) PRIMARY KEY,
          state VARCHAR(20) NOT NULL CHECK (state IN ('SCANNING', 'WAITING', 'CONFIRMATION', 'ENTRY_STAGED', 'IN_TRADE')),
          updated_at BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades (symbol, status, opened_at);
        CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades (closed_at DESC);
      `);
      logger.info('PostgreSQL database initialized successfully');
    } finally {
      client.release();
    }
  }

  // Symbol state methods (for StrategyEngine)
  async getSymbolState(symbol: string): Promise<{ symbol: string; state: string; updatedAt: number } | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT symbol, state, updated_at FROM symbol_state WHERE symbol = $1`,
        [symbol],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return { symbol: row.symbol, state: row.state, updatedAt: row.updated_at };
    } finally {
      client.release();
    }
  }

  async setSymbolState(symbol: string, state: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO symbol_state (symbol, state, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (symbol) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [symbol, state, Date.now()],
      );
    } finally {
      client.release();
    }
  }

  // Trade methods
async openTrade(input: {
    id: string;
    symbol: string;
    scenario_id: number | null;
    entry_price: string;
    sl_price: string;
    tp_price: string;
    qty: string;
    reason: string | null;
    opened_at: number;
    side: 'Buy' | 'Sell';
    zone_type?: string | null;
    zone_top?: string | null;
    zone_bottom?: string | null;
    zone_timeframe?: string | null;
    zone_direction?: string | null;
    zone_timestamp?: number | null;
    order_type?: string | null;
    limit_price?: string | null;
    management_state?: any | null;
    order_id?: string | null;
  }): Promise<string> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO trades (id, symbol, scenario_id, entry_price, sl_price, tp_price, qty, status, reason, opened_at, side, zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, order_type, limit_price, management_state, order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING id`,
        [
          input.id,
          input.symbol,
          input.scenario_id,
          input.entry_price,
          input.sl_price,
          input.tp_price,
          input.qty,
          input.reason,
          input.opened_at,
          input.side,
          input.zone_type ?? null,
          input.zone_top ?? null,
          input.zone_bottom ?? null,
          input.zone_timeframe ?? null,
          input.zone_direction ?? null,
          input.zone_timestamp ?? null,
          input.order_type ?? null,
          input.limit_price ?? null,
          input.management_state ? JSON.stringify(input.management_state) : '{}',
          input.order_id ?? null,
        ],
      );
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async closeTrade(tradeId: string, pnl: string | null, exitPrice: string | null, closedAt: number, reason: string | null): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE trades SET status = 'CLOSED', pnl = $1, exit_price = $2, closed_at = $3, reason = $4 WHERE id = $5 AND status = 'OPEN'`,
        [pnl, exitPrice, closedAt, reason, tradeId],
      );
      return result.rowCount !== null && result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  async updateTradeManagementState(tradeId: string, managementState: any): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE trades SET management_state = $1 WHERE id = $2 AND status = 'OPEN'`,
        [JSON.stringify(managementState), tradeId],
      );
      return result.rowCount !== null && result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  async getOpenTrade(symbol: string): Promise<{
    id: string;
    symbol: string;
    scenario_id: number | null;
    entryPrice: string;
    stopLoss: string;
    takeProfit: string;
    qty: string;
    pnl: string | null;
    exitPrice: string | null;
    status: string;
    reason: string | null;
    openedAt: number;
    closedAt: number | null;
    orderId: string | null;
    side: string | null;
    zoneDetails: {
      type: string | null;
      top: Decimal | null;
      bottom: Decimal | null;
      timeframe: string | null;
      direction: string | null;
      timestamp: number | null;
    } | null;
    managementState: any | null;
  } | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, scenario_id, entry_price as "entryPrice", sl_price as "stopLoss", tp_price as "takeProfit", qty, pnl, exit_price as "exitPrice", status, reason, opened_at as "openedAt", closed_at as "closedAt", order_id as "orderId", side, zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, management_state
         FROM trades WHERE symbol = $1 AND status = 'OPEN' ORDER BY id DESC LIMIT 1`,
        [symbol],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        symbol: row.symbol,
        scenario_id: row.scenario_id,
        entryPrice: row.entryPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        qty: row.qty,
        pnl: row.pnl,
        exitPrice: row.exitPrice,
        status: row.status,
        reason: row.reason,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        orderId: row.orderId,
        side: row.side,
        zoneDetails: row.zone_type ? {
          type: row.zone_type,
          top: new Decimal(row.zone_top),
          bottom: new Decimal(row.zone_bottom),
          timeframe: row.zone_timeframe,
          direction: row.zone_direction,
          timestamp: row.zone_timestamp,
        } : null,
        managementState: row.management_state || null,
      };
    } finally {
      client.release();
    }
  }

  async getRecentClosedTrades(limit: number): Promise<{
    id: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    scenario_id: number | null;
    entryPrice: string;
    stopLoss: string;
    takeProfit: string;
    qty: string;
    pnl: string | null;
    exitPrice: string | null;
    status: 'OPEN' | 'CLOSED';
    reason: string | null;
    openedAt: number;
    closedAt: number | null;
    orderId: string | null;
    zoneDetails: {
      type: string | null;
      top: Decimal | null;
      bottom: Decimal | null;
      timeframe: string | null;
      direction: string | null;
      timestamp: number | null;
    } | null;
    managementState: any | null;
  }[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, side::text as side, scenario_id, entry_price as "entryPrice", sl_price as "stopLoss", tp_price as "takeProfit", qty, pnl, exit_price as "exitPrice", status::text as status, reason, opened_at as "openedAt", closed_at as "closedAt", order_id as "orderId", zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, management_state
         FROM trades WHERE status = 'CLOSED' ORDER BY closed_at DESC, id DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(row => ({
        id: row.id,
        symbol: row.symbol,
        side: row.side,
        scenario_id: row.scenario_id,
        entryPrice: row.entryPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        qty: row.qty,
        pnl: row.pnl,
        exitPrice: row.exitPrice,
        status: row.status,
        reason: row.reason,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        orderId: row.orderId,
        zoneDetails: row.zone_type ? {
          type: row.zone_type,
          top: new Decimal(row.zone_top),
          bottom: new Decimal(row.zone_bottom),
          timeframe: row.zone_timeframe,
          direction: row.zone_direction,
          timestamp: row.zone_timestamp,
        } : null,
        managementState: row.management_state || null,
      }));
    } finally {
      client.release();
    }
  }

  async getAllOpenTrades(): Promise<{
    id: string;
    symbol: string;
    scenario_id: number | null;
    entryPrice: string;
    stopLoss: string;
    takeProfit: string;
    qty: string;
    pnl: string | null;
    exitPrice: string | null;
    status: string;
    reason: string | null;
    openedAt: number;
    closedAt: number | null;
    orderId: string | null;
    side: string | null;
    zoneDetails: {
      type: string | null;
      top: Decimal | null;
      bottom: Decimal | null;
      timeframe: string | null;
      direction: string | null;
      timestamp: number | null;
    } | null;
    managementState: any | null;
  }[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, scenario_id, entry_price as "entryPrice", sl_price as "stopLoss", tp_price as "takeProfit", qty, pnl, exit_price as "exitPrice", status, reason, opened_at as "openedAt", closed_at as "closedAt", order_id as "orderId", side, zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, management_state
         FROM trades WHERE status = 'OPEN' ORDER BY id DESC`,
      );
      return result.rows.map(row => ({
        id: row.id,
        symbol: row.symbol,
        scenario_id: row.scenario_id,
        entryPrice: row.entryPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        qty: row.qty,
        pnl: row.pnl,
        exitPrice: row.exitPrice,
        status: row.status,
        reason: row.reason,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        orderId: row.orderId,
        side: row.side as 'Buy' | 'Sell' | null,
        zoneDetails: row.zone_type ? {
          type: row.zone_type,
          top: new Decimal(row.zone_top),
          bottom: new Decimal(row.zone_bottom),
          timeframe: row.zone_timeframe,
          direction: row.zone_direction,
          timestamp: row.zone_timestamp,
        } : null,
        managementState: row.management_state || null,
      }));
    } finally {
      client.release();
    }
  }

  async runIntegrationTest(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const testId = 'TEST_DB_1';
      const now = Date.now();

      // INSERT with zoneDetails including decimal values and new fields
      await client.query(
        `INSERT INTO trades (id, symbol, scenario_id, entry_price, sl_price, tp_price, qty, status, reason, opened_at, side, zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, order_type, limit_price, management_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO NOTHING`,
        [testId, 'TESTUSDT', 1, '100.12345678', '99.12345678', '103.12345678', '0.12345678', 'OPEN', 'INTEGRATION TEST', now, 'Buy', 'OB', '105.50000000', '104.25000000', '15', 'BULLISH', now, 'Limit', '50000.00000000', '{"milestone1Triggered":false,"milestone2Triggered":false,"initialTotalR":"5.2","initialQty":"0.1"}'],
      );

      // SELECT
      const selectResult = await client.query(
        `SELECT id, symbol, entry_price, sl_price, tp_price, qty, status, zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, order_type, limit_price, management_state FROM trades WHERE id = $1`,
        [testId],
      );

      if (selectResult.rows.length === 0) {
        throw new Error('Test row not found after INSERT');
      }

      const row = selectResult.rows[0];
      if (row.symbol !== 'TESTUSDT' || row.entry_price !== '100.12345678') {
        throw new Error('Data mismatch after INSERT');
      }

      // Verify new columns
      if (row.order_type !== 'Limit') {
        throw new Error('order_type not saved correctly');
      }
      if (row.limit_price !== '50000.00000000') {
        throw new Error('limit_price not saved correctly');
      }
      if (!row.management_state || row.management_state.milestone1Triggered !== false) {
        throw new Error('management_state not saved correctly');
      }

      // Verify zoneDetails decimal deserialization and operations
      if (!row.zone_type || row.zone_type !== 'OB') {
        throw new Error('zone_type not saved correctly');
      }
      const zoneTop = new Decimal(row.zone_top);
      const zoneBottom = new Decimal(row.zone_bottom);
      const sum = zoneTop.plus(zoneBottom);
      const half = sum.div(2);
      if (!half.eq(new Decimal('104.87500000'))) {
        throw new Error(`Decimal operations failed on deserialized zoneDetails: expected 104.875, got ${half.toString()}`);
      }

      // DELETE
      await client.query(`DELETE FROM trades WHERE id = $1`, [testId]);

      logger.info('Database integration test passed (INSERT/SELECT/DELETE with zoneDetails Decimal operations)');
      return true;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getAllTrades(): Promise<TradeRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, scenario_id, entry_price, sl_price, tp_price, qty, pnl, exit_price, status, reason, opened_at, closed_at, order_id, side, zone_type, zone_top, zone_bottom, zone_timeframe, zone_direction, zone_timestamp, management_state
         FROM trades ORDER BY id ASC`,
      );
      return result.rows as TradeRecord[];
    } finally {
      client.release();
    }
  }
}

export const db = new PostgresDatabase();