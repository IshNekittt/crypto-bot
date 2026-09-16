import { RestClientV5 } from 'bybit-api';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../config/env';
import { Candle, InstrumentInfo, MarketOrderRequest, Timeframe } from '../types';
import { logger } from '../utils/logger';

export interface TimeSyncResult {
  readonly offsetMs: number;
  readonly roundTripMs: number;
}

export interface OpenPosition {
  readonly symbol: string;
  readonly side: 'Buy' | 'Sell';
  readonly size: Decimal;
  readonly avgPrice: Decimal;
}

export interface PositionListSource {
  getOpenPositions(symbol: string): Promise<readonly OpenPosition[]>;
  syncServerTime(): Promise<TimeSyncResult>;
}

export interface ClosedPnlRecord {
  readonly symbol: string;
  readonly side: 'Buy' | 'Sell';
  readonly qty: Decimal;
  readonly entryPrice: Decimal;
  readonly exitPrice: Decimal;
  readonly closedPnl: Decimal;
  readonly closedTime: number;
  readonly orderId: string;
}

export interface TickerInfo {
  readonly symbol: string;
  readonly fundingRate: string;
  readonly nextFundingTime: string;
}

type KlineRow = readonly [string, string, string, string, string, string, string];

const LEVERAGE_NOT_MODIFIED_RET_CODE = 110043;

const RATE_LIMIT_CODES = new Set([10006, 10007]);
const SERVER_ERROR_CODES = new Set([10001, 10002, 10003, 10004, 10005]);
const RATE_LIMIT_429_CODE = 429;

function isCircuitBreakerError(retCode: number): boolean {
  return RATE_LIMIT_CODES.has(retCode) || SERVER_ERROR_CODES.has(retCode) || retCode >= 50000;
}

function isRetryableError(retCode: number): boolean {
  return retCode === RATE_LIMIT_429_CODE || retCode === 503 || RATE_LIMIT_CODES.has(retCode);
}

function validateCandle(row: KlineRow): boolean {
  try {
    const timestamp = Number(row[0]);
    const open = new Decimal(row[1]);
    const high = new Decimal(row[2]);
    const low = new Decimal(row[3]);
    const close = new Decimal(row[4]);

    if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
    if (!open.isFinite() || !high.isFinite() || !low.isFinite() || !close.isFinite()) return false;
    if (!new Decimal(row[5]).isFinite()) return false;
    if (open.lte(0) || high.lte(0) || low.lte(0) || close.lte(0)) return false;
    if (high.lt(low)) return false;
    if (high.lt(open) || high.lt(close)) return false;
    if (low.gt(open) || low.gt(close)) return false;
    return true;
  } catch {
    return false;
  }
}

export function parseRestKlines(rows: readonly KlineRow[]): Candle[] {
  const candles: Candle[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!validateCandle(row)) {
      logger.warn(`Skipping invalid kline row: ${JSON.stringify(row).slice(0, 200)}`);
      continue;
    }
    candles.push({
      timestamp: Number(row[0]),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    });
  }
  return candles;
}

interface CircuitBreakerState {
  failures: number;
  blockedUntil: number;
}

interface GlobalRateLimitState {
  consecutive429Count: number;
  circuitOpen: boolean;
  circuitOpenUntil: number;
}

export class BybitClient {
  private readonly rest: RestClientV5;
  private readonly circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private static readonly MAX_FAILURES = 3;
  private static readonly BLOCK_DURATION_MS = 60_000;

  private readonly globalRateLimit: GlobalRateLimitState = {
    consecutive429Count: 0,
    circuitOpen: false,
    circuitOpenUntil: 0,
  };
  private static readonly GLOBAL_429_THRESHOLD = 3;
  private static readonly GLOBAL_CIRCUIT_DURATION_MS = 5 * 60 * 1000;
  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_BACKOFF_MS = 1000;

  private notifier: { notifyCriticalError: (msg: string) => Promise<boolean> } | null = null;
  public readonly config: BotConfig;

  constructor(rest: RestClientV5, config: BotConfig) {
    this.rest = rest;
    this.config = config;
  }

  setTelegramNotifier(notifier: { notifyCriticalError: (msg: string) => Promise<boolean> }): void {
    this.notifier = notifier;
  }

