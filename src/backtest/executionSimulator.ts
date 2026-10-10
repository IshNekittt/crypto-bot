import { Decimal } from "decimal.js";
import { Candle, SniperZone } from "../types";
import { logger } from "../utils/logger";
import { evaluateTradeManagement, TradeContext } from "../risk/tradeManager";

export const TAKER_FEE_RATE = new Decimal("0.00055");
export const MAKER_FEE_RATE = new Decimal("0.00020"); // 0.020% Maker (Limit orders)
export const INITIAL_BALANCE = new Decimal("1000");
export const BASE_RISK_PERCENT = new Decimal("2");
export const REDUCED_RISK_PERCENT = new Decimal("1");
export const LEVERAGE = new Decimal("10");
export const TAKE_PROFIT_RR = new Decimal("3");
export const DRAWDOWN_GUARD_TRIGGER = 3; // Number of consecutive losses to trigger reduced risk
export const MIN_SL_DISTANCE_PCT = new Decimal("0.001"); // 0.1% minimum SL distance

// Debug: Track first 3 trades for detailed logging
let debugTradeOpenCount = 0;
let debugTradeCloseCount = 0;

export interface InstrumentInfo {
  symbol: string;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  maxOrderQty: string;
}

export interface TradeResult {
  entryTime: number;
  exitTime: number;
  entryPrice: Decimal;
  exitPrice: Decimal;
  slPrice: Decimal;
  tpPrice: Decimal;
  qty: Decimal;
  side: "Buy" | "Sell";
  pnl: Decimal;
  pnlPercent: Decimal;
  feesPaid: Decimal;
  scenarioId: number;
  scenarioName: string;
  closedBy: "TP" | "SL" | "BOTH";
  // Structure details for mitigation tracking
  structureType?: "SMS" | "CHoCH" | "BOS";
  structureTimestamp?: number;
  structurePrice?: Decimal;
}

export interface OpenTrade {
  entryTime: number;
  entryPrice: Decimal;
  slPrice: Decimal;
  tpPrice: Decimal;
  qty: Decimal;
  side: "Buy" | "Sell";
  scenarioId: number;
  scenarioName: string;
  entryFee: Decimal;
  // Zone details for mitigation tracking
  zoneType?: "OB" | "FVG" | "BREAKER" | "MITIGATION";
  zoneTop?: Decimal;
  zoneBottom?: Decimal;
  zoneTimeframe?: string;
  zoneDirection?: string;
  zoneTimestamp?: number;
  // Structure details for mitigation tracking (CHoCH/SMS timestamp and price)
  structureType?: "SMS" | "CHoCH" | "BOS";
  structureTimestamp?: number;
  structurePrice?: Decimal;
  // Limit order fields
  orderType?: "Market" | "Limit";
  limitPrice?: Decimal;
  limitOrderPlacedAt?: number;
  limitOrderCandlesWaited?: number;
  // Trade Management (Adaptive Fractioning)
  managementState?: {
    milestone1Triggered: boolean;
    milestone2Triggered: boolean;
    initialTotalR: string;
    initialQty: string;
  };
}

export interface PendingLimitOrder {
  entryPrice: Decimal;
  slPrice: Decimal;
  tpPrice: Decimal;
  qty: Decimal;
  side: "Buy" | "Sell";
  scenarioId: number;
  scenarioName: string;
  limitPrice: Decimal;
  placedAt: number;
  candlesWaited: number;
  zoneType?: "OB" | "FVG" | "BREAKER" | "MITIGATION";
  zoneTop?: Decimal;
  zoneBottom?: Decimal;
  zoneTimeframe?: string;
  zoneDirection?: string;
  zoneTimestamp?: number;
  structureType?: "SMS" | "CHoCH" | "BOS";
  structureTimestamp?: number;
  structurePrice?: Decimal;
}

export interface MitigatedStructure {
  type: "SMS" | "CHoCH" | "BOS";
  timestamp: number;
  price: string;
  direction: "BULLISH" | "BEARISH";
}

export interface BacktestState {
  balance: Decimal;
  equity: Decimal;
  peakBalance: Decimal;
  maxDrawdown: Decimal;
  trades: TradeResult[];
  consecutiveLosses: number;
  openTrade: OpenTrade | null;
  // Cooldown after SL hit: timestamp (ms) until which new trades are blocked
  cooldownUntil: number;
  // Zones that have been traded and should not be re-entered
  mitigatedZones: MitigatedZone[];
  // Structures (SMS/CHoCH/BOS) that have been traded and should not be re-used
  mitigatedStructures: MitigatedStructure[];
  // Pending limit order waiting for fill
  pendingLimitOrder: PendingLimitOrder | null;
  // Sniper Mode: active zone waiting for 1m entry trigger
  activeSniperZone: SniperZone | null;
}

export interface MitigatedZone {
  type: "OB" | "FVG" | "BREAKER" | "MITIGATION";
  top: string;
  bottom: string;
  timeframe: string;
  direction: string;
  timestamp: number;
}

