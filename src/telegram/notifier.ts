import { Telegraf, Markup, Context } from "telegraf";
import { Decimal } from "decimal.js";
import { logger } from "../utils/logger";
import { PendingTradeManager } from "../engine/pendingTradeManager";
import { BackupService } from "../services/backupService";
import { BybitClient } from "../api/bybitClient";
import { RiskManager } from "../risk/riskManager";
import { ExecutionEngine } from "../execution/executionEngine";
import { StrategyEngine } from "../engine/strategyEngine";

export class TelegramNotifier {
  readonly bot: Telegraf;
  readonly chatId: string;
  private readonly autoTrading: boolean;
  private pendingTradeManager: PendingTradeManager | null = null;
  private backupService: BackupService | null = null;
  private bybitClient: BybitClient | null = null;
  private riskManager: RiskManager | null = null;
  private executionEngine: ExecutionEngine | null = null;
  private engines: StrategyEngine[] | null = null;

  setPendingTradeManager(manager: PendingTradeManager): void {
    this.pendingTradeManager = manager;
  }

  setBackupService(service: BackupService): void {
    this.backupService = service;
  }

  setLiveTestDependencies(deps: {
    client: BybitClient;
    riskManager: RiskManager;
    executionEngine: ExecutionEngine;
    pendingTradeManager: PendingTradeManager;
    engines: StrategyEngine[];
  }): void {
    this.bybitClient = deps.client;
    this.riskManager = deps.riskManager;
    this.executionEngine = deps.executionEngine;
    this.pendingTradeManager = deps.pendingTradeManager;
    this.engines = deps.engines;
  }

  setEnableLiveTestOrders(enabled: boolean): void {
    if (enabled) {
      this.registerLiveTestCommand();
    }
  }

