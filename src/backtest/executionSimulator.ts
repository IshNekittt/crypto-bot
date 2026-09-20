import { Decimal } from 'decimal.js';
import { Candle } from '../types';
import { logger } from '../utils/logger';

export const TAKER_FEE_RATE = new Decimal('0.00055');
export const INITIAL_BALANCE = new Decimal('1000');
export const BASE_RISK_PERCENT = new Decimal('2');
export const REDUCED_RISK_PERCENT = new Decimal('1');
export const LEVERAGE = new Decimal('10');
export const TAKE_PROFIT_RR = new Decimal('3');
export const DRAWDOWN_GUARD_TRIGGER = 3; // Number of consecutive losses to trigger reduced risk
export const MIN_SL_DISTANCE_PCT = new Decimal('0.001'); // 0.1% minimum SL distance

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
  side: 'Buy' | 'Sell';
  pnl: Decimal;
  pnlPercent: Decimal;
  feesPaid: Decimal;
  scenarioId: number;
  scenarioName: string;
  closedBy: 'TP' | 'SL' | 'BOTH';
}

export interface OpenTrade {
  entryTime: number;
  entryPrice: Decimal;
  slPrice: Decimal;
  tpPrice: Decimal;
  qty: Decimal;
  side: 'Buy' | 'Sell';
  scenarioId: number;
  scenarioName: string;
  entryFee: Decimal;
  // Zone details for mitigation tracking
  zoneType?: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
  zoneTop?: Decimal;
  zoneBottom?: Decimal;
  zoneTimeframe?: string;
  zoneDirection?: string;
  zoneTimestamp?: number;
}

export interface BacktestState {
  balance: Decimal;
  equity: Decimal;
  peakBalance: Decimal;
  maxDrawdown: Decimal;
  trades: TradeResult[];
  consecutiveLosses: number;
  openTrade: OpenTrade | null;
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
  riskPercent: Decimal
): Decimal {
  const tickSize = new Decimal(instrument.tickSize);
  const qtyStep = new Decimal(instrument.qtyStep);
  const minOrderQty = new Decimal(instrument.minOrderQty);

  const entry = roundDownToStep(entryPrice, tickSize);
  const stopLoss = roundDownToStep(slPrice, tickSize);

  const slDistance = entry.minus(stopLoss).abs();
  if (slDistance.lte(0)) {
    return new Decimal('0');
  }

  // FIX: Correct risk math - qty = (balance * riskPercent / 100) / |entry - sl|
  const riskAmount = balance.mul(riskPercent.div(100));
  const rawQty = riskAmount.div(slDistance);
  const qty = roundDownToStep(rawQty, qtyStep);

  if (qty.lt(minOrderQty)) {
    return new Decimal('0');
  }

  return qty;
}

export function getInitialState(): BacktestState {
  return {
    balance: INITIAL_BALANCE,
    equity: INITIAL_BALANCE,
    peakBalance: INITIAL_BALANCE,
    maxDrawdown: new Decimal('0'),
    trades: [],
    consecutiveLosses: 0,
    openTrade: null,
  };
}

/**
 * Get effective risk percent based on consecutive losses
 * Drawdown Guard: reduces risk to 1% after 3 consecutive losses
 */
export function getEffectiveRiskPercent(consecutiveLosses: number): Decimal {
  const riskPercent = consecutiveLosses >= DRAWDOWN_GUARD_TRIGGER 
    ? REDUCED_RISK_PERCENT 
    : BASE_RISK_PERCENT;
  
  if (consecutiveLosses >= DRAWDOWN_GUARD_TRIGGER) {
    logger.debug(`[Drawdown Guard] Active: ${consecutiveLosses} consecutive losses -> risk reduced to ${riskPercent.toString()}%`);
  }
  
  return riskPercent;
}

