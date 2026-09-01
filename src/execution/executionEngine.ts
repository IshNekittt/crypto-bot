import { PositionPlan } from '../risk/riskManager';
import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';

const RATE_LIMIT_RET_CODE = '10006';
const INSUFFICIENT_BALANCE_RET_CODE = '110007';

export interface OrderSubmitter {
  placeMarketOrderWithTpsl(request: {
    symbol: string;
    side: string;
    qty: string;
    stopLoss: string;
    takeProfit: string;
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
      const orderId = await this.submitter.placeMarketOrderWithTpsl({
        symbol: plan.symbol,
        side: plan.side,
        qty: plan.qty,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
      });
      logger.info(
        `Order placed: ${plan.symbol} ${plan.side} qty=${plan.qty} entry≈${plan.entryPrice} sl=${plan.stopLoss} tp=${plan.takeProfit} id=${orderId}`,
      );
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
}
