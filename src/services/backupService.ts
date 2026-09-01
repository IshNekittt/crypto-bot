import { PostgresDatabase } from '../db/database';
import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { gzipSync } from 'zlib';

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class BackupService {
  private readonly db: PostgresDatabase;
  private readonly notifier: TelegramNotifier;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: PostgresDatabase, notifier: TelegramNotifier) {
    this.db = db;
    this.notifier = notifier;
  }

  start(): void {
    if (this.timer) return;
    // Run immediately on startup, then every 24h
    this.runBackup().catch((err) => logger.error(`Initial backup failed: ${err.message}`));
    
    this.timer = setInterval(() => {
      void this.runBackup();
    }, BACKUP_INTERVAL_MS);
    this.timer.unref();
    logger.info(`Backup service started (every 24h)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runBackup(): Promise<void> {
    if (this.running) {
      logger.warn('Backup already running, skipping');
      return;
    }
    if (!this.notifier.enabled) {
      logger.debug('Telegram not configured, skipping backup');
      return;
    }
    this.running = true;
    try {
      const trades = await this.db.getAllTrades();
      if (trades.length === 0) {
        logger.info('Backup: no trades to backup');
        return;
      }

      const csv = this.tradesToCsv(trades);
      const gzipped = gzipSync(Buffer.from(csv, 'utf8'));
      
      const date = new Date();
      const filename = `trades_backup_${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, '0')}_${String(date.getDate()).padStart(2, '0')}.csv.gz`;

      const success = await this.notifier.sendDocument(gzipped, filename);
      
      if (success) {
        logger.info(`Backup completed: ${trades.length} trades, ${gzipped.length} bytes compressed`);
      } else {
        throw new Error('Telegram sendDocument returned false');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Backup failed: ${message}`);
      await this.notifier.notifyCriticalError(`⚠️ <b>Ошибка создания бэкапа БД!</b>\n<code>${message}</code>`);
    } finally {
      this.running = false;
    }
  }

  private tradesToCsv(trades: Array<{
    id: number;
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
  }>): string {

    const headers = [
      'id',
      'symbol',
      'scenario_id',
      'entry_price',
      'sl_price',
      'tp_price',
      'qty',
      'pnl',
      'exit_price',
      'status',
      'reason',
      'opened_at',
      'closed_at',
    ];

    const escape = (val: string | number | null | undefined): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = trades.map((t) => [
      escape(t.id),
      escape(t.symbol),
      escape(t.scenario_id),
      escape(t.entry_price),
      escape(t.sl_price),
      escape(t.tp_price),
      escape(t.qty),
      escape(t.pnl),
      escape(t.exit_price),
      escape(t.status),
      escape(t.reason),
      escape(t.opened_at),
      escape(t.closed_at),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }
}