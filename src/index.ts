import 'dotenv/config';

import { BybitClient } from './api/bybitClient';
import { BybitWebsocket } from './api/wsClient';
import { runPreflight } from './bootstrap/preflight';
import { ReconciliationLoop } from './bootstrap/reconciliation';
import { startHealthServer } from './bootstrap/healthcheck';
import { loadConfig } from './config/env';
import { db } from './db/database';
import { ExecutionEngine } from './execution/executionEngine';
import { StrategyEngine } from './engine/strategyEngine';
import { RiskManager } from './risk/riskManager';
import { StrategyState } from './types';
import { notifier } from './telegram/notifier';
import { logger } from './utils/logger';
import { PatternRecognizer } from './smc/patternRecognizer';
import { PendingTradeManager } from './engine/pendingTradeManager';
import { BackupService } from './services/backupService';

function setupGlobalErrorHandlers(): void {
  process.on('uncaughtException', async (error: Error) => {
    logger.error(`🆘 UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}`);
    if (notifier.enabled) {
      await notifier.notifyCriticalError(`🆘 <b>UNCAUGHT EXCEPTION</b>\n<code>${error.message}</code>\n\nContainer will restart.`);
    }
    process.exit(1);
  });

  function onUnhandledRejection(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error(`🆘 UNHANDLED REJECTION: ${message}`);
    if (notifier.enabled) {
      notifier.notifyCriticalError(`🆘 <b>UNHANDLED REJECTION</b>\n<code>${message}</code>\n\nContainer will restart.`);
    }
    process.exit(1);
  }
  
  process.on('unhandledRejection', onUnhandledRejection);
}

