import { WebsocketClient } from 'bybit-api';
import { BotConfig } from '../config/env';
import { Candle, Timeframe } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';

const WS_HEARTBEAT_INTERVAL_MS = 20000;

export interface KlineUpdate {
  readonly symbol: string;
  readonly interval: string;
  readonly confirmed: boolean;
  readonly candle: Candle;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function validateWsCandle(open: string, high: string, low: string, close: string, volume: string): boolean {
  try {
    const o = new Decimal(open);
    const h = new Decimal(high);
    const l = new Decimal(low);
    const c = new Decimal(close);
    const v = new Decimal(volume);

    if (!o.isFinite() || !h.isFinite() || !l.isFinite() || !c.isFinite() || !v.isFinite()) return false;
    if (o.lte(0) || h.lte(0) || l.lte(0) || c.lte(0)) return false;
    if (h.lt(l)) return false;
    if (h.lt(o) || h.lt(c)) return false;
    if (l.gt(o) || l.gt(c)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseKlineItem(symbol: string, interval: string, item: unknown): KlineUpdate | null {
  if (!isRecord(item)) return null;
  const { start, open, high, low, close, volume, confirm } = item;
  if (typeof start !== 'string' && typeof start !== 'number') return null;
  if (typeof open !== 'string' || typeof high !== 'string' || typeof low !== 'string'
    || typeof close !== 'string' || typeof volume !== 'string') {
    return null;
  }
  if (!validateWsCandle(open, high, low, close, volume)) {
    logger.warn(`Skipping invalid WS kline for ${symbol} ${interval}: ${JSON.stringify({ open, high, low, close, volume }).slice(0, 200)}`);
    return null;
  }
  // Only process confirmed candles for SMC logic (confirm === true)
  // Intermediate ticks (confirm: false) are not used for SMC logic
  const confirmed = confirm === true;
  return {
    symbol,
    interval,
    confirmed,
    candle: {
      timestamp: Number(start),
      open,
      high,
      low,
      close,
      volume,
    },
  };
}

export class BybitWebsocket {
  private readonly ws: WebsocketClient;
  private klineHandler: ((update: KlineUpdate) => void) | null = null;
  private executionHandler: ((payload: unknown) => void) | null = null;
  private positionHandler: ((payload: unknown) => void) | null = null;
  private resyncHandler: (() => Promise<void>) | null = null;

  constructor(config: BotConfig) {
    this.ws = new WebsocketClient({
      key: config.apiKey,
      secret: config.apiSecret,
      testnet: config.testnet,
      demoTrading: config.demoTrading,
      pingInterval: WS_HEARTBEAT_INTERVAL_MS,
    });
    this.registerLifecycleHandlers();
  }

  private registerLifecycleHandlers(): void {
    this.ws.on('update', (event) => this.routeUpdate(event));

    this.ws.on('open', ({ wsKey }) => logger.info(`WS connected: ${String(wsKey)}`));

    this.ws.on('authenticated', () => logger.info('WS private channel authenticated'));

    this.ws.on('reconnect', ({ wsKey }) => logger.warn(`WS reconnecting: ${String(wsKey)}`));

    this.ws.on('reconnected', ({ wsKey }) => {
      logger.warn(`WS reconnected: ${String(wsKey)}, running resync`);
      const resync = this.resyncHandler;
      if (resync) {
        resync().catch((error: unknown) => logger.error(
          `Resync after reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });

    this.ws.on('close', ({ wsKey }) => logger.warn(`WS closed: ${String(wsKey)}`));

    this.ws.on('exception', (response) => logger.error(
      `WS exception on ${String(response.wsKey)}: ${JSON.stringify(response.message ?? response.event ?? response).slice(0, 500)}`,
    ));
  }

  private routeUpdate(event: unknown): void {
    if (!isRecord(event)) return;
    const topic = event.topic;
    if (typeof topic !== 'string') return;

    if (topic.startsWith('kline.')) {
      const parts = topic.split('.');
      if (parts.length !== 3) return;
      const interval = parts[1];
      const symbol = parts[2];
      if (!Array.isArray(event.data)) return;
      for (const item of event.data) {
        const update = parseKlineItem(symbol, interval, item);
        if (update && this.klineHandler) this.klineHandler(update);
      }
      return;
    }

    if (topic === 'execution' && this.executionHandler) {
      this.executionHandler(event.data);
    } else if (topic === 'position' && this.positionHandler) {
      this.positionHandler(event.data);
    }
  }

  onKline(handler: ((update: KlineUpdate) => void) | null): void {
    this.klineHandler = handler;
  }

  onExecution(handler: ((payload: unknown) => void) | null): void {
    this.executionHandler = handler;
  }

  onPosition(handler: ((payload: unknown) => void) | null): void {
    this.positionHandler = handler;
  }

  onResync(handler: (() => Promise<void>) | null): void {
    this.resyncHandler = handler;
  }

  async subscribeKlines(symbols: readonly string[], intervals: readonly Timeframe[]): Promise<void> {
    const topics = symbols.flatMap((symbol) => intervals.map((interval) => `kline.${interval}.${symbol}`));
    if (topics.length === 0) return;
    await Promise.all(this.ws.subscribeV5(topics, 'linear'));
  }

  async subscribePrivate(): Promise<void> {
    await Promise.all(this.ws.subscribeV5(['execution', 'position'], 'linear', true));
  }

  close(): void {
    try {
      this.ws.close('v5LinearPublic');
      this.ws.close('v5Private');
    } catch (error) {
      logger.warn(`WS close error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
