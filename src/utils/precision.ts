import { Decimal } from 'decimal.js';

export function roundDownToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.isFinite() || step.lte(0)) {
    throw new Error(`Invalid precision step: ${step}`);
  }
  return value.div(step).floor().mul(step);
}

export function formatQuantity(qty: Decimal, qtyStep: Decimal): string {
  return roundDownToStep(qty, qtyStep).toFixed();
}

export function formatPrice(price: Decimal, tickSize: Decimal): string {
  return roundDownToStep(price, tickSize).toFixed();
}