function roundDownToStep(value: Decimal, step: Decimal): Decimal {
  const div = value.div(step).floor();
  return div.mul(step);
}

function calculatePositionSize(
  balance: Decimal,
  entryPrice: Decimal,
  slPrice: Decimal,
  instrument: InstrumentInfo,
  riskPercent: Decimal,
  maxWorkingCapital: Decimal,
): Decimal {
  const tickSize = new Decimal(instrument.tickSize);
  const qtyStep = new Decimal(instrument.qtyStep);
  const minOrderQty = new Decimal(instrument.minOrderQty);

  const entry = roundDownToStep(entryPrice, tickSize);
  const stopLoss = roundDownToStep(slPrice, tickSize);

  const slDistance = entry.minus(stopLoss).abs();
  if (slDistance.lte(0)) {
    return new Decimal("0");
  }

  // Strategy Capacity Limit: Apply maxWorkingCapital if configured
  let workingBalance = balance;
  if (maxWorkingCapital.gt(0)) {
    const maxCap = maxWorkingCapital;
    if (balance.gt(maxCap)) {
      workingBalance = maxCap;
    }
  }

  // FIX: Correct risk math - qty = (balance * riskPercent / 100) / |entry - sl|
  const riskAmount = workingBalance.mul(riskPercent.div(100));
  const rawQty = riskAmount.div(slDistance);
  const qty = roundDownToStep(rawQty, qtyStep);

  if (qty.lt(minOrderQty)) {
    return new Decimal("0");
  }

  return qty;
}

export function getInitialState(): BacktestState {
  return {
    balance: INITIAL_BALANCE,
    equity: INITIAL_BALANCE,
    peakBalance: INITIAL_BALANCE,
    maxDrawdown: new Decimal("0"),
    trades: [],
    consecutiveLosses: 0,
    openTrade: null,
    cooldownUntil: 0,
    mitigatedZones: [],
    mitigatedStructures: [] as MitigatedStructure[],
    pendingLimitOrder: null,
    activeSniperZone: null,
  };
}

/**
 * Get effective risk percent based on consecutive losses
 * Drawdown Guard: reduces risk to 1% after 3 consecutive losses
 */
export function getEffectiveRiskPercent(consecutiveLosses: number): Decimal {
  const riskPercent =
    consecutiveLosses >= DRAWDOWN_GUARD_TRIGGER
      ? REDUCED_RISK_PERCENT
      : BASE_RISK_PERCENT;

  if (consecutiveLosses >= DRAWDOWN_GUARD_TRIGGER) {
    logger.debug(
      `[Drawdown Guard] Active: ${consecutiveLosses} consecutive losses -> risk reduced to ${riskPercent.toString()}%`,
    );
  }

  return riskPercent;
}

