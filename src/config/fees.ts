import { Decimal } from 'decimal.js';

/**
 * Canonical Bybit V5 Linear Perpetual fee model.
 *
 * Single source of truth shared by the live strategy engine, the backtester and
 * the Scenario 12 arithmetic gates. Fees are expressed as a FRACTION of notional
 * (0.00055 = 0.055%), never as a percentage, so they compose directly with
 * price-relative quantities such as ATR%.
 */
export const TAKER_FEE_RATE = new Decimal('0.00055');
export const MAKER_FEE_RATE = new Decimal('0.00020');

/** Cost of entering AND exiting as a taker: 0.110%. */
export const ROUND_TRIP_TAKER_FEE = TAKER_FEE_RATE.mul(2);

/** Cost of entering as a maker and exiting as a taker: 0.075%. */
export const ROUND_TRIP_MAKER_ENTRY_FEE = MAKER_FEE_RATE.plus(TAKER_FEE_RATE);

/**
 * Premium paid for crossing the spread instead of resting: 0.035%.
 *
 * This is the only amount a limit order can actually save on the entry leg, so
 * it is the break-even threshold any "take the market now" decision must clear.
 */
export const FEE_DELTA = TAKER_FEE_RATE.minus(MAKER_FEE_RATE);

/**
 * Hybrid-entry routing decision.
 *
 * A favorable discount always removes Limit fill risk: the Discount Trap rule takes
 * Market even when the discount is smaller than the maker/taker entry-fee delta.
 * At-entry and unfavorable movement remain Marketable only within the configured
 * tight execution threshold.
 */
export function shouldUseMarketEntry(
  idealEntry: Decimal,
  currentPrice: Decimal,
  isLong: boolean,
  tightThreshold: Decimal,
): boolean {
  if (idealEntry.lte(0) || tightThreshold.lt(0)) return false;

  const discountPct = isLong
    ? idealEntry.minus(currentPrice).div(idealEntry)
    : currentPrice.minus(idealEntry).div(idealEntry);
  const absoluteDeviationPct = discountPct.negated().abs();
  const withinThreshold = absoluteDeviationPct.lte(tightThreshold);

  if (discountPct.gt(0)) {
    // Discount Trap: never rest a Limit when the market is already beyond ideal
    // entry, otherwise the Limit can fill at an inferior or stale price.
    return true;
  }

  // At-entry/adverse prices: pay for immediacy only inside the tight threshold.
  return withinThreshold;
}