  private checkCircuitBreaker(symbol: string): boolean {
    const state = this.circuitBreakers.get(symbol);
    if (!state) return false;
    if (Date.now() < state.blockedUntil) return true;
    this.circuitBreakers.delete(symbol);
    return false;
  }

  private recordFailure(symbol: string, retCode: number): void {
    if (!isCircuitBreakerError(retCode)) return;
    let state = this.circuitBreakers.get(symbol);
    if (!state) {
      state = { failures: 0, blockedUntil: 0 };
      this.circuitBreakers.set(symbol, state);
    }
    state.failures += 1;
    if (state.failures >= BybitClient.MAX_FAILURES) {
      state.blockedUntil = Date.now() + BybitClient.BLOCK_DURATION_MS;
      logger.error(`Circuit breaker OPEN for ${symbol}: ${state.failures} failures, blocked for 60s`);
    }
  }

  private recordSuccess(symbol: string): void {
    const state = this.circuitBreakers.get(symbol);
    if (state) {
      state.failures = 0;
      state.blockedUntil = 0;
    }
  }

  private checkGlobalRateLimitCircuit(): boolean {
    if (this.globalRateLimit.circuitOpen) {
      if (Date.now() < this.globalRateLimit.circuitOpenUntil) {
        return true;
      }
      this.globalRateLimit.circuitOpen = false;
      this.globalRateLimit.consecutive429Count = 0;
      this.globalRateLimit.circuitOpenUntil = 0;
      logger.info('Global rate limit circuit breaker CLOSED (5 min expired)');
    }
    return false;
  }

  private recordGlobalRateLimitError(retCode: number): void {
    if (retCode === RATE_LIMIT_429_CODE) {
      this.globalRateLimit.consecutive429Count += 1;
      if (this.globalRateLimit.consecutive429Count >= BybitClient.GLOBAL_429_THRESHOLD) {
        this.globalRateLimit.circuitOpen = true;
        this.globalRateLimit.circuitOpenUntil = Date.now() + BybitClient.GLOBAL_CIRCUIT_DURATION_MS;
        logger.error(`🚨 GLOBAL Circuit breaker OPEN: ${this.globalRateLimit.consecutive429Count} consecutive 429 errors — REST paused for 5 minutes`);
        if (this.notifier) {
          this.notifier.notifyCriticalError('🚨 <b>API Rate Limit breached!</b>\n\nREST API paused for 5 minutes due to 3 consecutive 429 errors.');
        }
      }
    } else {
      this.globalRateLimit.consecutive429Count = 0;
    }
  }

  private recordGlobalRateLimitSuccess(): void {
    this.globalRateLimit.consecutive429Count = 0;
  }

  async executeWithRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    if (this.checkGlobalRateLimitCircuit()) {
      throw new Error('Global rate limit circuit breaker OPEN — REST paused for 5 minutes');
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= BybitClient.MAX_RETRIES; attempt++) {
      try {
        const result = await operation();
        this.recordGlobalRateLimitSuccess();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const message = lastError.message;

        const codeMatch = /\[(\d+)\]/.exec(message);
        const retCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;

        if (attempt < BybitClient.MAX_RETRIES && isRetryableError(retCode)) {
          const backoffMs = BybitClient.BASE_BACKOFF_MS * Math.pow(2, attempt);
          logger.warn(`[Retry ${attempt + 1}/${BybitClient.MAX_RETRIES}] ${operationName} failed with retCode=${retCode}, backing off ${backoffMs}ms: ${message}`);

          await new Promise(resolve => setTimeout(resolve, backoffMs));

          this.recordGlobalRateLimitError(retCode);
          continue;
        }

        this.recordGlobalRateLimitError(retCode);
        throw lastError;
      }
    }

