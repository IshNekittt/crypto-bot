import { BybitClient } from '../api/bybitClient';
import { BotConfig } from '../config/env';
import { InstrumentInfo } from '../types';
import { logger } from '../utils/logger';

export async function runPreflight(
  config: BotConfig,
  client: BybitClient,
): Promise<Map<string, InstrumentInfo>> {
  logger.info('Pre-flight check started');

  const time = await client.syncServerTime();
  logger.info(
    `Server time synced: offset=${time.offsetMs}ms, rtt=${time.roundTripMs}ms`,
  );

  const instruments = new Map<string, InstrumentInfo>();
  for (const symbol of config.symbols) {
    const info = await client.getInstrumentInfo(symbol);
    instruments.set(symbol, info);
    logger.info(
      `Instrument ${symbol}: tickSize=${info.tickSize} qtyStep=${info.qtyStep} minOrderQty=${info.minOrderQty} maxOrderQty=${info.maxOrderQty}`,
    );
    await client.setupMarginAndLeverage(symbol, config.leverage);
    logger.info(`Leverage set to ${config.leverage}x (isolated) for ${symbol}`);
  }

  logger.info(`Pre-flight complete for ${instruments.size}/${config.symbols.length} symbols`);
  return instruments;
}
