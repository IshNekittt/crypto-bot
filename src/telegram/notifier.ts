import { Telegraf, Markup, Context } from "telegraf";
import { Decimal } from "decimal.js";
import { logger } from "../utils/logger";
import { PendingTradeManager } from "../engine/pendingTradeManager";
import { BackupService } from "../services/backupService";
import { BybitClient } from "../api/bybitClient";
import { RiskManager } from "../risk/riskManager";
import { ExecutionEngine } from "../execution/executionEngine";
import { StrategyEngine } from "../engine/strategyEngine";
import { NewsService } from "../services/newsService";
import { FundingMonitorService } from "../services/fundingMonitorService";
import { DateTime } from "luxon";

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
  private newsService: NewsService | null = null;
  private fundingMonitor: FundingMonitorService | null = null;

  setPendingTradeManager(manager: PendingTradeManager): void {
    this.pendingTradeManager = manager;
  }

  setBackupService(service: BackupService): void {
    this.backupService = service;
  }

  setNewsService(service: NewsService): void {
    this.newsService = service;
  }

  setFundingMonitor(service: FundingMonitorService): void {
    this.fundingMonitor = service;
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
          takeProfitRaw: tpDecimal,
          instrument,
          zoneDetails: null,
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
        "Telegram notifications are disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)",
      );
      this.bot = new Telegraf("dummy:token");
      return;
    }

    this.bot = new Telegraf(botToken);

    // Global error handler - NEVER log ctx.update (prevents PII leaks)
    this.bot.catch((err, ctx) => {
      logger.error(`Telegram Error for ${ctx.updateType}: ${err instanceof Error ? err.message : String(err)}`);
    });

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

// Register /status command for system diagnostics
    this.bot.command("status", async (ctx) => {
      if (!this.engines || this.engines.length === 0) {
        await ctx.reply("❌ No strategy engines initialized");
        return;
      }

      const statusLines: string[] = ["📊 <b>SYSTEM STATUS REPORT</b>", ""];

      try {
        for (const engine of this.engines) {
        try {
          const diagnostics = await engine.getDiagnostics();
          
          // Format last candle time
          const lastCandleTimeStr = diagnostics.lastCandleTime
            ? new Date(diagnostics.lastCandleTime).toISOString().replace('T', ' ').substring(0, 19)
            : 'N/A';

          // Macro distance
          const macroDist = diagnostics.nearestMacroDistancePct
            ? `${diagnostics.nearestMacroDistancePct}%`
            : 'N/A';

          statusLines.push(
            `🔸 <b>Symbol:</b> ${diagnostics.symbol}`,
            `📈 <b>Live Price:</b> ${diagnostics.livePrice ?? 'N/A'}`,
            `⏱ <b>Last Candle:</b> ${lastCandleTimeStr}`,
            `🧭 <b>4H Trend:</b> ${diagnostics.trend4h}`,
            `🧱 <b>Zones in Memory:</b> ${diagnostics.zonesCount}`,
            `💧 <b>Nearest Macro:</b> ${macroDist}`,
            `💼 <b>State:</b> ${diagnostics.state}`,
            ""
          );
        } catch (error) {
          logger.error(
            `Failed to get diagnostics for ${engine.symbol}: ${error instanceof Error ? error.message : String(error)}`
          );
          statusLines.push(
            `🔸 <b>Symbol:</b> ${engine.symbol}`,
            `❌ <b>Error getting diagnostics:</b> ${error instanceof Error ? error.message : String(error)}`,
            ""
          );
        }
      }

      // News Embargo info
      if (this.newsService) {
        const nextNews = this.newsService.getNextHighImpactNews();
        if (nextNews) {
          const nextNewsTime = new Date(nextNews.timestamp).toISOString().replace('T', ' ').substring(0, 19);
          statusLines.push(`📰 <b>Next USD High-Impact News:</b> ${nextNews.name} at ${nextNewsTime} UTC`);
        } else {
          const fetchError = this.newsService.getFetchError();
          if (fetchError) {
            statusLines.push(`📰 <b>News:</b> Calendar unavailable (${fetchError})`);
          } else {
            statusLines.push(`📰 <b>Next USD High-Impact News:</b> None for today`);
          }
        }
      }

      // Funding Monitor info
      if (this.fundingMonitor) {
        const rates = this.fundingMonitor.getCurrentRates();
        if (rates.size > 0) {
          statusLines.push(`📊 <b>Funding Rates:</b>`);
          for (const [symbol, rate] of rates) {
            const ratePct = rate.mul(100).toFixed(4);
            const emoji = rate.isNegative() ? '🔴' : '🟢';
            const prefix = rate.isNegative() ? '' : '+';
            statusLines.push(`${emoji} ${symbol}: ${prefix}${ratePct}%`);
          }
        } else {
          statusLines.push(`📊 <b>Funding Rates:</b> Loading...`);
        }
      } else {
        statusLines.push(`📊 <b>Funding Rates:</b> Disabled`);
      }

      const text = statusLines.join("\n");
      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (error) {
      logger.error(
        `Failed to generate status report: ${error instanceof Error ? error.message : String(error)}`
      );
      await ctx.reply("❌ Failed to generate status report");
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
  ): Promise<number | null> {
    if (!this.chatId) return null;
    const msg = await this.bot.telegram.sendMessage(this.chatId, text, {
      parse_mode: "HTML",
      ...keyboard,
    });
    return msg.message_id;
  }

  async editMessageWithTimeout(messageId: number, originalText: string): Promise<void> {
    if (!this.chatId) return;
    try {
      const timeoutText = `${originalText}\n\n<b>[ ⏰ TIMEOUT ]</b>`;
      await this.bot.telegram.editMessageText(this.chatId, messageId, undefined, timeoutText, {
        parse_mode: "HTML",
      });
    } catch (error) {
      logger.warn(`Failed to edit message for timeout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async sendFileViaFetch(
    buffer: Buffer,
    _filename: string,
    chatId: string,
  ): Promise<void> {
    logger.debug(`Generated backup buffer size: ${buffer.length} bytes`);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }
    // Convert buffer to CSV text (assuming it's already CSV content, possibly gzipped)
    const csvContent = buffer.toString('utf-8');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const formData = new FormData();
    formData.append('chat_id', chatId);
    const fileName = `trades_backup_${DateTime.utc().toFormat('yyyy-MM-dd_HH-mm-ss')}.csv`;
    formData.append('document', blob, fileName);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      throw new Error(`Telegram API rejected document: ${await response.text()}`);
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
    const safePnl = pnl ? new Decimal(pnl) : new Decimal(0);
    const safePnlPct = pnlPercent ? new Decimal(pnlPercent) : new Decimal(0);

    const isWin = safePnl.gt(0);
    const icon = isWin ? "✅" : (safePnl.isNegative() ? "❌" : "➖");
    const sign = isWin ? "+" : "";

    const pnlText = `${icon} <b>PnL:</b> ${sign}${safePnl.toFixed(2)} USDT (${sign}${safePnlPct.toFixed(2)}%)`;

    const text = [
      `${icon} <b>Позиция закрыта</b>`,
      "",
      `📊 ${symbol}`,
      pnlText,
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