export function openTrade(
  state: BacktestState,
  candle: Candle,
  entryPrice: Decimal,
  slPrice: Decimal,
  tpPrice: Decimal,
  side: 'Buy' | 'Sell',
  scenarioId: number,
  scenarioName: string,
  instrument: InstrumentInfo,
  zoneDetails?: {
    type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
    top: Decimal;
    bottom: Decimal;
    timeframe: string;
    direction: string;
    timestamp: number;
  }
): { state: BacktestState; tradeOpened: boolean } {
  let slPriceAdjusted = slPrice;
  const slDistance = entryPrice.minus(slPrice).abs();

  // Fix 1: Minimum SL distance - 0.1% minimum to prevent micro-stops
  const minSlDistance = entryPrice.mul(MIN_SL_DISTANCE_PCT);
  if (slDistance.lt(minSlDistance)) {
    // Force SL to 0.1% distance
    if (side === 'Buy') {
      slPriceAdjusted = entryPrice.minus(minSlDistance);
    } else {
      slPriceAdjusted = entryPrice.plus(minSlDistance);
    }
    logger.debug(`SL adjusted to minimum 0.1% distance: ${slPriceAdjusted.toFixed(4)}`);
  }

  const slDistanceAdjusted = entryPrice.minus(slPriceAdjusted).abs();
  
  // ASSERT: SL must be on correct side of entry
  // Buy (Long): SL must be BELOW entry
  // Sell (Short): SL must be ABOVE entry
  if (side === 'Buy') {
    if (slPriceAdjusted.gte(entryPrice)) {
      logger.error(`ASSERT FAILED: Buy trade has SL (${slPriceAdjusted.toFixed(4)}) >= entry (${entryPrice.toFixed(4)})`);
      throw new Error(`Invalid SL for Buy: SL=${slPriceAdjusted.toFixed(4)} >= Entry=${entryPrice.toFixed(4)}`);
    }
  } else {
    if (slPriceAdjusted.lte(entryPrice)) {
      logger.error(`ASSERT FAILED: Sell trade has SL (${slPriceAdjusted.toFixed(4)}) <= entry (${entryPrice.toFixed(4)})`);
      throw new Error(`Invalid SL for Sell: SL=${slPriceAdjusted.toFixed(4)} <= Entry=${entryPrice.toFixed(4)}`);
    }
  }
  
  if (slDistanceAdjusted.lte(0)) {
    return { state, tradeOpened: false };
  }

  // Check if already in a trade
  if (state.openTrade) {
    return { state, tradeOpened: false };
  }

  const riskPercent = getEffectiveRiskPercent(state.consecutiveLosses);
  let qty = calculatePositionSize(state.balance, entryPrice, slPriceAdjusted, instrument, riskPercent);

  if (qty.lte(0)) {
    return { state, tradeOpened: false };
  }

  // Fix 2: Margin check - position value cannot exceed balance * LEVERAGE
  const maxPositionValue = state.balance.mul(LEVERAGE);
  const positionValue = qty.mul(entryPrice);
  if (positionValue.gt(maxPositionValue)) {
    // Reduce qty to fit within margin
    const maxQty = maxPositionValue.div(entryPrice);
    // Round down to qtyStep
    const qtyStep = new Decimal(instrument.qtyStep);
    qty = maxQty.div(qtyStep).floor().mul(qtyStep);
    logger.debug(`Qty reduced for margin: ${qty.toFixed(6)} (max position value: ${maxPositionValue.toFixed(2)})`);
  }

  if (qty.lte(0)) {
    return { state, tradeOpened: false };
  }

  const entryFee = entryPrice.mul(qty).mul(TAKER_FEE_RATE);

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
  };

  const newBalance = state.balance.minus(entryFee); // Deduct entry fee immediately
  const newPeak = newBalance.gt(state.peakBalance) ? newBalance : state.peakBalance;
  const drawdown = newPeak.minus(newBalance).div(newPeak).mul(100);

  const newState: BacktestState = {
    ...state,
    balance: newBalance,
    equity: newBalance,
    peakBalance: newPeak,
    maxDrawdown: drawdown.gt(state.maxDrawdown) ? drawdown : state.maxDrawdown,
    openTrade,
  };

  logger.debug(`Backtest OPEN: ${scenarioName} ${side} entry=${entryPrice.toFixed(4)} SL=${slPriceAdjusted.toFixed(4)} TP=${tpPrice.toFixed(4)} qty=${qty.toFixed(6)} balance=${newBalance.toFixed(2)}`);

  // Debug: Log first 3 trades opening
  if (debugTradeOpenCount < 3) {
    debugTradeOpenCount++;
    logger.warn(`[TRADE OPEN #${debugTradeOpenCount}] Symbol: UNKNOWN | Side: ${side} | Entry: ${entryPrice.toFixed(4)} | SL: ${slPriceAdjusted.toFixed(4)} | TP: ${tpPrice.toFixed(4)} | Candle: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`);
  }

  return { state: newState, tradeOpened: true };
}

