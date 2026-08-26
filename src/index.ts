import { BybitClient } from './api/bybitClient';
import { BybitWebsocket } from './api/wsClient';
import { runPreflight } from './bootstrap/preflight';
import { ReconciliationLoop } from './bootstrap/reconciliation';
import { loadConfig } from './config/env';
import { StateDatabase } from './db/database';
import { ExecutionEngine } from './execution/executionEngine';
import { StrategyEngine } from './engine/strategyEngine';
import { RiskManager } from './risk/riskManager';
import { StrategyState } from './types';
import { TelegramNotifier } from './telegram/notifier';
import { logger } from './utils/logger';

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      logger.info(`${signal} received, shutting down`);
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    `Starting SMC bot | testnet=${config.testnet} symbols=[${config.symbols.join(', ')}] risk=${config.riskPercent}% leverage=${config.leverage}x history=${config.historyCandles}`,
  );

  const client = BybitClient.create(config);
  const instruments = await runPreflight(config, client);

  const db = new StateDatabase(config.dataDir);
  const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
  if (!notifier.enabled) {
    logger.warn('Telegram notifications are disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)');
  }

  const riskManager = new RiskManager(client, db, {
    baseRiskPercent: config.riskPercent,
    reducedRiskPercent: config.reducedRiskPercent,
  });
  const executionEngine = new ExecutionEngine(client, notifier);

  const engines: StrategyEngine[] = [];
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
    }));
  }
  for (const engine of engines) {
    db.setSymbolState(engine.symbol, StrategyState.SCANNING);
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

  const reconciliation = new ReconciliationLoop(client, engines);
  reconciliation.start();

  logger.info(`Bot online: ${engines.length} strategy workers active. Waiting for setups.`);
  await waitForShutdown();

  reconciliation.stop();
  ws.close();
  db.close();
}

main().catch((error: unknown) => {
  logger.error(`Fatal bootstrap error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
