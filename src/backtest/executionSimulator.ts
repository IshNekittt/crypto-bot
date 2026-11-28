import { Decimal } from "decimal.js";
import { timeframeToMinutes } from "../utils/timeframe";
import { Candle, SniperZone, StructureType } from "../types";
import { logger } from "../utils/logger";
import { evaluateTradeManagement, initializeTradeManagement, TradeContext } from "../risk/tradeManager";
import { formatPrice, formatQuantity } from "../utils/precision";
import { MAKER_FEE_RATE, TAKER_FEE_RATE } from "../config/fees";

// Fee constants live in `src/config/fees.ts` so the live engine, the arithmetic
// gates and the simulator can never drift apart. Re-exported here because the
// simulation suite imports them from this module.
export { MAKER_FEE_RATE, TAKER_FEE_RATE };
export const INITIAL_BALANCE = new Decimal("1000");
export const BASE_RISK_PERCENT = new Decimal("2");
export const REDUCED_RISK_PERCENT = new Decimal("1");
export const LEVERAGE = new Decimal("10");
export const TAKE_PROFIT_RR = new Decimal("3");
export const DRAWDOWN_GUARD_TRIGGER = 3; // Number of consecutive losses to trigger reduced risk

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

/**
 * Live config mirror for sizing. When supplied, the simulator uses the same
 * leverage / risk percentages as the deployed engine instead of the historical
 * hardcoded defaults.
 */
export interface BacktestRiskConfig {
  leverage: string;
  riskPercent: string;
  reducedRiskPercent: string;
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
  // Gross PnL across the entire trade lifecycle (including partial closes).
  grossPnl?: Decimal;
  pnlPercent: Decimal;
  feesPaid: Decimal;
  scenarioId: number;
  scenarioName: string;
  closedBy: "TP" | "SL" | "BOTH";
  orderType?: "Market" | "Limit";
  // Structure details for mitigation tracking
  structureType?: StructureType;
  structureTimestamp?: number;
  structurePrice?: Decimal;
}

export interface OpenTrade {
  entryTime: number;
  entryPrice: Decimal;
  slPrice: Decimal;
  /**
   * ORIGINAL protective stop. Adaptive Fractioning may move `slPrice`
   * (breakeven / trailing), but this value never changes — risk distance and
   * every later milestone are measured from it.
   */
  initialSlPrice: string;
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
  structureType?: StructureType;
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
  // Realized gross PnL from partial closes (Adaptive Fractioning).
  // Accumulated here so the final TradeResult reflects the ENTIRE trade lifecycle.
  realizedGrossPnl?: string;
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
  structureType?: StructureType;
  structureTimestamp?: number;
  structurePrice?: Decimal;
}