async function main(): Promise<void> {
  setupGlobalErrorHandlers();

  const config = loadConfig();
  const mode = config.demoTrading ? 'Demo Trading' : (config.testnet ? 'Testnet' : 'Mainnet');
  logger.info(
    `Starting SMC bot | mode=${mode} testnet=${config.testnet} demoTrading=${config.demoTrading} symbols=[${config.symbols.join(', ')}] risk=${config.riskPercent}% leverage=${config.leverage}x history=${config.historyCandles} autoTrading=${config.autoTrading}`,
  );

  // Initialize PostgreSQL database
  await db.initialize();

  // Start health check server for Render
  await startHealthServer();

  const client = BybitClient.create(config);
  const instruments = await runPreflight(config, client);

  if (!notifier.enabled) {
    logger.warn('Telegram notifications are disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)');
  }

  const riskManager = new RiskManager(client, db, {
    baseRiskPercent: config.riskPercent,
    reducedRiskPercent: config.reducedRiskPercent,
  });
  const executionEngine = new ExecutionEngine(client, notifier);

  // Initialize PendingTradeManager for manual approval flow
  const approvalTimeoutMinutes = config.tradeApprovalTimeoutMinutes ?? 5;
  const pendingTradeManager = new PendingTradeManager(notifier, approvalTimeoutMinutes);

  // Inject PendingTradeManager into TelegramNotifier for /test_signal command
  notifier.setPendingTradeManager(pendingTradeManager);

  // Register Telegram action handlers for approve/reject
  notifier.bot.action(/^approve_(.+)$/, async (ctx) => {
    const tradeId = ctx.match[1];
    const engine = engines.find((e) => tradeId.startsWith(e.symbol));
    
    // Get the pending trade to check if it's a test trade
    const pendingTradeApprove = pendingTradeManager.getPendingTrade(tradeId);
    const isTestTrade = pendingTradeApprove?.isTest === true;
    
    if (engine && !isTestTrade) {
      await engine.handleTradeApproval(tradeId, true);
    } else if (isTestTrade) {
      logger.info(`✅ Test trade approved (DRY RUN): ${tradeId}`);
    } else if (!engine && !isTestTrade) {
      await ctx.answerCbQuery('Сделка не найдена');
      return;
    }
    
    // Edit message: remove keyboard and add status
    try {
      await ctx.editMessageReplyMarkup(undefined); // Remove keyboard
      let originalText = '';
      const message = ctx.callbackQuery?.message;
      if (message && 'text' in message) {
        originalText = message.text;
      }
      await ctx.editMessageText(
        `${originalText}\n\n<b>[ ✅ APPROVED ]</b>`,
        { parse_mode: 'HTML' }
      );
    } catch (editError) {
      logger.debug(`Failed to edit message: ${editError instanceof Error ? editError.message : String(editError)}`);
    }
    
    await ctx.answerCbQuery(isTestTrade ? '✅ Test trade approved (DRY RUN)' : '✅ Сделка подтверждена');
  });
  
  notifier.bot.action(/^reject_(.+)$/, async (ctx) => {
    const tradeId = ctx.match[1];
    const engine = engines.find((e) => tradeId.startsWith(e.symbol));
    
    const pendingTradeReject = pendingTradeManager.getPendingTrade(tradeId);
    const isTestTrade = pendingTradeReject?.isTest === true;
    
    if (engine && !isTestTrade) {
      await engine.handleTradeApproval(tradeId, false);
    } else if (isTestTrade) {
      logger.info(`❌ Test trade rejected (DRY RUN): ${tradeId}`);
    } else if (!engine && !isTestTrade) {
      await ctx.answerCbQuery('Сделка не найдена');
      return;
    }
    
    // Edit message: remove keyboard and add status
    try {
      await ctx.editMessageReplyMarkup(undefined); // Remove keyboard
      let originalText = '';
      const message = ctx.callbackQuery?.message;
      if (message && 'text' in message) {
        originalText = message.text;
      }
      await ctx.editMessageText(
        `${originalText}\n\n<b>[ ❌ REJECTED ]</b>`,
        { parse_mode: 'HTML' }
      );
    } catch (editError) {
      logger.debug(`Failed to edit message: ${editError instanceof Error ? editError.message : String(editError)}`);
    }
    
    await ctx.answerCbQuery(isTestTrade ? '❌ Test trade rejected (DRY RUN)' : '❌ Сделка отклонена');
  });

  const engines: StrategyEngine[] = [];

  // Create shared PatternRecognizer instance
  const patternRecognizer = new PatternRecognizer(client);

  // Initialize macro context for all symbols at startup (bootstrap phase)
  logger.info('Initializing macro context for all symbols...');
  for (const symbol of config.symbols) {
    try {
      await patternRecognizer.initializeMacroContext(symbol, config.macroCandles);
    } catch (error) {
      logger.error(`Failed to initialize macro context for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger.info('Macro context initialization complete for all symbols');

  for (const symbol of config.symbols) {
    const instrument = instruments.get(symbol);
    if (!instrument) throw new Error(`No instrument info for ${symbol}, aborting`);
    engines.push(new StrategyEngine({
      symbol,
      instrument,
      client,
      db,
      riskManager,
      executionEngine,
      notifier,
      patternRecognizer,
      autoTrading: config.autoTrading,
      pendingTradeManager,
    }));
  }
  for (const engine of engines) {
    await db.setSymbolState(engine.symbol, StrategyState.SCANNING);
    await engine.initialize();
  }

  const ws = new BybitWebsocket(config);

  let resyncInProgress = false;
  ws.onResync(async () => {
    if (resyncInProgress) return;
    resyncInProgress = true;
    try {
      await client.syncServerTime();
      for (const engine of engines) {
        await engine.reloadHistory();
      }
      logger.info('Resync after WS reconnect complete');
    } finally {
      resyncInProgress = false;
    }
  });

  ws.onKline((update) => {
    const engine = engines.find((candidate) => candidate.symbol === update.symbol);
    if (engine) void engine.handleKline(update);
  });
  ws.onPosition((payload) => {
    for (const engine of engines) {
      engine.handlePositionPayload(payload);
    }
  });
  ws.onExecution((payload) => logger.info(`Private WS execution event: ${JSON.stringify(payload)?.slice(0, 300)}`));

  await ws.subscribeKlines(config.symbols, ['15', '240']);
  await ws.subscribePrivate();

  const reconciliation = new ReconciliationLoop(client, db, engines);
  reconciliation.start();

  // Initialize backup service
  const backupService = new BackupService(db, notifier);
  backupService.start();

  // Graceful shutdown handler
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, starting graceful shutdown...`);

    try {
      reconciliation.stop();
      logger.info('Reconciliation loop stopped');

      backupService.stop();
      logger.info('Backup service stopped');

      pendingTradeManager.cancelAll();
      logger.info('Pending trade manager cleared');

      ws.close();
      logger.info('WebSocket connections closed');

      await db.close();
      logger.info('Database pool closed');

      logger.info('Graceful shutdown complete');
    } catch (error) {
      logger.error(`Error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }

    process.exit(0);
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info(`Bot online: ${engines.length} strategy workers active. Waiting for setups.`);
  
  // Keep process alive
  await new Promise<void>(() => {});
}

main().catch((error: unknown) => {
  logger.error(`Fatal bootstrap error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});