export function openTrade(
  state: BacktestState,
  candle: Candle,
  entryPrice: Decimal,
  slPrice: Decimal,
  tpPrice: Decimal,
  side: "Buy" | "Sell",
  scenarioId: number,
  scenarioName: string,
  instrument: InstrumentInfo,
  zoneDetails?: {
    type: "OB" | "FVG" | "BREAKER" | "MITIGATION";
    top: Decimal;
    bottom: Decimal;
    timeframe: string;
    direction: string;
    timestamp: number;
  },
  structureDetails?: {
    type: "SMS" | "CHoCH" | "BOS";
    timestamp: number;
    price: Decimal;
  },
  orderType: "Market" | "Limit" = "Market",
  limitPrice?: Decimal,
  symbol?: string,
  maxWorkingCapital: Decimal = new Decimal("0"),
): { state: BacktestState; tradeOpened: boolean } {
  let slPriceAdjusted = slPrice;
  const slDistance = entryPrice.minus(slPrice).abs();

  // Fix 1: Minimum SL distance - 0.1% minimum to prevent micro-stops
  const minSlDistance = entryPrice.mul(MIN_SL_DISTANCE_PCT);
  if (slDistance.lt(minSlDistance)) {
    // Force SL to 0.1% distance
    if (side === "Buy") {
      slPriceAdjusted = entryPrice.minus(minSlDistance);
    } else {
      slPriceAdjusted = entryPrice.plus(minSlDistance);
    }
    logger.debug(
      `SL adjusted to minimum 0.1% distance: ${slPriceAdjusted.toFixed(4)}`,
    );
  }

  const slDistanceAdjusted = entryPrice.minus(slPriceAdjusted).abs();

  // ASSERT: SL must be on correct side of entry
  // Buy (Long): SL must be BELOW entry
  // Sell (Short): SL must be ABOVE entry
  if (side === "Buy") {
    if (slPriceAdjusted.gte(entryPrice)) {
      logger.error(
        `ASSERT FAILED: Buy trade has SL (${slPriceAdjusted.toFixed(4)}) >= entry (${entryPrice.toFixed(4)})`,
      );
      throw new Error(
        `Invalid SL for Buy: SL=${slPriceAdjusted.toFixed(4)} >= Entry=${entryPrice.toFixed(4)}`,
      );
    }
  } else {
    if (slPriceAdjusted.lte(entryPrice)) {
      logger.error(
        `ASSERT FAILED: Sell trade has SL (${slPriceAdjusted.toFixed(4)}) <= entry (${entryPrice.toFixed(4)})`,
      );
      throw new Error(
        `Invalid SL for Sell: SL=${slPriceAdjusted.toFixed(4)} <= Entry=${entryPrice.toFixed(4)}`,
      );
    }
  }

  if (slDistanceAdjusted.lte(0)) {
    return { state, tradeOpened: false };
  }

  if (state.cooldownUntil > 0 && state.cooldownUntil > candle.timestamp) {
    const cooldownHours = (
      (state.cooldownUntil - candle.timestamp) /
      (60 * 60 * 1000)
    ).toFixed(2);
    logger.info(
      `[${new Date(candle.timestamp).toISOString()}] Cooldown active after stop-loss. Skipping scan for ${cooldownHours}h.`,
    );
    return { state, tradeOpened: false };
  }

  // Check if already in a trade or have a pending limit order
  if (state.openTrade || state.pendingLimitOrder) {
    return { state, tradeOpened: false };
  }

  const riskPercent = getEffectiveRiskPercent(state.consecutiveLosses);

  // Strategy Capacity Limit: Apply maxWorkingCapital if configured
  let workingBalance = state.balance;
  if (maxWorkingCapital.gt(0)) {
    const maxCap = maxWorkingCapital;
    if (state.balance.gt(maxCap)) {
      workingBalance = maxCap;
    }
  }

  let qty = calculatePositionSize(
    workingBalance,
    entryPrice,
    slPriceAdjusted,
    instrument,
    riskPercent,
    maxWorkingCapital,
  );

  if (qty.lte(0)) {
    return { state, tradeOpened: false };
  }

  // Fix 2: Margin check - position value cannot exceed workingBalance * LEVERAGE
  const maxPositionValue = workingBalance.mul(LEVERAGE);
  const positionValue = qty.mul(entryPrice);
  if (positionValue.gt(maxPositionValue)) {
    // Reduce qty to fit within margin
    const maxQty = maxPositionValue.div(entryPrice);
    // Round down to qtyStep
    const qtyStep = new Decimal(instrument.qtyStep);
    qty = maxQty.div(qtyStep).floor().mul(qtyStep);
    logger.debug(
      `Qty reduced for margin: ${qty.toFixed(6)} (max position value: ${maxPositionValue.toFixed(2)})`,
    );
  }

  if (qty.lte(0)) {
    return { state, tradeOpened: false };
  }

  // Handle Limit orders: create pending order instead of immediate fill
  if (orderType === "Limit" && limitPrice) {
    const pendingOrder: PendingLimitOrder = {
      entryPrice,
      slPrice: slPriceAdjusted,
      tpPrice,
      qty,
      side,
      scenarioId,
      scenarioName,
      limitPrice,
      placedAt: candle.timestamp,
      candlesWaited: 0,
      zoneType: zoneDetails?.type,
      zoneTop: zoneDetails?.top,
      zoneBottom: zoneDetails?.bottom,
      zoneTimeframe: zoneDetails?.timeframe,
      zoneDirection: zoneDetails?.direction,
      zoneTimestamp: zoneDetails?.timestamp,
      structureType: structureDetails?.type,
      structureTimestamp: structureDetails?.timestamp,
      structurePrice: structureDetails?.price,
    };

    const newState: BacktestState = {
      ...state,
      pendingLimitOrder: pendingOrder,
      // Add zone to mitigatedZones to prevent re-entry on same zone
      mitigatedZones: zoneDetails
        ? [
            ...state.mitigatedZones,
            {
              type: zoneDetails.type as "OB" | "FVG" | "BREAKER" | "MITIGATION",
              top: zoneDetails.top.toString(),
              bottom: zoneDetails.bottom.toString(),
              timeframe: zoneDetails.timeframe,
              direction: zoneDetails.direction,
              timestamp: zoneDetails.timestamp,
            },
          ]
        : state.mitigatedZones,
    };

    logger.debug(
      `Backtest LIMIT ORDER PLACED: ${scenarioName} ${side} limitPrice=${limitPrice.toFixed(4)} SL=${slPriceAdjusted.toFixed(4)} TP=${tpPrice.toFixed(4)} qty=${qty.toFixed(6)}`,
    );
    return { state: newState, tradeOpened: false }; // Not opened yet, waiting for fill
  }

  // Market order: immediate fill (existing logic)
  const entryFee = entryPrice.mul(qty).mul(TAKER_FEE_RATE);

  // Initialize trade management state
  const managementState = {
    milestone1Triggered: false,
    milestone2Triggered: false,
    initialTotalR: "0",
    initialQty: qty.toString(),
  };

  const openTrade: OpenTrade = {
    entryTime: candle.timestamp,
    entryPrice,
    slPrice: slPriceAdjusted,
    tpPrice,
    qty,
    side,
    scenarioId,
    scenarioName,
    entryFee,
    zoneType: zoneDetails?.type,
    zoneTop: zoneDetails?.top,
    zoneBottom: zoneDetails?.bottom,
    zoneTimeframe: zoneDetails?.timeframe,
    zoneDirection: zoneDetails?.direction,
    zoneTimestamp: zoneDetails?.timestamp,
    structureType: structureDetails?.type,
    structureTimestamp: structureDetails?.timestamp,
    structurePrice: structureDetails?.price,
    orderType: "Market",
    managementState,
  };

  const newBalance = state.balance.minus(entryFee); // Deduct entry fee immediately
  const newPeak = newBalance.gt(state.peakBalance)
    ? newBalance
    : state.peakBalance;
  const drawdown = newPeak.minus(newBalance).div(newPeak).mul(100);

  const newState: BacktestState = {
    ...state,
    balance: newBalance,
    equity: newBalance,
    peakBalance: newPeak,
    maxDrawdown: drawdown.gt(state.maxDrawdown) ? drawdown : state.maxDrawdown,
    openTrade,
    // Add zone to mitigatedZones to prevent re-entry on same zone
    mitigatedZones: zoneDetails
      ? [
          ...state.mitigatedZones,
          {
            type: zoneDetails.type as "OB" | "FVG" | "BREAKER" | "MITIGATION",
            top: zoneDetails.top.toString(),
            bottom: zoneDetails.bottom.toString(),
            timeframe: zoneDetails.timeframe,
            direction: zoneDetails.direction,
            timestamp: zoneDetails.timestamp,
          },
        ]
      : state.mitigatedZones,
  };

  logger.debug(
    `Backtest OPEN: ${scenarioName} ${side} entry=${entryPrice.toFixed(4)} SL=${slPriceAdjusted.toFixed(4)} TP=${tpPrice.toFixed(4)} qty=${qty.toFixed(6)} balance=${newBalance.toFixed(2)}`,
  );

  // Debug: Log first 3 trades opening
  if (debugTradeOpenCount < 3) {
    debugTradeOpenCount++;
    const sym = symbol ?? "UNKNOWN";
    logger.warn(
      `[TRADE OPEN #${debugTradeOpenCount}] Symbol: ${sym} | Side: ${side} | Entry: ${entryPrice.toFixed(4)} | SL: ${slPriceAdjusted.toFixed(4)} | TP: ${tpPrice.toFixed(4)} | Candle: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`,
    );
  }

  return { state: newState, tradeOpened: true };
}

