import { Telegraf, Markup } from 'telegraf';
import { Decimal } from 'decimal.js';
import { logger } from '../utils/logger';

export class TelegramNotifier {
  readonly bot: Telegraf;
  readonly chatId: string;
  private readonly autoTrading: boolean;

  constructor() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    this.autoTrading = process.env.AUTO_TRADING === 'true';

    if (!botToken || !this.chatId) {
      logger.warn('Telegram credentials not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)');
      this.bot = new Telegraf('dummy:token');
      return;
    }

    this.bot = new Telegraf(botToken);
    this.bot.launch().catch((err) => {
      logger.error(`Failed to start Telegram bot: ${err.message}`);
    });
  }

  async sendMessage(html: string): Promise<boolean> {
    if (!this.chatId) {
      logger.debug('Telegram chat ID not configured');
      return false;
    }
    try {
      await this.bot.telegram.sendMessage(this.chatId, html, { parse_mode: 'HTML' });
      return true;
    } catch (error) {
      logger.error(`Failed to send Telegram message: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async sendMessageWithKeyboard(text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard>): Promise<void> {
    if (!this.chatId) return;
    await this.bot.telegram.sendMessage(this.chatId, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
  }

  async sendDocument(buffer: Buffer, filename: string): Promise<boolean> {
    if (!this.chatId) {
      logger.debug('Telegram chat ID not configured');
      return false;
    }
    try {
      await this.bot.telegram.sendDocument(this.chatId, {
        source: buffer,
        filename,
      });
      return true;
    } catch (error) {
      logger.error(`Failed to send Telegram document: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async notifySetupFound(symbol: string, entry: string, sl: string, tp: string, scenarioId: number, reason: string): Promise<boolean> {
    const text = [
      '👀 <b>Найден сетап</b>',
      '',
      `📊 ${symbol} | Сценарий #${scenarioId}`,
      `💰 Вход: ${entry} | SL: ${sl} | TP: ${tp}`,
      `📝 ${reason}`,
    ].join('\n');
    return this.sendMessage(text);
  }

  async notifyOrderOpened(symbol: string, entry: string, sl: string, tp: string): Promise<boolean> {
    const text = [
      '🚀 <b>Ордер открыт</b>',
      '',
      `📊 ${symbol}`,
      `💰 Вход: ${entry} | SL: ${sl} | TP: ${tp}`,
    ].join('\n');
    return this.sendMessage(text);
  }

  async notifyTradeClosed(symbol: string, pnl: string, pnlPercent: string): Promise<boolean> {
    const icon = new Decimal(pnl).isNegative() ? '❌' : '✅';
    const text = [
      `${icon} <b>Позиция закрыта</b>`,
      '',
      `📊 ${symbol}`,
      `💰 PnL: ${pnl} USDT (${pnlPercent}%)`,
    ].join('\n');
    return this.sendMessage(text);
  }

  async notifyCriticalError(message: string): Promise<boolean> {
    return this.sendMessage(`⚠️ <b>Критическая ошибка</b>\n\n${message}`);
  }

  async notifyInfo(message: string): Promise<boolean> {
    return this.sendMessage(`ℹ️ <b>Инфо</b>\n\n${message}`);
  }

  get enabled(): boolean {
    return !!this.chatId && !!process.env.TELEGRAM_BOT_TOKEN;
  }

  get isAutoTrading(): boolean {
    return this.autoTrading;
  }
}

export const notifier = new TelegramNotifier();