import { BybitClient } from '../api/bybitClient';
import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';

const FUNDING_POLL_INTERVAL_MS = 30 * 60 * 1000;

export class FundingMonitorService {
  private readonly client: BybitClient;
  private readonly notifier: TelegramNotifier;
  private readonly symbols: string[];
  private readonly alertThreshold: Decimal;
  private readonly restoreThreshold: Decimal;
  private readonly alertStates: Map<string, boolean> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private currentRates: Map<string, Decimal> = new Map();

  constructor(
    client: BybitClient,
    notifier: TelegramNotifier,
    symbols: string[],
    alertThreshold: string,
    restoreThreshold: string
  ) {
    this.client = client;
    this.notifier = notifier;
    this.symbols = symbols;
    this.alertThreshold = new Decimal(alertThreshold);
    this.restoreThreshold = new Decimal(restoreThreshold);

    for (const symbol of symbols) {
      this.alertStates.set(symbol, false);
    }
  }

  start(): void {
    if (this.timer) return;
    this.pollFundingRates();
    this.timer = setInterval(() => {
      void this.pollFundingRates();
    }, FUNDING_POLL_INTERVAL_MS);
    this.timer.unref();
    logger.info(`Funding monitor started for symbols: ${this.symbols.join(', ')} (interval: 30 min)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollFundingRates(): Promise<void> {
    try {
      const tickers = await this.client.getTickers({ category: 'linear' });
      
      for (const symbol of this.symbols) {
        const ticker = tickers.find(t => t.symbol === symbol);
        if (!ticker) {
          logger.debug(`No ticker data for ${symbol}`);
          continue;
        }

        const rate = new Decimal(ticker.fundingRate);
        this.currentRates.set(symbol, rate);

        const isAlerted = this.alertStates.get(symbol) ?? false;

        if (rate.lte(this.alertThreshold) && !isAlerted) {
          await this.sendAlert(symbol, rate);
          this.alertStates.set(symbol, true);
        } else if (rate.gte(this.restoreThreshold) && isAlerted) {
          await this.sendRestore(symbol, rate);
          this.alertStates.set(symbol, false);
        }
      }
    } catch (error) {
      logger.error(`Funding monitor poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async sendAlert(symbol: string, rate: Decimal): Promise<void> {
    const ratePct = rate.mul(100).toFixed(4);
    const text = [
      '⚠️ <b>[FUNDING ALERT]</b>',
      '',
      `📊 <b>Монета:</b> ${symbol}`,
      `📉 <b>Ставка:</b> ${ratePct}%`,
      '',
      '🔴 Рекомендуется закрыть арбитраж в приложении Bybit!',
    ].join('\n');

    await this.notifier.sendMessage(text);
    logger.info(`[FUNDING ALERT] ${symbol}: rate=${ratePct}%`);
  }

  private async sendRestore(symbol: string, rate: Decimal): Promise<void> {
    const ratePct = rate.mul(100).toFixed(4);
    const apy = rate.mul(3).mul(365).mul(100).toFixed(1);
    const text = [
      '🟢 <b>[FUNDING RESTORED]</b>',
      '',
      `📊 <b>Монета:</b> ${symbol}`,
      `📈 <b>Ставка:</b> +${ratePct}% (APY: ~${apy}%)`,
      '',
      '✅ Можно снова открывать арбитраж в приложении Bybit!',
    ].join('\n');

    await this.notifier.sendMessage(text);
    logger.info(`[FUNDING RESTORED] ${symbol}: rate=+${ratePct}% (APY: ~${apy}%)`);
  }

  getCurrentRates(): Map<string, Decimal> {
    return new Map(this.currentRates);
  }
}

export function createFundingMonitorService(
  client: BybitClient,
  notifier: TelegramNotifier,
  symbols: string[],
  alertThreshold: string,
  restoreThreshold: string
): FundingMonitorService {
  return new FundingMonitorService(client, notifier, symbols, alertThreshold, restoreThreshold);
}