export function checkPendingLimitOrder(
  state: BacktestState,
  candle: Candle,
  config: { limitExpirationCandles: number; ltfTimeframe: string },
  symbol?: string,
): {
  state: BacktestState;
  limitOrderFilled: boolean;
  limitOrderExpired: boolean;
} {
  if (!state.pendingLimitOrder) {
    return { state, limitOrderFilled: false, limitOrderExpired: false };
  }

  const pending = state.pendingLimitOrder;
  const isLong = pending.side === "Buy";
  const high = new Decimal(candle.high);
  const low = new Decimal(candle.low);

  // Check if limit price is hit (wick pierces the limit price)
  const limitHit = isLong
    ? low.lte(pending.limitPrice)
    : high.gte(pending.limitPrice);

  // Increment candles waited
  const newCandlesWaited = pending.candlesWaited + 1;

  // Check expiration
  const expired = newCandlesWaited > config.limitExpirationCandles;

  if (limitHit) {
    // Limit order filled - convert to open trade
    // Limit orders that add liquidity pay MAKER fee (0.020%)
    const entryFee = pending.limitPrice.mul(pending.qty).mul(MAKER_FEE_RATE);

    const openTrade: OpenTrade = {
      entryTime: candle.timestamp,
      entryPrice: pending.limitPrice, // Filled at limit price
      slPrice: pending.slPrice,
      tpPrice: pending.tpPrice,
      qty: pending.qty,
      side: pending.side,
      scenarioId: pending.scenarioId,
      scenarioName: pending.scenarioName,
      entryFee,
      zoneType: pending.zoneType,
      zoneTop: pending.zoneTop,
      zoneBottom: pending.zoneBottom,
      zoneTimeframe: pending.zoneTimeframe,
      zoneDirection: pending.zoneDirection,
      zoneTimestamp: pending.zoneTimestamp,
      structureType: pending.structureType,
      structureTimestamp: pending.structureTimestamp,
      structurePrice: pending.structurePrice,
      orderType: "Limit",
      limitPrice: pending.limitPrice,
      limitOrderPlacedAt: pending.placedAt,
      limitOrderCandlesWaited: pending.candlesWaited,
    };

    const newBalance = state.balance.minus(entryFee);
    const newPeak = newBalance.gt(state.peakBalance)
      ? newBalance
      : state.peakBalance;
    const drawdown = newPeak.minus(newBalance).div(newPeak).mul(100);

    const newState: BacktestState = {
      ...state,
      balance: newBalance,
      equity: newBalance,
      peakBalance: newPeak,
      maxDrawdown: drawdown.gt(state.maxDrawdown)
        ? drawdown
        : state.maxDrawdown,
      openTrade,
      pendingLimitOrder: null,
      mitigatedZones: state.mitigatedZones, // Already added when limit order was placed
    };

    const sym = symbol ?? "UNKNOWN";
    logger.debug(
      `Backtest LIMIT ORDER FILLED: ${sym} ${pending.scenarioName} ${pending.side} limitPrice=${pending.limitPrice.toFixed(4)} filled@=${new Decimal(candle.low).toFixed(4)}/${new Decimal(candle.high).toFixed(4)} candlesWaited=${pending.candlesWaited}`,
    );
    return {
      state: newState,
      limitOrderFilled: true,
      limitOrderExpired: false,
    };
  }

  if (expired) {
    // Limit order expired - cancel it
    const sym = symbol ?? "UNKNOWN";
    logger.debug(
      `Backtest LIMIT ORDER EXPIRED: ${sym} ${pending.scenarioName} ${pending.side} limitPrice=${pending.limitPrice.toFixed(4)} after ${pending.candlesWaited} candles`,
    );
    const newState: BacktestState = {
      ...state,
      pendingLimitOrder: null,
      mitigatedZones: state.mitigatedZones, // Zone already burned, keep it
    };
    return {
      state: newState,
      limitOrderFilled: false,
      limitOrderExpired: true,
    };
  }

  // Still waiting - update candles waited
  const newState: BacktestState = {
    ...state,
    pendingLimitOrder: {
      ...pending,
      candlesWaited: newCandlesWaited,
    },
  };
  return { state: newState, limitOrderFilled: false, limitOrderExpired: false };
}