export interface MitigatedStructure {
  type: StructureType;
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

function calculatePositionSize(
  marginBuffer: Decimal,
  entryPrice: Decimal,
  slPrice: Decimal,
  instrument: InstrumentInfo,
  riskPercent: Decimal,
  leverage: Decimal,
): Decimal {
  const tickSize = new Decimal(instrument.tickSize);
  const qtyStep = new Decimal(instrument.qtyStep);
  const minOrderQty = new Decimal(instrument.minOrderQty);

  const entry = new Decimal(formatPrice(entryPrice, tickSize));
  const stopLoss = new Decimal(formatPrice(slPrice, tickSize));

  const slDistance = entry.minus(stopLoss).abs();
  if (slDistance.lte(0)) {
    return new Decimal("0");
  }

  // Leverage cap: max position value = marginBuffer * leverage (RiskManager parity)
  const maxAllowedQty = marginBuffer.mul(leverage).div(entry);

  // FIX: Correct risk math - qty = (marginBuffer * riskPercent / 100) / |entry - sl|
  const riskAmount = marginBuffer.mul(riskPercent.div(100));
  let rawQty = riskAmount.div(slDistance);
  if (rawQty.gt(maxAllowedQty)) {
    rawQty = maxAllowedQty;
  }

  const qty = new Decimal(formatQuantity(rawQty, qtyStep));

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
export function getEffectiveRiskPercent(
  consecutiveLosses: number,
  riskConfig?: BacktestRiskConfig,
): Decimal {
  const baseRiskPercent = riskConfig
    ? new Decimal(riskConfig.riskPercent)
    : BASE_RISK_PERCENT;
  const reducedRiskPercent = riskConfig
    ? new Decimal(riskConfig.reducedRiskPercent)
    : REDUCED_RISK_PERCENT;

  const riskPercent =
    consecutiveLosses >= DRAWDOWN_GUARD_TRIGGER
      ? reducedRiskPercent
      : baseRiskPercent;

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
    type?: StructureType;
    timestamp: number;
    price: Decimal;
  },
  orderType: "Market" | "Limit" = "Market",
  limitPrice?: Decimal,
  symbol?: string,
  maxWorkingCapital: Decimal = new Decimal("0"),
  riskConfig?: BacktestRiskConfig,
): { state: BacktestState; tradeOpened: boolean } {
  // Instrument precision is the single source of truth: every level is normalized
  // once via formatPrice (nearest tick), exactly like RiskManager. No hardcoded
  // decimals and no double rounding.
  const tickSize = new Decimal(instrument.tickSize);
  const entryPriceFormatted = new Decimal(formatPrice(entryPrice, tickSize));
  const slPriceFormatted = new Decimal(formatPrice(slPrice, tickSize));
  const tpPriceFormatted = new Decimal(formatPrice(tpPrice, tickSize));
  const limitPriceFormatted =
    limitPrice !== undefined
      ? new Decimal(formatPrice(limitPrice, tickSize))
      : undefined;

  // Stop-loss geometry is owned exclusively by the scenario. Every scenario
  // derives its SL through `BaseScenario.calculateLevels()`, which already
  // enforces the 0.1% offset floor and the inverted-zone defense. Widening a
  // sub-0.1% stop here would rewrite the setup behind the strategy's back and
  // silently change R:R, position sizing and `initialTotalR` — behaviour the
  // live `RiskManager` never applies (it only rejects a non-positive distance).
  const slPriceAdjusted = slPriceFormatted;
  const slDistanceAdjusted = entryPriceFormatted.minus(slPriceAdjusted).abs();

  // ASSERT: SL must be on correct side of entry
  // Buy (Long): SL must be BELOW entry
  // Sell (Short): SL must be ABOVE entry
  if (side === "Buy") {
    if (slPriceAdjusted.gte(entryPriceFormatted)) {
      logger.error(
        `ASSERT FAILED: Buy trade has SL (${slPriceAdjusted.toFixed(4)}) >= entry (${entryPriceFormatted.toFixed(4)})`,
      );
      throw new Error(
        `Invalid SL for Buy: SL=${slPriceAdjusted.toFixed(4)} >= Entry=${entryPriceFormatted.toFixed(4)}`,
      );
    }
  } else {
    if (slPriceAdjusted.lte(entryPriceFormatted)) {
      logger.error(
        `ASSERT FAILED: Sell trade has SL (${slPriceAdjusted.toFixed(4)}) <= entry (${entryPriceFormatted.toFixed(4)})`,
      );
      throw new Error(
        `Invalid SL for Sell: SL=${slPriceAdjusted.toFixed(4)} <= Entry=${entryPriceFormatted.toFixed(4)}`,
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

  const riskPercent = getEffectiveRiskPercent(
    state.consecutiveLosses,
    riskConfig,
  );
  const leverage = riskConfig
    ? new Decimal(riskConfig.leverage)
    : LEVERAGE;

  // Strategy Capacity Limit: Apply maxWorkingCapital if configured
  let workingBalance = state.balance;
  if (maxWorkingCapital.gt(0)) {
    const maxCap = maxWorkingCapital;
    if (state.balance.gt(maxCap)) {
      workingBalance = maxCap;
    }
  }

  // Margin Buffer: 98% of working balance, leaving 2% for fees/reserve (RiskManager parity)
  const marginBuffer = workingBalance.mul(0.98);

  const qty = calculatePositionSize(
    marginBuffer,
    entryPriceFormatted,
    slPriceAdjusted,
    instrument,
    riskPercent,
    leverage,
  );

  if (qty.lte(0)) {
    return { state, tradeOpened: false };
  }

  if (qty.gt(new Decimal(instrument.maxOrderQty))) {
    logger.debug(
      `Qty ${qty.toFixed(6)} > maxOrderQty ${instrument.maxOrderQty} — trade aborted`,
    );
    return { state, tradeOpened: false };
  }

  // Burn-on-Entry: mirror live StrategyEngine — the trigger structure is consumed
  // the moment the trade (or its pending Limit order) is registered, not on close.
  let mitigatedStructures = state.mitigatedStructures;
  if (
    structureDetails &&
    structureDetails.timestamp > 0 &&
    !mitigatedStructures.some(
      (ms) => ms.timestamp === structureDetails.timestamp,
    )
  ) {
    mitigatedStructures = [
      ...mitigatedStructures,
      {
        type: (structureDetails.type || "CHoCH") as StructureType,
        timestamp: structureDetails.timestamp,
        price:
          structureDetails.price?.toString() ||
          entryPriceFormatted.toString(),
        direction: (side === "Buy" ? "BULLISH" : "BEARISH") as
          | "BULLISH"
          | "BEARISH",
      },
    ];
    if (mitigatedStructures.length > 100) {
      mitigatedStructures = mitigatedStructures.slice(-100);
    }
  }

  // Handle Limit orders: create pending order instead of immediate fill
  if (orderType === "Limit" && limitPriceFormatted) {
    const pendingOrder: PendingLimitOrder = {
      entryPrice: entryPriceFormatted,
      slPrice: slPriceAdjusted,
      tpPrice: tpPriceFormatted,
      qty,
      side,
      scenarioId,
      scenarioName,
      limitPrice: limitPriceFormatted,
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
      mitigatedStructures,
    };

    logger.debug(
      `Backtest LIMIT ORDER PLACED: ${scenarioName} ${side} limitPrice=${limitPriceFormatted.toFixed(4)} SL=${slPriceAdjusted.toFixed(4)} TP=${tpPriceFormatted.toFixed(4)} qty=${qty.toFixed(6)}`,
    );
    return { state: newState, tradeOpened: false }; // Not opened yet, waiting for fill
  }

  // Market order: immediate fill at the current price (parity with live avgPrice)
  const entryFee = entryPriceFormatted.mul(qty).mul(TAKER_FEE_RATE);

  // Adaptive Fractioning: persist the real initial R:R so the Sniper branch
  // (TotalR >= 4) can actually activate — parity with live trades.
  const managementState = initializeTradeManagement(
    entryPriceFormatted.toString(),
    slPriceAdjusted.toString(),
    tpPriceFormatted.toString(),
    qty.toString(),
  );

  const openTrade: OpenTrade = {
    entryTime: candle.timestamp,
    entryPrice: entryPriceFormatted,
    slPrice: slPriceAdjusted,
    initialSlPrice: slPriceAdjusted.toString(),
    tpPrice: tpPriceFormatted,
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
    orderType,
    managementState,
    realizedGrossPnl: "0",
  };

  // The entry fee is NOT deducted here: it is accumulated on the trade and settled
  // exactly once inside the closing net PnL (no double charge).
  const newBalance = state.balance;
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
    mitigatedStructures,
  };

  logger.debug(
    `Backtest OPEN: ${scenarioName} ${side} entry=${entryPriceFormatted.toFixed(4)} SL=${slPriceAdjusted.toFixed(4)} TP=${tpPriceFormatted.toFixed(4)} qty=${qty.toFixed(6)} balance=${newBalance.toFixed(2)}`,
  );

  // Debug: Log first 3 trades opening
  if (debugTradeOpenCount < 3) {
    debugTradeOpenCount++;
    const sym = symbol ?? "UNKNOWN";
    logger.warn(
      `[TRADE OPEN #${debugTradeOpenCount}] Symbol: ${sym} | Side: ${side} | Entry: ${entryPriceFormatted.toFixed(4)} | SL: ${slPriceAdjusted.toFixed(4)} | TP: ${tpPriceFormatted.toFixed(4)} | Candle: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`,
    );
  }

  return { state: newState, tradeOpened: true };
}

/**
 * Advance a pending Limit order by one candle of the execution timeframe.
 *
 * `config.limitExpirationCandles` is the EFFECTIVE lifetime in those candles:
 * in Sniper Mode the caller resolves it from `sniperLimitExpirationCandles` (1m
 * candles), in Classic mode from `limitExpirationCandles` (LTF candles). Resolving
 * at the call site keeps this simulator free of mode-specific arithmetic.
 */
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

    // Adaptive Fractioning: persist the real initial R:R (Sniper branch needs TotalR >= 4).
    const managementState = initializeTradeManagement(
      pending.limitPrice.toString(),
      pending.slPrice.toString(),
      pending.tpPrice.toString(),
      pending.qty.toString(),
    );

    const openTrade: OpenTrade = {
      entryTime: candle.timestamp,
      entryPrice: pending.limitPrice, // Filled at limit price
      slPrice: pending.slPrice,
      initialSlPrice: pending.slPrice.toString(),
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
      managementState,
      realizedGrossPnl: "0",
    };

    // The entry fee is NOT deducted here: it is accumulated on the trade and settled
    // exactly once inside the closing net PnL (no double charge).
    const newBalance = state.balance;
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
      // Structure was already burned when the Limit order was placed.
      mitigatedStructures: state.mitigatedStructures,
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
    initialStopLoss: trade.initialSlPrice ?? trade.slPrice.toString(),
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
  // Carries balance / peak / drawdown mutations produced by partial closes.
  let managedState = state;

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
      if (managementSignal.closeQty && managementSignal.triggerPrice) {
        // Fill at the EXACT milestone threshold — the price at which the signal
        // became true. The candle extreme (high/low) is a magic wick: it is not
        // a print a resting reduce-only order could capture, and on a wide candle
        // it can sit beyond the take-profit.
        const triggerPrice = new Decimal(managementSignal.triggerPrice);
        // A gapped open can already sit beyond the milestone. Fill at whichever
        // price the market offered first — the trigger, or the open. Both branches
        // stay inside [low, high] by construction (detection proves the extreme
        // reached the trigger).
        const closePrice = isLong
          ? Decimal.max(triggerPrice, new Decimal(candle.open))
          : Decimal.min(triggerPrice, new Decimal(candle.open));
        // Clamp to the remaining size: the minOrderQty fallback can otherwise
        // request more than the open position.
        const closeQty = Decimal.min(
          new Decimal(managementSignal.closeQty),
          updatedTrade.qty,
        );

        if (closeQty.gt(0)) {
          const partialFee = closePrice.mul(closeQty).mul(TAKER_FEE_RATE);

          const priceDiff = isLong
            ? closePrice.minus(trade.entryPrice)
            : trade.entryPrice.minus(closePrice);
          const grossPnl = priceDiff.mul(closeQty);

          // Fees are accumulated on the trade (entryFee acts as the total fee ledger)
          // and settled exactly once in the final close PnL — never deducted twice.
          const partialBalance = managedState.balance.plus(grossPnl);
          const partialPeak = partialBalance.gt(managedState.peakBalance)
            ? partialBalance
            : managedState.peakBalance;
          const partialDrawdown = partialPeak
            .minus(partialBalance)
            .div(partialPeak)
            .mul(100);

          updatedTrade = {
            ...updatedTrade,
            qty: updatedTrade.qty.minus(closeQty),
            entryFee: updatedTrade.entryFee.plus(partialFee),
            // Aggregate realized partial gross so the final TradeResult covers the
            // entire trade lifecycle instead of only the remaining position.
            realizedGrossPnl: new Decimal(updatedTrade.realizedGrossPnl || "0")
              .plus(grossPnl)
              .toString(),
            slPrice: managementSignal.newStopLoss
              ? new Decimal(managementSignal.newStopLoss)
              : updatedTrade.slPrice,
          };

          updatedManagementState = managementSignal.updatedState;

          // Balance / peak / drawdown advance now. Execution deliberately does NOT
          // return here: it continues to the SL/TP resolution below so a candle
          // that both triggers a milestone and pierces the stop cannot defer the
          // loss to a later candle.
          managedState = {
            ...managedState,
            balance: partialBalance,
            equity: partialBalance,
            peakBalance: partialPeak,
            maxDrawdown: partialDrawdown.gt(managedState.maxDrawdown)
              ? partialDrawdown
              : managedState.maxDrawdown,
          };
        }
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

  // Partial closes have already mutated balance / peak / drawdown. Carry those
  // into the SL/TP resolution below instead of returning early.
  state = managedState;

  // A partial that consumed the entire remaining position ends the trade at the
  // milestone price (possible when minOrderQty > 25% of the position).
  const exhaustedByPartial = updatedTrade.qty.lte(0);

  // No hit - continue holding
  if (!hitSL && !hitTP && !exhaustedByPartial) {
    // Persist any management change (new SL, reduced qty, realized partial PnL).
    if (updatedTrade !== trade) {
      const updatedState: BacktestState = {
        ...state,
        openTrade: updatedTrade,
      };
      return { state: updatedState, tradeResult: null };
    }
    return { state, tradeResult: null };
  }

  // CONSERVATIVE PRIORITY: If BOTH SL and TP hit in same candle wick -> LOSS at SL price
  // This prevents fake wins where price spiked both ways.
  // NOTE: hitSL/hitTP are evaluated against the PRE-management stop, so moving the
  // stop to entry never manufactures a false breakeven in the same candle.
  const bothHit = hitSL && hitTP;
  const exitPrice = exhaustedByPartial
    ? new Decimal(
        managementSignal.triggerPrice ?? updatedTrade.slPrice.toString(),
      )
    : bothHit
      ? trade.slPrice
      : hitSL
        ? trade.slPrice
        : trade.tpPrice;
  const closedBy = exhaustedByPartial
    ? "TP"
    : bothHit
      ? "BOTH"
      : hitSL
        ? "SL"
        : "TP";

  // Remaining size and the accumulated fee ledger — both may have been reduced
  // by a partial close earlier in this same candle.
  const exitFee = exitPrice.mul(updatedTrade.qty).mul(TAKER_FEE_RATE);
  const totalFees = updatedTrade.entryFee.plus(exitFee);

  const priceDiff = isLong
    ? exitPrice.minus(trade.entryPrice)
    : trade.entryPrice.minus(exitPrice);
  const finalGrossPnl = priceDiff.mul(updatedTrade.qty);

  // Aggregate partial-close gross PnL so TradeResult reflects the ENTIRE trade
  // lifecycle, matching run.ts balance aggregation (initial + Σ trade.pnl).
  const totalGrossPnl = finalGrossPnl.plus(updatedTrade.realizedGrossPnl || "0");
  const netPnl = totalGrossPnl.minus(totalFees);

  // Loss is defined by realized PnL sign (live parity): a "TP" that loses after
  // fees still increments the Drawdown Guard and arms the cooldown.
  const isLoss = netPnl.lt(0);

  // Percent is measured against the initial position notional — a lifecycle PnL
  // divided by the remaining qty would overstate the return after partial closes.
  const initialQty = new Decimal(
    trade.managementState?.initialQty || trade.qty.toString(),
  );
  const pnlPercent = netPnl.div(trade.entryPrice.mul(initialQty)).mul(100);

  // Partial gross was already credited to the balance at each partial close.
  // Apply only the final portion + the full accumulated fee ledger here, so the
  // lifecycle PnL is never double-counted.
  const newBalance = state.balance.plus(finalGrossPnl).minus(totalFees);
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

  // Structure mitigation: add trigger structure on close (win or loss) if it was
  // not already burned on entry (burn-on-entry parity — avoids duplicates).
  const structureTimestamp = trade.structureTimestamp ?? 0;
  const structureAlreadyMitigated = state.mitigatedStructures.some(
    (ms) => ms.timestamp === structureTimestamp,
  );
  const hasValidStructure =
    structureTimestamp > 0 &&
    trade.structureType &&
    !structureAlreadyMitigated;

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
        qty: initialQty,
        side: trade.side,
        pnl: netPnl,
        grossPnl: totalGrossPnl,
        pnlPercent,
        feesPaid: totalFees,
        scenarioId: trade.scenarioId,
        scenarioName: trade.scenarioName,
        closedBy,
        orderType: trade.orderType ?? "Market",
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
          (config.enableSniperMode ? 1 : timeframeToMinutes(config.ltfTimeframe)) *
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
