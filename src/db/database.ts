import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  NewTradeInput,
  StrategyState,
  SymbolRuntimeState,
  TradeRecord,
  TradeSide,
  TradeStatus,
} from '../types';

interface SymbolStateRow {
  symbol: string;
  state: string;
  updated_at: number;
}

interface TradeRow {
  id: number;
  symbol: string;
  side: string;
  entry_price: string;
  sl_price: string;
  tp_price: string;
  qty: string;
  status: string;
  pnl: string | null;
  exit_price: string | null;
  opened_at: number;
  closed_at: number | null;
  order_id: string | null;
}

const BUSY_TIMEOUT_MS = 5000;

const TRADE_COLUMNS = `
  id, symbol, side, entry_price, sl_price, tp_price, qty,
  status, pnl, exit_price, opened_at, closed_at, order_id
`;

interface PragmaColumnRow {
  name: string;
}

function toTradeRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side as TradeSide,
    entryPrice: row.entry_price,
    stopLoss: row.sl_price,
    takeProfit: row.tp_price,
    qty: row.qty,
    status: row.status as TradeStatus,
    pnl: row.pnl,
    exitPrice: row.exit_price,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    orderId: row.order_id,
  };
}

export class StateDatabase {
  private readonly db: Database.Database;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(path.join(directory, 'bot-state.db'));
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    const journalMode = String(this.db.pragma('journal_mode', { simple: true }));
    if (journalMode !== 'wal') {
      throw new Error(`CRITICAL: SQLite journal_mode is "${journalMode}", expected "wal". Concurrent symbol workers will hit SQLITE_BUSY.`);
    }
    this.migrate();
  }

  getJournalMode(): string {
    return String(this.db.pragma('journal_mode', { simple: true }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_state (
        symbol TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('SCANNING', 'WAITING', 'CONFIRMATION', 'ENTRY_STAGED', 'IN_TRADE')),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('Buy', 'Sell')),
        entry_price TEXT NOT NULL,
        sl_price TEXT NOT NULL,
        tp_price TEXT NOT NULL,
        qty TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        pnl TEXT,
        exit_price TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        order_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trades_symbol_status
        ON trades (symbol, status, opened_at);

      CREATE INDEX IF NOT EXISTS idx_trades_closed
        ON trades (closed_at DESC);
    `);
    this.migrateAddOrderIdColumn();
  }

  private migrateAddOrderIdColumn(): void {
    const columns = this.db.pragma('table_info(trades)') as unknown as PragmaColumnRow[];
    if (!columns.some((column) => column.name === 'order_id')) {
      this.db.exec('ALTER TABLE trades ADD COLUMN order_id TEXT');
    }
  }

  getSymbolState(symbol: string): SymbolRuntimeState | null {
    const row = this.db
      .prepare('SELECT symbol, state, updated_at FROM symbol_state WHERE symbol = ?')
      .get(symbol) as SymbolStateRow | undefined;
    if (!row) return null;
    return {
      symbol: row.symbol,
      state: row.state as StrategyState,
      updatedAt: row.updated_at,
    };
  }

  setSymbolState(symbol: string, state: StrategyState): void {
    this.db
      .prepare(`
        INSERT INTO symbol_state (symbol, state, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
      `)
      .run(symbol, state, Date.now());
  }

  openTrade(input: NewTradeInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, qty, status, opened_at, order_id)
        VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
      `)
      .run(
        input.symbol,
        input.side,
        input.entryPrice,
        input.stopLoss,
        input.takeProfit,
        input.qty,
        input.openedAt,
        input.orderId ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  closeTrade(tradeId: number, pnl: string | null, exitPrice: string | null, closedAt: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE trades
        SET status = 'CLOSED', pnl = ?, exit_price = ?, closed_at = ?
        WHERE id = ? AND status = 'OPEN'
      `)
      .run(pnl, exitPrice, closedAt, tradeId);
    return result.changes > 0;
  }

  getOpenTrade(symbol: string): TradeRecord | null {
    const row = this.db
      .prepare(`
        SELECT ${TRADE_COLUMNS} FROM trades
        WHERE symbol = ? AND status = 'OPEN'
        ORDER BY id DESC LIMIT 1
      `)
      .get(symbol) as TradeRow | undefined;
    return row ? toTradeRecord(row) : null;
  }

  getRecentClosedTrades(limit: number): TradeRecord[] {
    const rows = this.db
      .prepare(`
        SELECT ${TRADE_COLUMNS} FROM trades
        WHERE status = 'CLOSED'
        ORDER BY closed_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit) as TradeRow[];
    return rows.map(toTradeRecord);
  }

  close(): void {
    this.db.close();
  }
}