    throw lastError;
  }

  static create(config: BotConfig): BybitClient {
    return new BybitClient(new RestClientV5({
      key: config.apiKey,
      secret: config.apiSecret,
      testnet: config.testnet,
      demoTrading: config.demoTrading,
      strict_param_validation: true,
    }), config);
  }

  async syncServerTime(): Promise<TimeSyncResult> {
    return this.executeWithRetry(async () => {
      const before = Date.now();
      const response = await this.rest.getServerTime();
      const after = Date.now();
      if (response.retCode !== 0) {
        throw new Error(`Bybit time sync failed: [${response.retCode}] ${response.retMsg}`);
      }
      const serverTimeMs = Number(response.result.timeNano) / 1_000_000;
      const localMidpointMs = (before + after) / 2;
      return {
        offsetMs: Math.round(serverTimeMs - localMidpointMs),
        roundTripMs: after - before,
      };
    }, 'syncServerTime');
  }

  async getInstrumentInfo(symbol: string): Promise<InstrumentInfo> {
    return this.executeWithRetry(async () => {
      const response = await this.rest.getInstrumentsInfo({ category: 'linear', symbol });
      if (response.retCode !== 0) {
        throw new Error(`Instruments info failed for ${symbol}: [${response.retCode}] ${response.retMsg}`);
      }
      const raw = response.result.list.find((item) => item.symbol === symbol);
      if (!raw) {
        throw new Error(`Symbol ${symbol} not found in Bybit linear instruments`);
      }
      const tickSize = raw.priceFilter?.tickSize;
      const qtyStep = raw.lotSizeFilter?.qtyStep;
      const minOrderQty = raw.lotSizeFilter?.minOrderQty;
      const maxOrderQty = raw.lotSizeFilter?.maxOrderQty;
      if (!tickSize || !qtyStep || !minOrderQty || !maxOrderQty) {
        throw new Error(`Incomplete lot/price filters for ${symbol}, cannot trade safely`);
      }
      return { symbol, tickSize, qtyStep, minOrderQty, maxOrderQty };
    }, 'getInstrumentInfo');
  }

  async getKlines(symbol: string, interval: Timeframe, limit: number, endTime?: number): Promise<Candle[]> {
    return this.executeWithRetry(async () => {
      const params: any = { category: 'linear', symbol, interval, limit };
      if (endTime !== undefined) params.end = endTime;
      const response = await this.rest.getKline(params);
      if (response.retCode !== 0) {
        throw new Error(`Kline fetch failed for ${symbol} ${interval}: [${response.retCode}] ${response.retMsg}`);
      }
      return parseRestKlines(response.result.list);
    }, 'getKlines');
  }

  async setupMarginAndLeverage(symbol: string, leverage: string): Promise<void> {
    return this.executeWithRetry(async () => {
      try {
        const marginResponse = await this.rest.switchIsolatedMargin({
          category: 'linear',
          symbol,
          tradeMode: 1,
          buyLeverage: leverage,
          sellLeverage: leverage,
        });
        if (marginResponse.retCode !== 0) {
          logger.warn(
            `Isolated margin unchanged for ${symbol}: [${marginResponse.retCode}] ${marginResponse.retMsg}`,
          );
        }
      } catch (error) {
        logger.warn(
          `Isolated margin setup skipped for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const leverageResponse = await this.rest.setLeverage({
        category: 'linear',
        symbol,
        buyLeverage: leverage,
        sellLeverage: leverage,
      });
      if (leverageResponse.retCode !== 0 && leverageResponse.retCode !== LEVERAGE_NOT_MODIFIED_RET_CODE) {
        throw new Error(
          `Set leverage failed for ${symbol}: [${leverageResponse.retCode}] ${leverageResponse.retMsg}`,
        );
      }
    }, 'setupMarginAndLeverage');
  }

  async getUsdtBalance(): Promise<Decimal> {
    return this.executeWithRetry(async () => {
      const accountTypes = ['UNIFIED', 'CONTRACT'] as const;
      let lastError = 'unknown error';
      for (const accountType of accountTypes) {
        try {
          const response = await this.rest.getWalletBalance({ accountType, coin: 'USDT' });
          if (response.retCode !== 0) {
            lastError = `[${response.retCode}] ${response.retMsg}`;
            continue;
          }
          const usdt = response.result.list
            .flatMap((account) => account.coin)
            .find((coin) => coin.coin === 'USDT');
          if (usdt) return new Decimal(usdt.walletBalance);
          lastError = `USDT not found in ${accountType} account`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(`Failed to fetch USDT balance: ${lastError}`);
    }, 'getUsdtBalance');
  }

  async placeMarketOrderWithTpsl(request: MarketOrderRequest): Promise<string> {
    if (this.checkCircuitBreaker(request.symbol)) {
      throw new Error(`Circuit breaker OPEN for ${request.symbol}: order placement blocked for 60s`);
    }

    return this.executeWithRetry(async () => {
      const response = await this.rest.submitOrder({
        category: 'linear',
        symbol: request.symbol,
        side: request.side,
        orderType: 'Market',
        qty: request.qty,
        timeInForce: 'IOC',
        tpslMode: 'Full',
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
      });

      if (response.retCode !== 0 || !response.result.orderId) {
        this.recordFailure(request.symbol, response.retCode);
        throw new Error(`[${response.retCode}] ${response.retMsg}`);
      }

      this.recordSuccess(request.symbol);
      return response.result.orderId;
    }, 'placeMarketOrderWithTpsl');
  }

  async getOpenPositions(symbol: string): Promise<readonly OpenPosition[]> {
    return this.executeWithRetry(async () => {
      const response = await this.rest.getPositionInfo({ category: 'linear', symbol });
      if (response.retCode !== 0) {
        throw new Error(`Position list failed for ${symbol}: [${response.retCode}] ${response.retMsg}`);
      }
      return response.result.list
        .filter((position) => Number(position.size) > 0 && (position.side === 'Buy' || position.side === 'Sell'))
        .map((position) => ({
          symbol: position.symbol,
          side: position.side as 'Buy' | 'Sell',
          size: new Decimal(position.size),
          avgPrice: new Decimal(position.avgPrice),
        }));
    }, 'getOpenPositions');
  }

  async getExecutions(symbol: string, startTime: number, endTime: number): Promise<readonly {
    readonly execId: string;
    readonly orderId: string;
    readonly side: 'Buy' | 'Sell';
    readonly execPrice: Decimal;
    readonly execQty: Decimal;
    readonly execValue: Decimal;
    readonly execTime: number;
    readonly execType: string;
    readonly isMaker: boolean;
  }[]> {
    return this.executeWithRetry(async () => {
      const response = await this.rest.getExecutionList({
        category: 'linear',
        symbol,
        startTime,
        endTime,
        limit: 50,
      });
      if (response.retCode !== 0) {
        throw new Error(`Execution list failed for ${symbol}: [${response.retCode}] ${response.retMsg}`);
      }
      return response.result.list
        .filter((exec) => exec.execType === 'Trade')
        .map((exec) => ({
          execId: exec.execId,
          orderId: exec.orderId,
          side: exec.side as 'Buy' | 'Sell',
          execPrice: new Decimal(exec.execPrice),
          execQty: new Decimal(exec.execQty),
          execValue: new Decimal(exec.execValue),
          execTime: Number(exec.execTime),
          execType: exec.execType,
          isMaker: exec.isMaker,
        }));
    }, 'getExecutions');
  }

  async getClosedPnl(symbol: string, startTime: number, endTime: number): Promise<ClosedPnlRecord[]> {
    return this.executeWithRetry(async () => {
      const response = await this.rest.getClosedPnL({
        category: 'linear',
        symbol,
        startTime,
        endTime,
        limit: 50,
      });
      if (response.retCode !== 0) {
        throw new Error(`Closed PnL fetch failed for ${symbol}: [${response.retCode}] ${response.retMsg}`);
      }
      return response.result.list
        .map((item) => ({
          symbol: item.symbol,
          side: item.side as 'Buy' | 'Sell',
          qty: new Decimal(item.qty),
          entryPrice: new Decimal(item.avgEntryPrice ?? '0'),
          exitPrice: new Decimal(item.avgExitPrice ?? '0'),
          closedPnl: new Decimal(item.closedPnl),
          closedTime: Number(item.updatedTime),
          orderId: item.orderId,
        }));
    }, 'getClosedPnl');
  }

  async getTickers(params: { category: 'linear' }): Promise<TickerInfo[]> {
    return this.executeWithRetry(async () => {
      const response = await this.rest.getTickers(params);
      if (response.retCode !== 0) {
        throw new Error(`Tickers fetch failed: [${response.retCode}] ${response.retMsg}`);
      }
      return response.result.list.map((item: any) => ({
        symbol: item.symbol,
        fundingRate: item.fundingRate ?? '0',
        nextFundingTime: item.nextFundingTime ?? '0',
      }));
    }, 'getTickers');
  }
}