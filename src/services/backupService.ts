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
    // Only schedule every 24h, NO immediate backup on startup
    this.timer = setInterval(() => {
      void this.runBackup();
    }, BACKUP_INTERVAL_MS);
    this.timer.unref();
    logger.info(`Backup service started (every 24h, first run in 24h)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async generateBackupBuffer(): Promise<Buffer> {
    const trades = await this.db.getAllTrades();
    const csv = this.tradesToCsv(trades);
    return gzipSync(Buffer.from(csv, 'utf8'));
  }

  private getBackupFilename(): string {
    const date = new Date();
    return `trades_backup_${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, '0')}_${String(date.getDate()).padStart(2, '0')}.csv.gz`;
  }

  async runManualBackup(): Promise<void> {
    if (!this.notifier.enabled) {
      logger.debug('Telegram not configured, skipping manual backup');
      return;
    }
    await this.runBackup();
  }

  async forceBackup(): Promise<void> {
    if (!this.notifier.enabled) {
      logger.debug('Telegram not configured, skipping auto backup');
      return;
    }
    await this.runBackup();
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
      const buffer = await this.generateBackupBuffer();
      const filename = this.getBackupFilename();

      const success = await this.notifier.sendDocument(buffer, filename);
      
      if (success) {
        const trades = await this.db.getAllTrades();
        logger.info(`Backup completed: ${trades.length} trades, ${buffer.length} bytes compressed`);
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
      'order_id',
      'side',
      'zone_type',
      'zone_top',
      'zone_bottom',
      'zone_timeframe',
      'zone_direction',
      'zone_timestamp',
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
      escape(t.order_id),
      escape(t.side),
      escape(t.zone_type),
      escape(t.zone_top),
      escape(t.zone_bottom),
      escape(t.zone_timeframe),
      escape(t.zone_direction),
      escape(t.zone_timestamp),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }
}