  private registerLiveTestCommand(): void {
    // Register /test_live_order command for end-to-end live demo test
    this.bot.command("test_live_order", async (ctx) => {
      if (
        !this.bybitClient ||
        !this.riskManager ||
        !this.executionEngine ||
        !this.pendingTradeManager ||
        !this.engines
      ) {
        await ctx.reply("❌ Live test dependencies not initialized");
        return;
      }

      const symbol = this.engines[0]?.symbol;
      if (!symbol) {
        await ctx.reply("❌ No trading symbols configured");
        return;
      }

      try {
        // Get latest price from the engine's candle feed
        const engine = this.engines[0];
        const lastCandle = engine.getLastClosedCandle?.();
        if (!lastCandle) {
          await ctx.reply(`❌ No candle data available for ${symbol}`);
          return;
        }

        const entryPrice = lastCandle.close.toString();
        const entryDecimal = lastCandle.close;
        const slDecimal = entryDecimal.mul(0.99); // 1% risk
        const tpDecimal = entryDecimal.mul(1.03); // 1:3 R:R
        const slPrice = slDecimal.toFixed(2);
        const tpPrice = tpDecimal.toFixed(2);

        // Calculate qty using RiskManager (uses real balance, applies precision)
        const instrument = engine.getInstrument();

        const qtyResult = await this.riskManager.calculatePosition({
          symbol,
          side: "Buy",
          entryPrice: entryDecimal,
          stopLossRaw: slDecimal,
          instrument,
        });
        if (!qtyResult.ok) {
          await ctx.reply(
            `❌ Could not calculate position size for ${symbol}: ${qtyResult.reason}`,
          );
          return;
        }

        const qty = qtyResult.plan.qty;

        const tradeId = this.pendingTradeManager.generateTradeId(symbol);
        const timeoutHandle = setTimeout(() => {
          if (this.pendingTradeManager) {
            this.pendingTradeManager.handleApproval(tradeId, false);
          }
        }, 5 * 60 * 1000); // 5 minutes

        // Store live demo test trade in pendingTradeManager
        this.pendingTradeManager.addLiveDemoTestTrade(tradeId, {
          id: tradeId,
          symbol,
          entry: entryPrice,
          sl: slPrice,
          tp: tpPrice,
          scenarioId: 999,
          reason: "⚡ LIVE DEMO TEST - End-to-end order execution test",
          side: "Buy",
          qty,
          resolve: () => {},
          timeoutHandle,
          createdAt: Date.now(),
          isLiveDemoTest: true,
        });

        const text = [
          "⚡ <b>LIVE DEMO TEST ORDER</b>",
          "",
          `📊 <b>Symbol:</b> ${symbol}`,
          `🎯 <b>Scenario:</b> #999 (Live Demo Test)`,
          `📈 <b>Direction:</b> Buy`,
          `💰 <b>Entry:</b> ${entryPrice}`,
          `🛡 <b>SL:</b> ${slPrice} (-1%)`,
          `🎯 <b>TP:</b> ${tpPrice} (+3%)`,
          `📦 <b>Qty:</b> ${qty} (calculated via RiskManager)`,
          "",
          `📝 <b>Reason:</b> End-to-end order execution test on Bybit Demo`,
          "",
          `⏱ Timer: 5 min`,
          "",
          "<i>⚠️ This will place a REAL order on Bybit Demo when approved!</i>",
        ].join("\n");

        const keyboard = Markup.inlineKeyboard([
          Markup.button.callback("✅ Войти (LIVE DEMO)", `approve_${tradeId}`),
          Markup.button.callback("❌ Отменить", `reject_${tradeId}`),
        ]);

        await this.sendMessageWithKeyboard(text, keyboard);
        await ctx.reply("✅ Live demo test order queued! Check the message above.");

        logger.info(
          `LIVE DEMO TEST ORDER queued: ${tradeId} | ${symbol} | Entry: ${entryPrice} | SL: ${slPrice} | TP: ${tpPrice} | Qty: ${qty}`,
        );
      } catch (error) {
        logger.error(
          `Live demo test order failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await ctx.reply(
          `❌ Live test failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  constructor() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || "";
    this.autoTrading = process.env.AUTO_TRADING === "true";

    if (!botToken || !this.chatId) {
      logger.warn(
        "Telegram credentials not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)",
      );
      this.bot = new Telegraf("dummy:token");
      return;
    }

    this.bot = new Telegraf(botToken);

    // Global authorization middleware - silently ignore unauthorized users
    this.bot.use(async (ctx: Context, next: () => Promise<void>) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId || chatId !== this.chatId) {
        return;
      }
      await next();
    });

    this.bot.launch().catch((err) => {
      logger.error(`Failed to start Telegram bot: ${err.message}`);
    });

    // Register /test_signal command for dry-run testing
    this.bot.command("test_signal", async (ctx) => {
      if (!this.pendingTradeManager) {
        await ctx.reply("❌ PendingTradeManager not initialized");
        return;
      }

      // Create a fake trade for testing
      const fakeTrade = {
        symbol: "BTCUSDT",
        entry: "45000",
        sl: "44000",
        tp: "48000",
        scenarioId: 1,
        reason: "TEST SIGNAL - Dry run for approval flow",
        side: "Buy" as const,
        qty: "0.01",
      };

      const tradeId = this.pendingTradeManager.generateTradeId(
        fakeTrade.symbol,
      );

      const text = [
        "🧪 <b>TEST SIGNAL (DRY RUN)</b>",
        "",
        `📊 <b>Symbol:</b> ${fakeTrade.symbol}`,
        `🎯 <b>Scenario:</b> #${fakeTrade.scenarioId}`,
        `📈 <b>Direction:</b> ${fakeTrade.side}`,
        `💰 <b>Entry:</b> ${fakeTrade.entry}`,
        `🛡 <b>SL:</b> ${fakeTrade.sl}`,
        `🎯 <b>TP:</b> ${fakeTrade.tp}`,
        `📦 <b>Qty:</b> ${fakeTrade.qty}`,
        "",
        `📝 <b>Reason:</b> ${fakeTrade.reason}`,
        "",
        `⏱ Timer: 5 min`,
        "",
        "<i>This is a TEST signal - no real order will be placed</i>",
      ].join("\n");

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback("✅ Войти (Test)", `approve_${tradeId}`),
        Markup.button.callback("❌ Отменить (Test)", `reject_${tradeId}`),
      ]);

      // Store the fake trade in pendingTradeManager
      const timeoutHandle = setTimeout(
        () => {
          if (this.pendingTradeManager) {
            this.pendingTradeManager.handleApproval(tradeId, false);
          }
        },
        5 * 60 * 1000,
      ); // 5 minutes

      this.pendingTradeManager.addTestTrade(tradeId, {
        id: tradeId,
        symbol: fakeTrade.symbol,
        entry: fakeTrade.entry,
        sl: fakeTrade.sl,
        tp: fakeTrade.tp,
        scenarioId: fakeTrade.scenarioId,
        reason: fakeTrade.reason,
        side: fakeTrade.side,
        qty: fakeTrade.qty,
        resolve: () => {},
        timeoutHandle,
        createdAt: Date.now(),
        isTest: true,
      });

      try {
        await this.sendMessageWithKeyboard(text, keyboard);
        await ctx.reply("✅ Test signal sent! Check the message above.");
      } catch (error) {
        logger.error(
          `Failed to send test signal: ${error instanceof Error ? error.message : String(error)}`,
        );
        await ctx.reply("❌ Failed to send test signal");
      }
    });

    // Register /backup command for manual backup
    this.bot.command("backup", async (ctx) => {
      if (!this.backupService) {
        await ctx.reply("❌ Backup service not initialized");
        return;
      }

      const statusMsg = await ctx.reply("📦 Creating backup...");
      try {
        await this.backupService.runManualBackup();
        await ctx.telegram.editMessageText(
          this.chatId,
          statusMsg.message_id,
          undefined,
          "✅ Backup sent successfully!",
        );
      } catch (error) {
        logger.error(
          `Backup command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await ctx.telegram.editMessageText(
          this.chatId,
          statusMsg.message_id,
          undefined,
          "❌ Ошибка создания бэкапа БД!",
        );
      }
    });

    // Register /test_db command for database integration test
    this.bot.command("test_db", async (ctx) => {
      try {
        const { db } = await import("../db/database.js");
        await db.runIntegrationTest();
        await ctx.reply("✅ Database INSERT/SELECT test passed!");
      } catch (error) {
        logger.error(
          `Database integration test failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await ctx.reply(
          `❌ DB Test Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
});

  }

  async sendMessage(html: string): Promise<boolean> {
    if (!this.chatId) {
      logger.debug("Telegram chat ID not configured");
      return false;
    }
    try {
      await this.bot.telegram.sendMessage(this.chatId, html, {
        parse_mode: "HTML",
      });
      return true;
    } catch (error) {
      logger.error(
        `Failed to send Telegram message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async sendMessageWithKeyboard(
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard>,
  ): Promise<void> {
    if (!this.chatId) return;
    await this.bot.telegram.sendMessage(this.chatId, text, {
      parse_mode: "HTML",
      ...keyboard,
    });
  }

  private async sendFileViaFetch(
    buffer: Buffer,
    filename: string,
    chatId: string,
  ): Promise<void> {
    logger.debug(`Generated backup buffer size: ${buffer.length} bytes`);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }
    const uint8Array = new Uint8Array(buffer);
    const blob = new Blob([uint8Array], { type: "application/gzip" });
    const fd = new FormData();
    fd.append("chat_id", chatId);
    fd.append("document", blob, filename);
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendDocument`,
      {
        method: "POST",
        body: fd,
      },
    );
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Telegram API error: ${res.status} ${errorText}`);
    }
  }

  async sendDocument(buffer: Buffer, filename: string): Promise<boolean> {
    if (!this.chatId) {
      logger.debug("Telegram chat ID not configured");
      return false;
    }
    try {
      await this.sendFileViaFetch(buffer, filename, this.chatId);
      return true;
    } catch (error) {
      logger.error(
        `Failed to send Telegram document: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async notifySetupFound(
    symbol: string,
    entry: string,
    sl: string,
    tp: string,
    scenarioId: number,
    reason: string,
  ): Promise<boolean> {
    const text = [
      "👀 <b>Найден сетап</b>",
      "",
      `📊 ${symbol} | Сценарий #${scenarioId}`,
      `💰 Вход: ${entry} | SL: ${sl} | TP: ${tp}`,
      `📝 ${reason}`,
    ].join("\n");
    return this.sendMessage(text);
  }

  async notifyOrderOpened(
    symbol: string,
    entry: string,
    sl: string,
    tp: string,
  ): Promise<boolean> {
    const text = [
      "🚀 <b>Ордер открыт</b>",
      "",
      `📊 ${symbol}`,
      `💰 Вход: ${entry} | SL: ${sl} | TP: ${tp}`,
    ].join("\n");
    return this.sendMessage(text);
  }

  async notifyTradeClosed(
    symbol: string,
    pnl: string,
    pnlPercent: string,
  ): Promise<boolean> {
    const icon = new Decimal(pnl).isNegative() ? "❌" : "✅";
    const text = [
      `${icon} <b>Позиция закрыта</b>`,
      "",
      `📊 ${symbol}`,
      `💰 PnL: ${pnl} USDT (${pnlPercent}%)`,
    ].join("\n");
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
