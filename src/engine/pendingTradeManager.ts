import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { Markup } from 'telegraf';

export interface PendingTrade {
  id: string;
  symbol: string;
  entry: string;
  sl: string;
  tp: string;
  scenarioId: number;
  reason: string;
  side: 'Buy' | 'Sell';
  qty: string;
  resolve: (approved: boolean) => void;
  timeoutHandle: NodeJS.Timeout;
  createdAt: number;
  isTest?: boolean;           // Flag for dry-run test trades
  isLiveDemoTest?: boolean;   // Flag for live demo test trades (real order on Demo)
}

export class PendingTradeManager {
  private readonly notifier: TelegramNotifier;
  private readonly approvalTimeoutMs: number;
  private readonly pendingTrades: Map<string, PendingTrade> = new Map();
  private tradeIdCounter = 0;

  constructor(notifier: TelegramNotifier, approvalTimeoutMinutes: number) {
    this.notifier = notifier;
    this.approvalTimeoutMs = approvalTimeoutMinutes * 60 * 1000;
  }

  generateTradeId(symbol: string): string {
    return `${symbol}_${Date.now()}_${++this.tradeIdCounter}`;
  }

  async queueTrade(
    symbol: string,
    entry: string,
    sl: string,
    tp: string,
    scenarioId: number,
    reason: string,
    side: 'Buy' | 'Sell',
    qty: string
  ): Promise<boolean> {
    const tradeId = this.generateTradeId(symbol);

    return new Promise<boolean>((resolve) => {
      const timeoutHandle = setTimeout(async () => {
        if (this.pendingTrades.has(tradeId)) {
          this.pendingTrades.delete(tradeId);
          await this.notifier.sendMessage(
            `⏰ <b>Таймаут подтверждения</b>\nСделка ${tradeId} (${symbol}) автоматически отклонена по истечении ${this.approvalTimeoutMs / 60000} мин.`
          );
          resolve(false);
        }
      }, this.approvalTimeoutMs);

      const pending: PendingTrade = {
        id: tradeId,
        symbol,
        entry,
        sl,
        tp,
        scenarioId,
        reason,
        side,
        qty,
        resolve,
        timeoutHandle,
        createdAt: Date.now(),
      };

      this.pendingTrades.set(tradeId, pending);

      const text = [
        '🔔 <b>Требуется подтверждение сделки</b>',
        '',
        `📊 <b>Символ:</b> ${symbol}`,
        `🎯 <b>Сценарий:</b> #${scenarioId}`,
        `📈 <b>Направление:</b> ${side}`,
        `💰 <b>Вход:</b> ${entry}`,
        `🛡 <b>SL:</b> ${sl}`,
        `🎯 <b>TP:</b> ${tp}`,
        `📦 <b>Объём:</b> ${qty}`,
        '',
        `📝 <b>Обоснование:</b> ${reason}`,
        '',
        `⏱ Таймер: ${this.approvalTimeoutMs / 60000} мин`,
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ Войти в сделку', `approve_${tradeId}`),
        Markup.button.callback('❌ Отменить', `reject_${tradeId}`),
      ]);

      this.sendMessageWithKeyboard(text, keyboard)
        .then(() => logger.info(`Pending trade queued: ${tradeId}`))
        .catch((err) => {
          logger.error(`Failed to send approval message: ${err instanceof Error ? err.message : String(err)}`);
          clearTimeout(timeoutHandle);
          this.pendingTrades.delete(tradeId);
          resolve(false);
        });
    });
  }

  private async sendMessageWithKeyboard(text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard>): Promise<void> {
    if (!this.notifier.enabled) return;
    await this.notifier.bot.telegram.sendMessage(this.notifier.chatId, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
  }

  handleApproval(tradeId: string, approved: boolean): boolean {
    const pending = this.pendingTrades.get(tradeId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeoutHandle);
    this.pendingTrades.delete(tradeId);
    pending.resolve(approved);
    return true;
  }

  /**
   * Add a test trade for dry-run testing via /test_signal command
   */
  addTestTrade(tradeId: string, trade: {
    id: string;
    symbol: string;
    entry: string;
    sl: string;
    tp: string;
    scenarioId: number;
    reason: string;
    side: 'Buy' | 'Sell';
    qty: string;
    resolve: (approved: boolean) => void;
    timeoutHandle: NodeJS.Timeout;
    createdAt: number;
    isTest?: boolean;
  }): void {
    this.pendingTrades.set(tradeId, trade as PendingTrade);
  }

  /**
   * Add a live demo test trade for /test_live_order command
   * This creates a real trade that will execute on Bybit Demo when approved
   */
  addLiveDemoTestTrade(tradeId: string, trade: {
    id: string;
    symbol: string;
    entry: string;
    sl: string;
    tp: string;
    scenarioId: number;
    reason: string;
    side: 'Buy' | 'Sell';
    qty: string;
    resolve: (approved: boolean) => void;
    timeoutHandle: NodeJS.Timeout;
    createdAt: number;
    isLiveDemoTest: true;
  }): void {
    this.pendingTrades.set(tradeId, trade as PendingTrade);
  }

  getPendingCount(): number {
    return this.pendingTrades.size;
  }

  getPendingTrade(tradeId: string): PendingTrade | undefined {
    return this.pendingTrades.get(tradeId);
  }

  cancelAll(): void {
    for (const [, pending] of this.pendingTrades) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve(false);
    }
    this.pendingTrades.clear();
  }
}