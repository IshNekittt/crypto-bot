import { Decimal } from 'decimal.js';
import { TAKE_PROFIT_RR_RATIO } from '../smc/smc';
import { InstrumentInfo, TradeRecord, TradeSide } from '../types';
import { roundDownToStep } from '../utils/precision';

export interface BalanceSource {
  getUsdtBalance(): Promise<Decimal>;
}

export interface TradeHistorySource {
  getRecentClosedTrades(limit: number): TradeRecord[];
}

export interface RiskManagerOptions {
  readonly baseRiskPercent: string;
  readonly reducedRiskPercent: string;
}

export const DRAWDOWN_LOSING_TRADES_COUNT = 3;

export interface PositionPlanInput {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly entryPrice: Decimal;
  readonly stopLossRaw: Decimal;
  readonly instrument: InstrumentInfo;
}

export interface PositionPlan {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly entryPrice: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly qty: string;
  readonly slDistance: string;
  readonly riskAmount: string;
  readonly riskPercentApplied: string;
  readonly balanceUsdt: string;
}

export type PositionPlanResult =
  | { readonly ok: true; readonly plan: PositionPlan }
  | { readonly ok: false; readonly reason: string };

function isLosingTrade(trade: TradeRecord): boolean {
  return trade.pnl !== null && new Decimal(trade.pnl).isNegative();
}

export class RiskManager {
  private readonly balanceSource: BalanceSource;
  private readonly historySource: TradeHistorySource;
  private readonly options: RiskManagerOptions;

  constructor(balanceSource: BalanceSource, historySource: TradeHistorySource, options: RiskManagerOptions) {
    this.balanceSource = balanceSource;
    this.historySource = historySource;
    this.options = options;
  }

  async getEffectiveRiskPercent(): Promise<Decimal> {
    const recent = this.historySource.getRecentClosedTrades(DRAWDOWN_LOSING_TRADES_COUNT);
    if (recent.length >= DRAWDOWN_LOSING_TRADES_COUNT && recent.every(isLosingTrade)) {
      return new Decimal(this.options.reducedRiskPercent);
    }
    return new Decimal(this.options.baseRiskPercent);
  }

  async calculatePosition(input: PositionPlanInput): Promise<PositionPlanResult> {
    const tickSize = new Decimal(input.instrument.tickSize);
    const qtyStep = new Decimal(input.instrument.qtyStep);
    const minOrderQty = new Decimal(input.instrument.minOrderQty);
    const maxOrderQty = new Decimal(input.instrument.maxOrderQty);

    if (tickSize.lte(0) || qtyStep.lte(0)) {
      return { ok: false, reason: `${input.symbol}: invalid instrument filters (tickSize=${tickSize}, qtyStep=${qtyStep})` };
    }

    const isLong = input.side === 'Buy';
    const entry = roundDownToStep(input.entryPrice, tickSize);
    const stopLoss = roundDownToStep(input.stopLossRaw, tickSize);

    const slDistance = isLong ? entry.minus(stopLoss) : stopLoss.minus(entry);
    if (slDistance.lte(0)) {
      return {
        ok: false,
        reason: `${input.symbol}: invalid SL level for ${input.side} side (entry=${entry}, sl=${stopLoss})`,
      };
    }

    const takeProfitRaw = isLong
      ? entry.plus(slDistance.mul(TAKE_PROFIT_RR_RATIO))
      : entry.minus(slDistance.mul(TAKE_PROFIT_RR_RATIO));
    const takeProfit = roundDownToStep(takeProfitRaw, tickSize);

    const riskPercent = await this.getEffectiveRiskPercent();
    const balance = await this.balanceSource.getUsdtBalance();
    if (!balance.isFinite() || balance.lte(0)) {
      return { ok: false, reason: `${input.symbol}: unusable USDT balance (${balance})` };
    }

    const riskAmount = balance.mul(riskPercent.div(100));
    const rawQty = riskAmount.div(slDistance);
    const qty = roundDownToStep(rawQty, qtyStep);

    if (qty.lt(minOrderQty)) {
      return {
        ok: false,
        reason: `${input.symbol}: rounded qty ${qty.toFixed()} < minOrderQty ${minOrderQty.toFixed()} — trade aborted`,
      };
    }
    if (qty.gt(maxOrderQty)) {
      return {
        ok: false,
        reason: `${input.symbol}: qty ${qty.toFixed()} > maxOrderQty ${maxOrderQty.toFixed()} — trade aborted`,
      };
    }

    return {
      ok: true,
      plan: {
        symbol: input.symbol,
        side: input.side,
        entryPrice: entry.toFixed(),
        stopLoss: stopLoss.toFixed(),
        takeProfit: takeProfit.toFixed(),
        qty: qty.toFixed(),
        slDistance: slDistance.toFixed(),
        riskAmount: riskAmount.toFixed(),
        riskPercentApplied: riskPercent.toFixed(),
        balanceUsdt: balance.toFixed(),
      },
    };
  }
}
