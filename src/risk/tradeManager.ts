import { Decimal } from "decimal.js";
import { TradeManagementState } from "../types";
import { InstrumentInfo } from "../types";
import { formatPrice, formatQuantity } from "../utils/precision";

export interface TradeManagementSignal {
  action: 'none' | 'move_sl_to_entry' | 'close_partial_25' | 'close_partial_50' | 'trail_sl_to_profit';
  reason: string;
  newStopLoss?: string;
  closeQty?: string;
  /**
   * Milestone threshold price: entry + (tp - entry) * progress. The only honest
   * fill anchor for a partial close — never the candle extreme. The simulator
   * may fill at the candle open instead when price gapped past the threshold.
   */
  triggerPrice?: string;
  updatedState: TradeManagementState;
}

export interface TradeContext {
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  currentPrice: string;
  side: 'Buy' | 'Sell';
  initialQty: string;
  managementState: TradeManagementState;
  instrument: InstrumentInfo;
  /**
   * ORIGINAL protective stop, before any Adaptive Fractioning update.
   * Risk distance is always measured from here. Defaults to `stopLoss` for
   * callers that never rewrite their stop (live reads trades.sl_price, which is
   * immutable).
   */
  initialStopLoss?: string;
}

function getDefaultState(): TradeManagementState {
  return {
    milestone1Triggered: false,
    milestone2Triggered: false,
    initialTotalR: '0',
    initialQty: '0',
  };
}

// Milestone progress thresholds — single source of truth for both the comparison
// and the exact trigger price handed to the execution simulator.
const MILESTONE_1_PROGRESS = new Decimal('0.33');
const MILESTONE_2_PROGRESS = new Decimal('0.66');

/**
 * Exact price at which `progress` (0..1) toward TP is reached.
 * Long: entry + (tp - entry) * progress. Valid for shorts too, because tp < entry
 * makes the same expression produce a falling price.
 */
function priceAtProgress(entry: Decimal, tp: Decimal, progress: Decimal): Decimal {
  return entry.plus(tp.minus(entry).mul(progress));
}

export function initializeTradeManagement(
  entryPrice: string,
  stopLoss: string,
  takeProfit: string,
  initialQty: string
): TradeManagementState {
  const entry = new Decimal(entryPrice);
  const sl = new Decimal(stopLoss);
  const tp = new Decimal(takeProfit);

  const isLong = tp.gt(entry);
  const riskDistance = isLong ? entry.minus(sl).abs() : sl.minus(entry).abs();
  const rewardDistance = isLong ? tp.minus(entry).abs() : entry.minus(tp).abs();

  if (riskDistance.lte(0)) {
    return getDefaultState();
  }

  const totalR = rewardDistance.div(riskDistance);

  return {
    milestone1Triggered: false,
    milestone2Triggered: false,
    initialTotalR: totalR.toFixed(8),
    initialQty: initialQty,
  };
}

