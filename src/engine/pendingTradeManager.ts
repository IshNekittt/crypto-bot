import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { Markup } from 'telegraf';
import { Decimal } from 'decimal.js';

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
  messageId?: number; // Telegram message ID for timeout editing
  originalText?: string; // Original message text for timeout editing
  idealEntry?: string; // Ideal entry price from scenario (for dynamic Market/Limit decision)
  isTest?: boolean;           // Flag for dry-run test trades
  isLiveDemoTest?: boolean;   // Flag for live demo test trades (real order on Demo)
}

export class PendingTradeManager {
  private readonly notifier: TelegramNotifier;
  private readonly approvalTimeoutMs: number;
  private readonly pendingTrades: Map<string, PendingTrade> = new Map();
  private tradeIdCounter = 0;
  
  private getCurrentPrice?: (symbol: string) => string | null;

  constructor(notifier: TelegramNotifier, approvalTimeoutMinutes: number) {
    this.notifier = notifier;
    this.approvalTimeoutMs = approvalTimeoutMinutes * 60 * 1000;
  }

  setPriceProvider(getCurrentPrice: (symbol: string) => string | null): void {
    this.getCurrentPrice = getCurrentPrice;
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
    qty: string,
    idealEntry?: string
  ): Promise<boolean> {
    const tradeId = this.generateTradeId(symbol);

    return new Promise<boolean>(async (resolve) => {
      const timeoutHandle = setTimeout(async () => {
        if (this.pendingTrades.has(tradeId)) {
          const pending = this.pendingTrades.get(tradeId);
          this.pendingTrades.delete(tradeId);
          if (pending?.messageId && pending.originalText) {
            await this.notifier.editMessageWithTimeout(pending.messageId, pending.originalText);
          } else {
            await this.notifier.sendMessage(
              `⏰ <b>Таймаут подтверждения</b>\nСделка ${tradeId} (${symbol}) автоматически отклонена по истечении ${this.approvalTimeoutMs / 60000} мин.`
            );
          }
          resolve(false);
        }
      }, this.approvalTimeoutMs);

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
        messageId: undefined,
        originalText: text,
        idealEntry: idealEntry ?? entry,
      };

      this.pendingTrades.set(tradeId, pending);

      let messageId: number | null = null;
      try {
        messageId = await this.sendMessageWithKeyboard(text, keyboard);
      } catch (err) {
        logger.error(`Failed to send approval message: ${err instanceof Error ? err.message : String(err)}`);
        clearTimeout(timeoutHandle);
        this.pendingTrades.delete(tradeId);
        resolve(false);
        return;
      }
      
      // Update the pending trade with the messageId
      pending.messageId = messageId ?? undefined;
    });
  }

  private async sendMessageWithKeyboard(text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard>): Promise<number | null> {
    if (!this.notifier.enabled) return null;
    const msg = await this.notifier.bot.telegram.sendMessage(this.notifier.chatId, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
    return msg.message_id;
  }

  handleApproval(tradeId: string, approved: boolean): { approved: boolean; orderType: 'Market' | 'Limit'; limitPrice?: string } {
    const pending = this.pendingTrades.get(tradeId);
    if (!pending) {
      return { approved: false, orderType: 'Market' };
    }

    if (approved && this.getCurrentPrice) {
      const currentPriceStr = this.getCurrentPrice(pending.symbol);
      if (currentPriceStr) {
        const currentPrice = new Decimal(currentPriceStr);
        const tpPrice = new Decimal(pending.tp);
        const idealEntry = pending.idealEntry ? new Decimal(pending.idealEntry) : new Decimal(pending.entry);
        const smartThreshold = new Decimal('0.0015'); // 0.15% - should match SMART_ENTRY_THRESHOLD_PCT
        
        const isLong = pending.side === 'Buy';
        
        // Check if price already passed TP - reject in this case
        if (isLong) {
          if (currentPrice.gte(tpPrice)) {
            logger.warn(`[Slippage Guard] ${tradeId}: current price ${currentPriceStr} >= TP ${pending.tp}, rejecting`);
            clearTimeout(pending.timeoutHandle);
            this.pendingTrades.delete(tradeId);
            pending.resolve(false);
            return { approved: false, orderType: 'Market' };
          }
        } else {
          if (currentPrice.lte(tpPrice)) {
            logger.warn(`[Slippage Guard] ${tradeId}: current price ${currentPriceStr} <= TP ${pending.tp}, rejecting`);
            clearTimeout(pending.timeoutHandle);
            this.pendingTrades.delete(tradeId);
            pending.resolve(false);
            return { approved: false, orderType: 'Market' };
          }
        }
        
        // Calculate price difference from idealEntry
        const priceDiffPct = idealEntry.minus(currentPrice).div(idealEntry).abs();
        const useMarketOrder = priceDiffPct.lte(smartThreshold);
        
        logger.info(`[Dynamic Approval] ${tradeId}: idealEntry=${idealEntry.toFixed(4)} currentPrice=${currentPriceStr} diff=${priceDiffPct.mul(100).toFixed(4)}% threshold=${smartThreshold.mul(100).toFixed(2)}% -> ${useMarketOrder ? 'Market' : 'Limit'}`);
        
        if (!useMarketOrder) {
          // Use Limit order at idealEntry
          clearTimeout(pending.timeoutHandle);
          this.pendingTrades.delete(tradeId);
          pending.resolve(true);
          return { approved: true, orderType: 'Limit', limitPrice: idealEntry.toFixed(8) };
        }
        // Use Market order - fall through to normal approval
      }
    }
    
    // Default: Market order
    clearTimeout(pending.timeoutHandle);
    this.pendingTrades.delete(tradeId);
    pending.resolve(approved);
    return { approved, orderType: 'Market' };
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