export function checkAndCloseTrade(
  state: BacktestState,
  candle: Candle,
  config: {
    cooldownCandles: number;
    ltfTimeframe: string;
    limitExpirationCandles: number;
    enableSniperMode?: boolean;
  },
  instrument: InstrumentInfo,
  symbol?: string,
): {
  state: BacktestState;
  tradeResult: TradeResult | null;
  mitigatedZone?: {
    type: "OB" | "FVG" | "BREAKER" | "MITIGATION";
    top: string;
    bottom: string;
    timeframe: string;
    direction: string;
    timestamp: number;
  };
} {
  // First check pending limit orders
  if (state.pendingLimitOrder) {
    const limitCheck = checkPendingLimitOrder(
      state,
      candle,
      {
        limitExpirationCandles: config.limitExpirationCandles,
        ltfTimeframe: config.ltfTimeframe,
      },
      symbol,
    );
    // If limit order was filled, we now have an open trade - continue to check for close on same candle
    // If limit order expired, just return the updated state
    if (limitCheck.limitOrderExpired || !limitCheck.limitOrderFilled) {
      return { state: limitCheck.state, tradeResult: null };
    }
    // Limit order was filled - continue with the new state to check for SL/TP on same candle
    state = limitCheck.state;
  }

  if (!state.openTrade) {
    return { state, tradeResult: null };
  }

  const trade = state.openTrade;

  // Skip closing on the same candle the trade was opened
  if (candle.timestamp <= trade.entryTime) {
    return { state, tradeResult: null };
  }

  const isLong = trade.side === "Buy";
  const high = new Decimal(candle.high);
  const low = new Decimal(candle.low);

  const hitSL = isLong ? low.lte(trade.slPrice) : high.gte(trade.slPrice);
  const hitTP = isLong ? high.gte(trade.tpPrice) : low.lte(trade.tpPrice);

  // === TRADE MANAGEMENT (Adaptive Fractioning) ===
  // Check for partial close / SL trailing signals
  const managementState = trade.managementState || {
    milestone1Triggered: false,
    milestone2Triggered: false,
    initialTotalR: "0",
    initialQty: trade.qty.toString(),
  };

  const managementContext: TradeContext = {
    entryPrice: trade.entryPrice.toString(),
    stopLoss: trade.slPrice.toString(),
    takeProfit: trade.tpPrice.toString(),
    currentPrice: (isLong ? high : low).toString(),
    side: trade.side as "Buy" | "Sell",
    initialQty: trade.qty.toString(),
    managementState,
    instrument,
  };

  const managementSignal = evaluateTradeManagement(managementContext);

  // Apply management signal
  let updatedTrade = trade;
  let updatedManagementState = managementState;

  if (managementSignal.action !== "none") {
    logger.debug(
      `Backtest Trade Management: ${managementSignal.action} - ${managementSignal.reason}`,
    );

    if (
      managementSignal.action === "move_sl_to_entry" ||
      managementSignal.action === "trail_sl_to_profit"
    ) {
      if (managementSignal.newStopLoss) {
        updatedTrade = {
          ...updatedTrade,
          slPrice: new Decimal(managementSignal.newStopLoss),
        };
        updatedManagementState = managementSignal.updatedState;
      }
    } else if (
      managementSignal.action === "close_partial_25" ||
      managementSignal.action === "close_partial_50"
    ) {
      if (managementSignal.closeQty) {
        // Simulate partial close: calculate PnL for closed portion
        const closeQty = new Decimal(managementSignal.closeQty);
        const closePrice = isLong ? high : low;
        const exitFee = closePrice.mul(closeQty).mul(TAKER_FEE_RATE);

        const priceDiff = isLong
          ? closePrice.minus(trade.entryPrice)
          : trade.entryPrice.minus(closePrice);
        const grossPnl = priceDiff.mul(closeQty);
        const netPnl = grossPnl.minus(exitFee);

        // Update balance with partial PnL
        const partialBalance = state.balance.plus(netPnl);
        const partialPeak = partialBalance.gt(state.peakBalance)
          ? partialBalance
          : state.peakBalance;
        const partialDrawdown = partialPeak
          .minus(partialBalance)
          .div(partialPeak)
          .mul(100);

        // Reduce qty
        const remainingQty = trade.qty.minus(closeQty);

        updatedTrade = {
          ...updatedTrade,
          qty: remainingQty,
          slPrice: managementSignal.newStopLoss
            ? new Decimal(managementSignal.newStopLoss)
            : updatedTrade.slPrice,
        };

        updatedManagementState = managementSignal.updatedState;

        // Update state balance and add partial close to trades
        const partialState: BacktestState = {
          ...state,
          balance: partialBalance,
          equity: partialBalance,
          peakBalance: partialPeak,
          maxDrawdown: partialDrawdown.gt(state.maxDrawdown)
            ? partialDrawdown
            : state.maxDrawdown,
          openTrade: updatedTrade,
        };

        // Apply management state update
        partialState.openTrade = {
          ...partialState.openTrade!,
          managementState: updatedManagementState,
        };

        return {
          state: partialState,
          tradeResult: null,
          mitigatedZone: undefined,
        };
      }
    }

    // Update management state in trade if it changed
    if (
      JSON.stringify(updatedManagementState) !== JSON.stringify(managementState)
    ) {
      updatedTrade = {
        ...updatedTrade,
        managementState: updatedManagementState,
      };
    }
  }

  // No hit - continue holding
  if (!hitSL && !hitTP) {
    // But if management updated SL, persist the updated trade
    if (updatedTrade.slPrice !== trade.slPrice) {
      const updatedState: BacktestState = {
        ...state,
        openTrade: updatedTrade,
      };
      return { state: updatedState, tradeResult: null };
    }
    return { state, tradeResult: null };
  }

  // CONSERVATIVE PRIORITY: If BOTH SL and TP hit in same candle wick -> LOSS at SL price
  // This prevents fake wins where price spiked both ways
  const bothHit = hitSL && hitTP;
  const exitPrice = bothHit
    ? trade.slPrice
    : hitSL
      ? trade.slPrice
      : trade.tpPrice;
  const closedBy = bothHit ? "BOTH" : hitSL ? "SL" : "TP";
  const isLoss = closedBy === "SL" || closedBy === "BOTH";

  const exitFee = exitPrice.mul(trade.qty).mul(TAKER_FEE_RATE);
  const totalFees = trade.entryFee.plus(exitFee);

  const priceDiff = isLong
    ? exitPrice.minus(trade.entryPrice)
    : trade.entryPrice.minus(exitPrice);
  const grossPnl = priceDiff.mul(trade.qty);
  const netPnl = grossPnl.minus(totalFees);
  const pnlPercent = netPnl.div(trade.entryPrice.mul(trade.qty)).mul(100);

  const newBalance = state.balance.plus(netPnl);
  const newPeak = newBalance.gt(state.peakBalance)
    ? newBalance
    : state.peakBalance;
  const drawdown = newPeak.minus(newBalance).div(newPeak).mul(100);

  // Prepare mitigated zone info from trade's zoneDetails (for run.ts local cache sync)
  let mitigatedZone:
    | {
        type: "OB" | "FVG" | "BREAKER" | "MITIGATION";
        top: string;
        bottom: string;
        timeframe: string;
        direction: string;
        timestamp: number;
      }
    | undefined;
  if (
    trade.zoneType &&
    trade.zoneTop &&
    trade.zoneBottom &&
    trade.zoneTimeframe &&
    trade.zoneDirection &&
    trade.zoneTimestamp
  ) {
    mitigatedZone = {
      type: trade.zoneType,
      top: trade.zoneTop.toString(),
      bottom: trade.zoneBottom.toString(),
      timeframe: trade.zoneTimeframe,
      direction: trade.zoneDirection,
      timestamp: trade.zoneTimestamp,
    };
  }

  // Structure mitigation: ALWAYS add trigger structure on close (win or loss)
  // Uses trade.structureDetails set by scenario via openTrade
  const structureTimestamp = trade.structureTimestamp ?? 0;
  const hasValidStructure = structureTimestamp > 0 && trade.structureType;

  const newState: BacktestState = {
    ...state,
    balance: newBalance,
    equity: newBalance,
    peakBalance: newPeak,
    maxDrawdown: drawdown.gt(state.maxDrawdown) ? drawdown : state.maxDrawdown,
    trades: [
      ...state.trades,
      {
        entryTime: trade.entryTime,
        exitTime: candle.timestamp,
        entryPrice: trade.entryPrice,
        exitPrice,
        slPrice: trade.slPrice,
        tpPrice: trade.tpPrice,
        qty: trade.qty,
        side: trade.side,
        pnl: netPnl,
        pnlPercent,
        feesPaid: totalFees,
        scenarioId: trade.scenarioId,
        scenarioName: trade.scenarioName,
        closedBy,
        structureType: trade.structureType,
        structureTimestamp: trade.structureTimestamp,
        structurePrice: trade.structurePrice,
      },
    ],
    consecutiveLosses: isLoss ? state.consecutiveLosses + 1 : 0,
    openTrade: null,
    // Cooldown after LOSS - uses execution timeframe (1m for Sniper, LTF for Classic)
    mitigatedStructures: hasValidStructure
      ? [
          ...state.mitigatedStructures,
          {
            type: trade.structureType!,
            timestamp: structureTimestamp,
            price: trade.structurePrice?.toString() || "0",
            direction: trade.side === "Buy" ? "BULLISH" : "BEARISH",
          },
        ]
      : state.mitigatedStructures,
    cooldownUntil: isLoss
      ? candle.timestamp +
        config.cooldownCandles *
          (config.enableSniperMode ? 1 : Number(config.ltfTimeframe)) *
          60 *
          1000
      : 0,
    // Mitigated zones already added in openTrade (burned on entry), preserve here
    mitigatedZones: state.mitigatedZones,
  };

  // Debug: Log first 3 trades closing
  if (debugTradeCloseCount < 3) {
    debugTradeCloseCount++;
    const sym = symbol ?? "UNKNOWN";
    logger.warn(
      `[TRADE CLOSE #${debugTradeCloseCount}] Symbol: ${sym} | Exit: ${exitPrice.toFixed(4)} | ${closedBy} | PnL: ${netPnl.toFixed(2)} | Candle H=${candle.high} L=${candle.low}`,
    );
  }

  const sym = symbol ?? "UNKNOWN";
  logger.debug(
    `Backtest CLOSE: ${sym} ${trade.scenarioName} ${trade.side} entry=${trade.entryPrice.toFixed(4)} exit=${exitPrice.toFixed(4)} pnl=${netPnl.toFixed(2)} (${closedBy}) balance=${newBalance.toFixed(2)}`,
  );

  return {
    state: newState,
    tradeResult: newState.trades[newState.trades.length - 1],
    mitigatedZone,
  };
}

