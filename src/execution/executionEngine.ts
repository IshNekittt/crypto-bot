import { PositionPlan } from '../risk/riskManager';
import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { TimeInForce } from '../types';

const RATE_LIMIT_RET_CODE = '10006';
const INSUFFICIENT_BALANCE_RET_CODE = '110007';

export interface OrderSubmitter {
  placeMarketOrderWithTpsl(request: {
    symbol: string;
    side: string;
    qty: string;
    stopLoss: string;
    takeProfit: string;
    orderLinkId: string; // Idempotency key
  }): Promise<string>;

  placeLimitOrderWithTpsl(request: {
    symbol: string;
    side: string;
    qty: string;
    price: string;
    stopLoss: string;
    takeProfit: string;
    orderLinkId: string;
    timeInForce: TimeInForce;
  }): Promise<string>;
}

export type ExecutionResult =
  | { readonly ok: true; readonly orderId: string }
  | { readonly ok: false; readonly reason: string };

function isCircuitBreakerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Circuit breaker OPEN');
}

function isThrottlingOrMarginError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = /\[(\d+)\]/.exec(message);
  if (codeMatch) {
    if (codeMatch[1] === RATE_LIMIT_RET_CODE || codeMatch[1] === INSUFFICIENT_BALANCE_RET_CODE) {
      return true;
    }
  }
  return /rate limit|insufficient/i.test(message);
}

export class ExecutionEngine {
  private readonly submitter: OrderSubmitter;
  private readonly notifier: TelegramNotifier;

  constructor(submitter: OrderSubmitter, notifier: TelegramNotifier) {
    this.submitter = submitter;
    this.notifier = notifier;
  }

  async execute(plan: PositionPlan): Promise<ExecutionResult> {
    try {
      const orderLinkId = `${plan.symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let orderId: string;

      if (plan.orderType === 'Limit' && plan.limitPrice) {
        orderId = await this.submitter.placeLimitOrderWithTpsl({
          symbol: plan.symbol,
          side: plan.side,
          qty: plan.qty,
          price: plan.limitPrice,
          stopLoss: plan.stopLoss,
          takeProfit: plan.takeProfit,
          orderLinkId,
          timeInForce: 'GTC',
        });
        logger.info(
          `LIMIT Order placed: ${plan.symbol} ${plan.side} qty=${plan.qty} price=${plan.limitPrice} sl=${plan.stopLoss} tp=${plan.takeProfit} id=${orderId}`,
        );
      } else {
        orderId = await this.submitter.placeMarketOrderWithTpsl({
          symbol: plan.symbol,
          side: plan.side,
          qty: plan.qty,
          stopLoss: plan.stopLoss,
          takeProfit: plan.takeProfit,
          orderLinkId,
        });
        logger.info(
          `MARKET Order placed: ${plan.symbol} ${plan.side} qty=${plan.qty} entry≈${plan.entryPrice} sl=${plan.stopLoss} tp=${plan.takeProfit} id=${orderId}`,
        );
      }
      await this.notifier.notifyOrderOpened(plan.symbol, plan.entryPrice, plan.stopLoss, plan.takeProfit);
      return { ok: true, orderId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Order failed for ${plan.symbol}: ${message}`);

      if (isCircuitBreakerError(error)) {
        await this.notifier.notifyCriticalError(
          `${plan.symbol}: circuit breaker — отправка ордеров заблокирована на 60с (${message})`,
        );
        return { ok: false, reason: `${plan.symbol}: circuit breaker — ${message}` };
      }

      if (isThrottlingOrMarginError(error)) {
        await this.notifier.notifyCriticalError(
          `${plan.symbol}: rate limit / insufficient balance — ${message}`,
        );
        return { ok: false, reason: `${plan.symbol}: rate limit — ${message}` };
      }

      await this.notifier.notifyCriticalError(`${plan.symbol}: ордер отклонён — ${message}`);
      return { ok: false, reason: message };
    }
  }

  /**
   * Execute a live demo test order directly (bypassing StrategyEngine)
   * Used by /test_live_order command
   */
  async executeLiveDemoTest(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: string;
    entry: string;
    stopLoss: string;
    takeProfit: string;
  }): Promise<{ ok: boolean; orderId?: string; reason?: string; retCode?: number; retMsg?: string }> {
    try {
      const orderLinkId = `${params.symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const orderId = await this.submitter.placeMarketOrderWithTpsl({
        symbol: params.symbol,
        side: params.side,
        qty: params.qty,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        orderLinkId,
      });
      logger.info(
        `⚡ LIVE DEMO TEST Order placed: ${params.symbol} ${params.side} qty=${params.qty} entry≈${params.entry} sl=${params.stopLoss} tp=${params.takeProfit} id=${orderId}`,
      );
      return { ok: true, orderId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`⚡ LIVE DEMO TEST Order failed for ${params.symbol}: ${message}`);
      
      // Try to extract retCode and retMsg from error message
      let retCode: number | undefined;
      let retMsg: string | undefined;
      const codeMatch = /\[(\d+)\]/.exec(message);
      if (codeMatch) {
        retCode = parseInt(codeMatch[1], 10);
      }
      const msgMatch = /\"retMsg\":\"([^\"]+)\"/.exec(message) || /retMsg:\s*([^,\}]+)/.exec(message);
      if (msgMatch) {
        retMsg = msgMatch[1];
      }
      
      if (isCircuitBreakerError(error)) {
        await this.notifier.notifyCriticalError(
          `${params.symbol}: circuit breaker — отправка ордеров заблокирована на 60с (${message})`,
        );
        return { ok: false, reason: `${params.symbol}: circuit breaker — ${message}`, retCode, retMsg };
      }

      if (isThrottlingOrMarginError(error)) {
        await this.notifier.notifyCriticalError(
          `${params.symbol}: rate limit / insufficient balance — ${message}`,
        );
        return { ok: false, reason: `${params.symbol}: rate limit — ${message}`, retCode, retMsg };
      }

      await this.notifier.notifyCriticalError(`${params.symbol}: ордер отклонён — ${message}`);
      return { ok: false, reason: message, retCode, retMsg };
    }
  }
}
