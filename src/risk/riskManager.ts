import { Decimal } from "decimal.js";
import { InstrumentInfo, TradeRecord, TradeSide, OrderType } from "../types";
import {
  formatPrice,
  formatQuantity,
} from "../utils/precision";

export interface BalanceSource {
  getUsdtBalance(): Promise<Decimal>;
}

export interface TradeHistorySource {
  getRecentClosedTrades(limit: number): Promise<TradeRecord[]>;
}

export interface RiskManagerOptions {
  readonly baseRiskPercent: string;
  readonly reducedRiskPercent: string;
  readonly leverage: string;
}

export const DRAWDOWN_LOSING_TRADES_COUNT = 3;

export interface PositionPlanInput {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly entryPrice: Decimal;
  readonly stopLossRaw: Decimal;
  readonly takeProfitRaw: Decimal;
  readonly instrument: InstrumentInfo;
  readonly zoneDetails: {
    type: string | null;
    top: string | null;
    bottom: string | null;
    timeframe: string | null;
    direction: string | null;
    timestamp: number | null;
  } | null;
  readonly orderType?: OrderType;
  readonly limitPrice?: string;
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
  readonly scenarioId: number | null;
  readonly zoneDetails: {
    type: string | null;
    top: string | null;
    bottom: string | null;
    timeframe: string | null;
    direction: string | null;
    timestamp: number | null;
  } | null;
  readonly orderType: OrderType;
  readonly limitPrice: string | null;
}

export type PositionPlanResult =
  | { readonly ok: true; readonly plan: PositionPlan }
  | { readonly ok: false; readonly reason: string };

function isLosingTrade(trade: TradeRecord): boolean {
  return trade.pnl !== null && new Decimal(trade.pnl).isNegative();
}

// Export trade management utilities
export * from "./tradeManager";

export class RiskManager {
  private readonly balanceSource: BalanceSource;
  private readonly historySource: TradeHistorySource;
  private readonly options: RiskManagerOptions;

  constructor(
    balanceSource: BalanceSource,
    historySource: TradeHistorySource,
    options: RiskManagerOptions,
  ) {
    this.balanceSource = balanceSource;
    this.historySource = historySource;
    this.options = options;
  }

  async getEffectiveRiskPercent(): Promise<Decimal> {
    const recent = await this.historySource.getRecentClosedTrades(
      DRAWDOWN_LOSING_TRADES_COUNT,
    );
    if (
      recent.length >= DRAWDOWN_LOSING_TRADES_COUNT &&
      recent.every(isLosingTrade)
    ) {
      return new Decimal(this.options.reducedRiskPercent);
    }
    return new Decimal(this.options.baseRiskPercent);
  }

  async calculatePosition(
    input: PositionPlanInput,
  ): Promise<PositionPlanResult> {
    const tickSize = new Decimal(input.instrument.tickSize);
    const qtyStep = new Decimal(input.instrument.qtyStep);
    const minOrderQty = new Decimal(input.instrument.minOrderQty);
    const maxOrderQty = new Decimal(input.instrument.maxOrderQty);

    if (tickSize.lte(0) || qtyStep.lte(0)) {
      return {
        ok: false,
        reason: `${input.symbol}: invalid instrument filters (tickSize=${tickSize}, qtyStep=${qtyStep})`,
      };
    }

    const isLong = input.side === "Buy";
    const entry = formatPrice(input.entryPrice, tickSize);
    const stopLoss = formatPrice(input.stopLossRaw, tickSize);

    const entryDecimal = new Decimal(entry);
    const stopLossDecimal = new Decimal(stopLoss);
    const slDistanceDecimal = isLong
      ? entryDecimal.minus(stopLossDecimal)
      : stopLossDecimal.minus(entryDecimal);

    if (slDistanceDecimal.lte(0)) {
      return {
        ok: false,
        reason: `${input.symbol}: invalid SL level for ${input.side} side (entry=${entry}, sl=${stopLoss})`,
      };
    }

    const takeProfit = formatPrice(input.takeProfitRaw, tickSize);

    const riskPercent = await this.getEffectiveRiskPercent();
    const balance = await this.balanceSource.getUsdtBalance();
    if (!balance.isFinite() || balance.lte(0)) {
      return {
        ok: false,
        reason: `${input.symbol}: unusable USDT balance (${balance})`,
      };
    }

    // Margin Buffer: Use 98% of balance to leave 2% for fees/reserve
    const marginBuffer = balance.mul(0.98);
    
    // Leverage cap: max position value = marginBuffer * leverage
    const leverage = new Decimal(this.options.leverage);
    const maxAllowedQty = marginBuffer.mul(leverage).div(entryDecimal);
    
    const riskAmountDecimal = marginBuffer.mul(riskPercent.div(100));
    let rawQty = riskAmountDecimal.div(slDistanceDecimal);
    
    // Cap qty by max leverage
    if (rawQty.gt(maxAllowedQty)) {
      rawQty = maxAllowedQty;
    }
    
    const qty = formatQuantity(rawQty, qtyStep);

    if (new Decimal(qty).lt(minOrderQty)) {
      return {
        ok: false,
        reason: `${input.symbol}: rounded qty ${qty} < minOrderQty ${minOrderQty} — trade aborted`,
      };
    }
    if (new Decimal(qty).gt(maxOrderQty)) {
      return {
        ok: false,
        reason: `${input.symbol}: qty ${qty} > maxOrderQty ${maxOrderQty} — trade aborted`,
      };
    }
    const slDistance = slDistanceDecimal.toFixed();
    const riskAmount = riskAmountDecimal.toFixed();
    const riskPercentApplied = riskPercent.toFixed();
    const balanceUsdt = balance.toFixed();
    const qtyString = qty.toString();

    return {
      ok: true,
      plan: {
        symbol: input.symbol,
        side: input.side,
        entryPrice: entry,
        stopLoss: stopLoss,
        takeProfit: takeProfit,
        qty: qtyString,
        slDistance,
        riskAmount,
        riskPercentApplied,
        balanceUsdt,
        scenarioId: null,
        zoneDetails: input.zoneDetails,
        orderType: input.orderType ?? 'Market',
        limitPrice: input.limitPrice ?? null,
      },
    };
  }
}
