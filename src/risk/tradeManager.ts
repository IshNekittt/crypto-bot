import { Decimal } from "decimal.js";
import { TradeManagementState } from "../types";

export interface TradeManagementSignal {
  action: 'none' | 'move_sl_to_entry' | 'close_partial_25' | 'close_partial_50' | 'trail_sl_to_profit';
  reason: string;
  newStopLoss?: string;
  closeQty?: string;
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
}

function getDefaultState(): TradeManagementState {
  return {
    milestone1Triggered: false,
    milestone2Triggered: false,
    initialTotalR: '0',
    initialQty: '0',
  };
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
  const sl = new Decimal(context.stopLoss);
  const tp = new Decimal(context.takeProfit);
  const currentPrice = new Decimal(context.currentPrice);
  const initialQty = new Decimal(state.initialQty || context.initialQty);

  const isLong = context.side === 'Buy';
  
  // Calculate distances using the Decimal variables
  const riskDistance = isLong 
    ? entry.minus(sl).abs() 
    : sl.minus(entry).abs();
  const rewardDistance = isLong 
    ? tp.minus(entry).abs() 
    : entry.minus(tp).abs();
  const priceMovement = isLong 
    ? currentPrice.minus(entry).abs() 
    : entry.minus(currentPrice).abs();

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
    if (!state.milestone1Triggered && clampedProgress.gte(0.66)) {
      return {
        action: 'move_sl_to_entry',
        reason: 'Classic mode: 66% progress reached, moving SL to entry',
        newStopLoss: context.entryPrice,
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
  if (!state.milestone1Triggered && clampedProgress.gte(0.33)) {
    const closeQty = initialQty.mul(0.25).toFixed(8);
    return {
      action: 'close_partial_25',
      reason: 'Sniper mode: 33% progress reached, closing 25% and moving SL to entry',
      closeQty,
      newStopLoss: context.entryPrice,
      updatedState: {
        ...baseUpdatedState,
        milestone1Triggered: true,
      },
    };
  }

  // Milestone 2: 66% progress -> Close another 25%, trail SL to entry + 33% of TP distance
  if (state.milestone1Triggered && !state.milestone2Triggered && clampedProgress.gte(0.66)) {
    const closeQty = initialQty.mul(0.25).toFixed(8);
    
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
      closeQty,
      newStopLoss: newSl.toFixed(8),
      updatedState: {
        ...baseUpdatedState,
        milestone2Triggered: true,
      },
    };
  }

  return { action: 'none', reason: 'Waiting for next milestone', updatedState: baseUpdatedState };
}