/**
 * Process 1m candle in Sniper Mode
 * Checks for zone invalidation and 1m CHoCH trigger
 */
export interface SniperModeConfig {
  enableSniperMode: boolean;
  smcSlAtrOffset: string;
  smcDisplacementMultiplier: string;
}

export interface SniperMode1mStructure {
  type: "CHoCH" | "BOS" | "SMS";
  direction: "BULLISH" | "BEARISH";
  timestamp: number;
  price: Decimal;
  impulseFactor?: Decimal;
}

export function processSniperMode1mCandle(
  state: BacktestState,
  candle1m: Candle,
  activeSniperZone: {
    top: Decimal;
    bottom: Decimal;
    direction: "BULLISH" | "BEARISH";
    scenarioId: string;
    scenarioName: string;
  } | null,
  structures1m: SniperMode1mStructure[],
  config: SniperModeConfig & {
    ltfTimeframe: string;
    limitExpirationCandles: number;
    cooldownCandles: number;
    smcSlAtrOffset: string;
    smcDisplacementMultiplier: string;
    maxWorkingCapital: Decimal;
  },
  instrument: InstrumentInfo,
  _symbol?: string,
): {
  state: BacktestState;
  tradeOpened: boolean;
  tradeResult: TradeResult | null;
  sniperZoneCleared: boolean;
} {
  // If no active sniper zone, nothing to do
  if (!activeSniperZone) {
    return {
      state,
      tradeOpened: false,
      tradeResult: null,
      sniperZoneCleared: false,
    };
  }

  const isLong = activeSniperZone.direction === "BULLISH";
  const high = new Decimal(candle1m.high);
  const low = new Decimal(candle1m.low);

  // === CHECK ZONE INVALIDATION ===
  // If price breaks through the zone completely, invalidate the zone
  const zoneInvalidated = isLong
    ? low.lt(activeSniperZone.bottom) // Price went below zone bottom for long
    : high.gt(activeSniperZone.top); // Price went above zone top for short

  if (zoneInvalidated) {
    logger.debug(
      `Sniper zone invalidated: ${activeSniperZone.scenarioName} ${activeSniperZone.direction} zone broken by price`,
    );
    return {
      state: { ...state, activeSniperZone: null },
      tradeOpened: false,
      tradeResult: null,
      sniperZoneCleared: true,
    };
  }

  // === LOOK FOR 1m CHoCH TRIGGER ===
  // Look for CHoCH in the direction of the sniper zone, formed after we entered SNIPER_MODE
  const validChoch = structures1m.find(
    (s) =>
      s.type === "CHoCH" &&
      s.direction === activeSniperZone.direction &&
      s.impulseFactor &&
      s.impulseFactor.gte(new Decimal(config.smcDisplacementMultiplier)),
  );

  if (!validChoch) {
    // No valid trigger found, continue waiting
    return {
      state,
      tradeOpened: false,
      tradeResult: null,
      sniperZoneCleared: false,
    };
  }

  // === TRIGGER FOUND - CALCULATE ENTRY ===
  // idealEntry = 0.5 of CHoCH impulse (midpoint between CHoCH start and end)
  const chochStartPrice = validChoch.price;
  const chochEndPrice = new Decimal(candle1m.close);
  const idealEntry = chochStartPrice.plus(chochEndPrice).div(2);

  // Calculate SL using SMC_SL_ATR_OFFSET
  const atr = new Decimal("0.01"); // Placeholder - in real implementation would use actual ATR
  const slOffset = atr.mul(new Decimal(config.smcSlAtrOffset));
  const minSlOffset = idealEntry.mul(new Decimal("0.001")); // 0.1% minimum
  const effectiveSlOffset = Decimal.max(slOffset, minSlOffset);

  let slPrice: Decimal;
  let tpPrice: Decimal;
  const rr = new Decimal(3); // 1:3 risk-reward

  if (isLong) {
    slPrice = idealEntry.minus(effectiveSlOffset);
    tpPrice = idealEntry.plus(idealEntry.minus(slPrice).mul(rr));
  } else {
    slPrice = idealEntry.plus(effectiveSlOffset);
    tpPrice = idealEntry.minus(slPrice.minus(idealEntry).mul(rr));
  }

  // Validate SL is on correct side
  if (isLong && slPrice.gte(idealEntry)) {
    logger.warn(`Sniper Mode: Invalid SL for long, skipping`);
    return {
      state,
      tradeOpened: false,
      tradeResult: null,
      sniperZoneCleared: false,
    };
  }
  if (!isLong && slPrice.lte(idealEntry)) {
    logger.warn(`Sniper Mode: Invalid SL for short, skipping`);
    return {
      state,
      tradeOpened: false,
      tradeResult: null,
      sniperZoneCleared: false,
    };
  }

  // Open trade using existing openTrade function
  const { state: newStateAfterTrade, tradeOpened } = openTrade(
    state,
    {
      timestamp: candle1m.timestamp,
      open: candle1m.open,
      high: candle1m.high,
      low: candle1m.low,
      close: candle1m.close,
      volume: candle1m.volume,
    },
    idealEntry,
    slPrice,
    tpPrice,
    isLong ? "Buy" : "Sell",
    parseInt(activeSniperZone.scenarioId) || 99,
    `Sniper: ${activeSniperZone.scenarioName}`,
    {
      symbol: "UNKNOWN",
      tickSize: instrument.tickSize,
      qtyStep: instrument.qtyStep,
      minOrderQty: instrument.minOrderQty,
      maxOrderQty: instrument.maxOrderQty,
    },
    undefined,
    undefined,
    "Limit",
    idealEntry,
    undefined,
    config.maxWorkingCapital,
  );

  // Clear the sniper zone after triggering
  const finalState = { ...newStateAfterTrade, activeSniperZone: null };

  if (tradeOpened) {
    logger.info(
      `Sniper Mode: Triggered ${activeSniperZone.scenarioName} entry at ${idealEntry.toFixed(4)}`,
    );
  }

  return {
    state: finalState,
    tradeOpened,
    tradeResult: tradeOpened
      ? {
          entryTime: candle1m.timestamp,
          exitTime: 0,
          entryPrice: idealEntry,
          exitPrice: new Decimal(0),
          slPrice,
          tpPrice,
          qty: finalState.openTrade?.qty || new Decimal(0),
          side: isLong ? "Buy" : "Sell",
          pnl: new Decimal(0),
          pnlPercent: new Decimal(0),
          feesPaid: new Decimal(0),
          scenarioId: parseInt(activeSniperZone.scenarioId) || 99,
          scenarioName: `Sniper: ${activeSniperZone.scenarioName}`,
          closedBy: "TP" as const,
          structureType: "CHoCH",
          structureTimestamp: validChoch.timestamp,
          structurePrice: validChoch.price,
        }
      : null,
    sniperZoneCleared: false,
  };
}
