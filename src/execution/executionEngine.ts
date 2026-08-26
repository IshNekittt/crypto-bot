import { PositionPlan } from '../risk/riskManager';
import { TelegramNotifier } from '../telegram/notifier';
import { logger } from '../utils/logger';

const RATE_LIMIT_RET_CODE = '10006';
const INSUFFICIENT_BALANCE_RET_CODE = '110007';
const CIRCUIT_BREAKER_TRIGGER_COUNT = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 60 * 1000;

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

interface CircuitBreakerState {
  consecutiveErrors: number;
  blockedUntilMs: number;
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
  private readonly breakers = new Map<string, CircuitBreakerState>();

  constructor(submitter: OrderSubmitter, notifier: TelegramNotifier) {
    this.submitter = submitter;
    this.notifier = notifier;
  }

  isBlocked(symbol: string, now: number = Date.now()): boolean {
    const state = this.breakers.get(symbol);
    return state !== undefined && now < state.blockedUntilMs;
  }

  async execute(plan: PositionPlan): Promise<ExecutionResult> {
    if (this.isBlocked(plan.symbol)) {
      const reason = `${plan.symbol}: trading is paused by circuit breaker`;
      logger.warn(`Execution skipped: ${reason}`);
      return { ok: false, reason };
    }

    try {
      const orderId = await this.submitter.placeMarketOrderWithTpsl({
        symbol: plan.symbol,
        side: plan.side,
        qty: plan.qty,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
      });
      this.clearErrors(plan.symbol);
      logger.info(
        `Order placed: ${plan.symbol} ${plan.side} qty=${plan.qty} entry≈${plan.entryPrice} sl=${plan.stopLoss} tp=${plan.takeProfit} id=${orderId}`,
      );
      await this.notifier.notifyOrderOpened();
      return { ok: true, orderId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Order failed for ${plan.symbol}: ${message}`);

      if (isThrottlingOrMarginError(error)) {
        const tripped = this.registerError(plan.symbol);
        if (tripped) {
          await this.notifier.notifyCriticalError(
            `${plan.symbol}: circuit breaker — торговля остановлена на 1 час после 3 ошибок подряд (${message})`,
          );
          return { ok: false, reason: `${plan.symbol}: circuit breaker tripped — ${message}` };
        }
      }

      await this.notifier.notifyCriticalError(`${plan.symbol}: ордер отклонён — ${message}`);
      return { ok: false, reason: message };
    }
  }

  private registerError(symbol: string): boolean {
    let state = this.breakers.get(symbol);
    if (!state) {
      state = { consecutiveErrors: 0, blockedUntilMs: 0 };
      this.breakers.set(symbol, state);
    }
    state.consecutiveErrors += 1;
    if (state.consecutiveErrors >= CIRCUIT_BREAKER_TRIGGER_COUNT) {
      state.blockedUntilMs = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      state.consecutiveErrors = 0;
      logger.error(`${symbol}: circuit breaker OPEN until ${new Date(state.blockedUntilMs).toISOString()}`);
      return true;
    }
    return false;
  }

  private clearErrors(symbol: string): void {
    const state = this.breakers.get(symbol);
    if (state) state.consecutiveErrors = 0;
  }
}