export function evaluateTradeManagement(context: TradeContext): TradeManagementSignal {
  const state = context.managementState || getDefaultState();
  const entry = new Decimal(context.entryPrice);
  const tp = new Decimal(context.takeProfit);
  const currentPrice = new Decimal(context.currentPrice);
  const initialQty = new Decimal(state.initialQty || context.initialQty);
  const tickSize = new Decimal(context.instrument.tickSize);

  // Risk distance MUST be measured from the ORIGINAL stop, never the live
  // (trailing) stop. Once a milestone moves the stop to entry, |entry - sl|
  // collapses to 0 and every later milestone becomes permanently unreachable
  // ("Invalid risk/reward distances"). Live only hides this because
  // trades.sl_price in the DB is never rewritten, so that is what it reads back.
  const initialSl = new Decimal(context.initialStopLoss ?? context.stopLoss);

  const isLong = context.side === 'Buy';

  // CRITICAL: Never manage a trade that is moving against us.
  // Progress toward TP must be measured ONLY when price has moved in the
  // profitable direction from entry. Measuring an absolute distance would
  // treat an adverse move (toward/through SL) as progress toward TP, which
  // attempts to move the stop to entry while price is on the wrong side and
  // causes Bybit error [10001] (StopLoss should be lower/higher than base_price).
  const isProfitable = isLong
    ? currentPrice.gt(entry)
    : currentPrice.lt(entry);

  if (!isProfitable) {
    return {
      action: 'none',
      reason: 'Trade is not in profit',
      updatedState: state,
    };
  }

  // Calculate distances using the Decimal variables
  const riskDistance = isLong
    ? entry.minus(initialSl).abs()
    : initialSl.minus(entry).abs();
  const rewardDistance = isLong 
    ? tp.minus(entry).abs() 
    : entry.minus(tp).abs();

  // Directional movement (NOT absolute): the isProfitable guard above
  // guarantees this value is strictly positive for both sides.
  const priceMovement = isLong
    ? currentPrice.minus(entry)
    : entry.minus(currentPrice);

  // Safety check
  if (rewardDistance.lte(0) || riskDistance.lte(0)) {
    return {
      action: 'none',
      reason: 'Invalid risk/reward distances',
      updatedState: state,
    };
  }

  // Calculate progress: how far price has moved toward TP (0 to 1.0)
  const progress = priceMovement.div(rewardDistance);
  
  // Clamp progress between 0 and 1
const clampedProgress = Decimal.min(Decimal.max(progress, new Decimal(0)), new Decimal(1));
  
  const initialTotalRDecimal = new Decimal(state.initialTotalR || '0');
  
  // Create base updated state
  const baseUpdatedState: TradeManagementState = {
    ...state,
    initialTotalR: state.initialTotalR || '0',
    initialQty: state.initialQty || context.initialQty,
  };

  // For TotalR < 4 (Classic): Only move SL to entry at 66% progress
  if (!initialTotalRDecimal.gte(4)) {
    // Check milestone 1 (66%): Move SL to entry
    if (!state.milestone1Triggered && clampedProgress.gte(MILESTONE_2_PROGRESS)) {
      return {
        action: 'move_sl_to_entry',
        reason: 'Classic mode: 66% progress reached, moving SL to entry',
        newStopLoss: formatPrice(entry, tickSize),
        updatedState: {
          ...baseUpdatedState,
          milestone1Triggered: true,
        },
      };
    }
    return { action: 'none', reason: 'Waiting for 66% progress', updatedState: baseUpdatedState };
  }

  // For TotalR >= 4 (Sniper): More aggressive management
  // Milestone 1: 33% progress -> Close 25%, move SL to entry
  if (!state.milestone1Triggered && clampedProgress.gte(MILESTONE_1_PROGRESS)) {
    const rawCloseQty = initialQty.mul(0.25);
    const formattedCloseQty = formatQuantity(rawCloseQty, new Decimal(context.instrument.qtyStep));
    const minOrderQty = new Decimal(context.instrument.minOrderQty);
    const finalCloseQty = new Decimal(formattedCloseQty).lt(minOrderQty) 
      ? minOrderQty.toFixed(8) 
      : formattedCloseQty;
    
    return {
      action: 'close_partial_25',
      reason: 'Sniper mode: 33% progress reached, closing 25% and moving SL to entry',
      closeQty: finalCloseQty,
      newStopLoss: formatPrice(entry, tickSize),
      triggerPrice: formatPrice(
        priceAtProgress(entry, tp, MILESTONE_1_PROGRESS),
        tickSize,
      ),
      updatedState: {
        ...baseUpdatedState,
        milestone1Triggered: true,
      },
    };
  }

  // Milestone 2: 66% progress -> Close another 25%, trail SL to entry + 33% of TP distance
  if (state.milestone1Triggered && !state.milestone2Triggered && clampedProgress.gte(MILESTONE_2_PROGRESS)) {
    const rawCloseQty = initialQty.mul(0.25);
    const formattedCloseQty = formatQuantity(rawCloseQty, new Decimal(context.instrument.qtyStep));
    const minOrderQty = new Decimal(context.instrument.minOrderQty);
    const finalCloseQty = new Decimal(formattedCloseQty).lt(minOrderQty) 
      ? minOrderQty.toFixed(8) 
      : formattedCloseQty;
    
    // Calculate new SL: entry + 33% of TP distance
    const tpDistance = isLong 
      ? tp.minus(entry)
      : entry.minus(tp);
    const trailOffset = tpDistance.mul(0.33);
    const newSl = isLong 
      ? entry.plus(trailOffset) 
      : entry.minus(trailOffset);

    return {
      action: 'close_partial_50',
      reason: 'Sniper mode: 66% progress reached, closing another 25% and trailing SL to profit',
      closeQty: finalCloseQty,
      newStopLoss: formatPrice(newSl, tickSize),
      triggerPrice: formatPrice(
        priceAtProgress(entry, tp, MILESTONE_2_PROGRESS),
        tickSize,
      ),
      updatedState: {
        ...baseUpdatedState,
        milestone2Triggered: true,
      },
    };
  }

  return { action: 'none', reason: 'Waiting for next milestone', updatedState: baseUpdatedState };
}