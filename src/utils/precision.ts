import { Decimal } from 'decimal.js';

/**
 * Round down to the nearest step (ROUND_DOWN)
 */
export function roundDownToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.isFinite() || step.lte(0)) {
    throw new Error(`Invalid precision step: ${step}`);
  }
  return value.div(step).floor().mul(step);
}

/**
 * Format value for Bybit API with proper precision
 * - qty: rounded DOWN to qtyStep (ROUND_DOWN)
 * - price (entry, sl, tp): rounded to nearest tickSize
 */
export function formatByBybitPrecision(value: Decimal, step: Decimal, roundMode: 'down' | 'nearest' = 'down'): string {
  if (!step.isFinite() || step.lte(0)) {
    throw new Error(`Invalid precision step: ${step}`);
  }
  
  // Calculate the number of decimal places from tickSize
  const stepStr = step.toFixed();
  const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
  
  if (roundMode === 'down') {
    // qty: round DOWN to step (ROUND_DOWN)
    const result = value.div(step).floor().mul(step);
    return result.toFixed(decimalPlaces);
  } else {
    // price: round to NEAREST step (tickSize)
    const divided = value.div(step);
    const rounded = divided.round(); // Decimal.round() uses ROUND_HALF_UP
    const result = rounded.mul(step);
    return result.toFixed(decimalPlaces);
  }
}

export function formatQuantity(qty: Decimal, qtyStep: Decimal): string {
  return formatByBybitPrecision(qty, qtyStep, 'down');
}

export function formatPrice(price: Decimal, tickSize: Decimal): string {
  return formatByBybitPrecision(price, tickSize, 'nearest');
}