import { Decimal } from 'decimal.js';
import { logger } from '../utils/logger';

const TELEGRAM_REQUEST_TIMEOUT_MS = 10000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

export class TelegramNotifier {
  private readonly botToken: string | null;
  private readonly chatId: string | null;

  constructor(botToken: string | null, chatId: string | null) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  get enabled(): boolean {
    return this.botToken !== null && this.chatId !== null;
  }

  async send(text: string): Promise<boolean> {
    if (!this.enabled || !this.botToken || !this.chatId) {
      logger.debug('Telegram notifications disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
      return false;
    }
    const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text();
        logger.error(`Telegram send failed: HTTP ${response.status} ${body.slice(0, 300)}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.error(
        `Telegram send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async notifySetupFound(symbol: string, entry: string, stopLoss: string, takeProfit: string): Promise<boolean> {
    return this.send(
      `👀 Найден сетап по ${symbol}. Вход: ${entry}, SL: ${stopLoss}, TP: ${takeProfit}`,
    );
  }

  async notifyOrderOpened(): Promise<boolean> {
    return this.send('🚀 Ордер открыт по рынку!');
  }

  async notifyTradeClosed(pnl: string): Promise<boolean> {
    const icon = new Decimal(pnl).isNegative() ? '❌' : '✅';
    return this.send(`${icon} Позиция закрыта. PnL: ${pnl} USDT`);
  }

  async notifyCriticalError(message: string): Promise<boolean> {
    return this.send(`⚠️ Критическая ошибка бота: ${message}`);
  }
}