export function checkAndCloseTrade(
  state: BacktestState,
  candle: Candle
): { state: BacktestState; tradeResult: TradeResult | null; mitigatedZone?: { type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION'; top: string; bottom: string; timeframe: string; direction: string; timestamp: number } } {
  if (!state.openTrade) {
    return { state, tradeResult: null };
  }

  const trade = state.openTrade;
  
  // Skip closing on the same candle the trade was opened
  if (candle.timestamp <= trade.entryTime) {
    return { state, tradeResult: null };
  }
  const isLong = trade.side === 'Buy';
  const high = new Decimal(candle.high);
  const low = new Decimal(candle.low);

  const hitTP = isLong ? high.gte(trade.tpPrice) : low.lte(trade.tpPrice);
  const hitSL = isLong ? low.lte(trade.slPrice) : high.gte(trade.slPrice);

  // FIX 4: Conservative execution - if BOTH TP and SL hit in same candle (wick), count as LOSS
  if (hitTP && hitSL) {
    // Both hit in same candle - treat as loss (conservative)
    const exitPrice = trade.slPrice; // Exit at SL price
    
    const exitFee = exitPrice.mul(trade.qty).mul(TAKER_FEE_RATE);
    const totalFees = trade.entryFee.plus(exitFee);

    const priceDiff = isLong ? exitPrice.minus(trade.entryPrice) : trade.entryPrice.minus(exitPrice);
    const grossPnl = priceDiff.mul(trade.qty);
    const netPnl = grossPnl.minus(totalFees);
    const pnlPercent = netPnl.div(trade.entryPrice.mul(trade.qty)).mul(100);

    const newBalance = state.balance.plus(netPnl);
    const newPeak = newBalance.gt(state.peakBalance) ? newBalance : state.peakBalance;
    const drawdown = newPeak.minus(newBalance).div(newPeak).mul(100);

    const tradeResult: TradeResult = {
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
      closedBy: 'BOTH',
    };

    // Prepare mitigated zone info if available
    let mitigatedZone: { type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION'; top: string; bottom: string; timeframe: string; direction: string; timestamp: number } | undefined;
    if (trade.zoneType && trade.zoneTop && trade.zoneBottom && trade.zoneTimeframe && trade.zoneDirection && trade.zoneTimestamp) {
      mitigatedZone = {
        type: trade.zoneType,
        top: trade.zoneTop.toString(),
        bottom: trade.zoneBottom.toString(),
        timeframe: trade.zoneTimeframe,
        direction: trade.zoneDirection,
        timestamp: trade.zoneTimestamp,
      };
    }

    const newState: BacktestState = {
      ...state,
      balance: newBalance,
      equity: newBalance,
      peakBalance: newPeak,
      maxDrawdown: drawdown.gt(state.maxDrawdown) ? drawdown : state.maxDrawdown,
      trades: [...state.trades, tradeResult],
      consecutiveLosses: netPnl.lt(0) ? state.consecutiveLosses + 1 : 0,
      openTrade: null,
    };

    logger.debug(`Backtest CLOSE (BOTH): ${trade.scenarioName} ${trade.side} entry=${trade.entryPrice.toFixed(4)} exit=${exitPrice.toFixed(4)} pnl=${netPnl.toFixed(2)} (BOTH) balance=${newBalance.toFixed(2)}`);

    return { state: newState, tradeResult, mitigatedZone };
  }

  if (!hitTP && !hitSL) {
    return { state, tradeResult: null };
  }

  let exitPrice: Decimal;
  let closedBy: 'TP' | 'SL';

  if (hitTP) {
    exitPrice = trade.tpPrice;
    closedBy = 'TP';
  } else {
    exitPrice = trade.slPrice;
    closedBy = 'SL';
  }

  // Debug: Log first 3 trades closing
  if (debugTradeCloseCount < 3) {
    debugTradeCloseCount++;
    const reason = hitTP ? 'TP hit' : 'SL hit';
    logger.warn(`[TRADE CLOSE #${debugTradeCloseCount}] Exit Price: ${exitPrice.toFixed(4)} | Reason: ${reason} (Hit ${closedBy} on candle H=${candle.high} L=${candle.low})`);
  }

  const exitFee = exitPrice.mul(trade.qty).mul(TAKER_FEE_RATE);
  const totalFees = trade.entryFee.plus(exitFee);

  const priceDiff = isLong ? exitPrice.minus(trade.entryPrice) : trade.entryPrice.minus(exitPrice);
  const grossPnl = priceDiff.mul(trade.qty);
  const netPnl = grossPnl.minus(totalFees);
  const pnlPercent = netPnl.div(trade.entryPrice.mul(trade.qty)).mul(100);

  const newBalance = state.balance.plus(netPnl);
  const newPeak = newBalance.gt(state.peakBalance) ? newBalance : state.peakBalance;
  const drawdown = newPeak.minus(newBalance).div(newPeak).mul(100);

const tradeResult: TradeResult = {
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
      closedBy: 'BOTH',
    };

  // Prepare mitigated zone info if available
  let mitigatedZone: { type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION'; top: string; bottom: string; timeframe: string; direction: string; timestamp: number } | undefined;
  if (trade.zoneType && trade.zoneTop && trade.zoneBottom && trade.zoneTimeframe && trade.zoneDirection && trade.zoneTimestamp) {
    mitigatedZone = {
      type: trade.zoneType,
      top: trade.zoneTop.toString(),
      bottom: trade.zoneBottom.toString(),
      timeframe: trade.zoneTimeframe,
      direction: trade.zoneDirection,
      timestamp: trade.zoneTimestamp,
    };
  }

  const newState: BacktestState = {
    ...state,
    balance: newBalance,
    equity: newBalance,
    peakBalance: newPeak,
    maxDrawdown: drawdown.gt(state.maxDrawdown) ? drawdown : state.maxDrawdown,
    trades: [...state.trades, tradeResult],
    consecutiveLosses: netPnl.lt(0) ? state.consecutiveLosses + 1 : 0,
    openTrade: null,
  };

  logger.debug(`Backtest CLOSE: ${trade.scenarioName} ${trade.side} entry=${trade.entryPrice.toFixed(4)} exit=${exitPrice.toFixed(4)} pnl=${netPnl.toFixed(2)} (${closedBy}) balance=${newBalance.toFixed(2)}`);

  return { state: newState, tradeResult, mitigatedZone };
}