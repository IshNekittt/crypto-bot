import pg from 'pg';
import { logger } from '../utils/logger';

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
          side VARCHAR(10) CHECK (side IN ('Buy', 'Sell'))
        );

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
    symbol: string;
    scenario_id: number | null;
    entry_price: string;
    sl_price: string;
    tp_price: string;
    qty: string;
    reason: string | null;
    opened_at: number;
    side: 'Buy' | 'Sell';
  }): Promise<string> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO trades (symbol, scenario_id, entry_price, sl_price, tp_price, qty, status, reason, opened_at, side)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9)
         RETURNING id`,
        [
          input.symbol,
          input.scenario_id,
          input.entry_price,
          input.sl_price,
          input.tp_price,
          input.qty,
          input.reason,
          input.opened_at,
          input.side,
        ],
      );
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async closeTrade(tradeId: string, pnl: string | null, exitPrice: string | null, closedAt: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE trades SET status = 'CLOSED', pnl = $1, exit_price = $2, closed_at = $3 WHERE id = $4 AND status = 'OPEN'`,
        [pnl, exitPrice, closedAt, tradeId],
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
  } | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, scenario_id, entry_price as "entryPrice", sl_price as "stopLoss", tp_price as "takeProfit", qty, pnl, exit_price as "exitPrice", status, reason, opened_at as "openedAt", closed_at as "closedAt", order_id as "orderId"
         FROM trades WHERE symbol = $1 AND status = 'OPEN' ORDER BY id DESC LIMIT 1`,
        [symbol],
      );
      return result.rows[0] || null;
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
  }[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, side::text as side, scenario_id, entry_price as "entryPrice", sl_price as "stopLoss", tp_price as "takeProfit", qty, pnl, exit_price as "exitPrice", status::text as status, reason, opened_at as "openedAt", closed_at as "closedAt", order_id as "orderId"
         FROM trades WHERE status = 'CLOSED' ORDER BY closed_at DESC, id DESC LIMIT $1`,
        [limit],
      );
      return result.rows;
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
    side: 'Buy' | 'Sell';
  }[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, symbol, scenario_id, entry_price as "entryPrice", sl_price as "stopLoss", tp_price as "takeProfit", qty, pnl, exit_price as "exitPrice", status, reason, opened_at as "openedAt", closed_at as "closedAt", order_id as "orderId", side
         FROM trades WHERE status = 'OPEN' ORDER BY id DESC`,
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async runIntegrationTest(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const testId = 'TEST_DB_1';
      const now = Date.now();

      // INSERT
      await client.query(
        `INSERT INTO trades (id, symbol, scenario_id, entry_price, sl_price, tp_price, qty, status, reason, opened_at, side)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [testId, 'TESTUSDT', 1, '100.12345678', '99.12345678', '103.12345678', '0.12345678', 'OPEN', 'INTEGRATION TEST', now, 'Buy'],
      );

      // SELECT
      const selectResult = await client.query(
        `SELECT id, symbol, entry_price, sl_price, tp_price, qty, status FROM trades WHERE id = $1`,
        [testId],
      );

      if (selectResult.rows.length === 0) {
        throw new Error('Test row not found after INSERT');
      }

      const row = selectResult.rows[0];
      if (row.symbol !== 'TESTUSDT' || row.entry_price !== '100.12345678') {
        throw new Error('Data mismatch after INSERT');
      }

      // DELETE
      await client.query(`DELETE FROM trades WHERE id = $1`, [testId]);

      logger.info('Database integration test passed (INSERT/SELECT/DELETE)');
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
        `SELECT id, symbol, scenario_id, entry_price, sl_price, tp_price, qty, pnl, exit_price, status, reason, opened_at, closed_at
         FROM trades ORDER BY id ASC`,
      );
      return result.rows as TradeRecord[];
    } finally {
      client.release();
    }
  }
}

export const db = new PostgresDatabase();