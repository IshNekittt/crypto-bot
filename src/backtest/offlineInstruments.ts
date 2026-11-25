import { InstrumentInfo } from './executionSimulator';

/**
 * Offline instrument specifications for CSV backtests.
 *
 * Bybit cannot describe `XAUUSD`, `EURUSD` or any other non-listed asset, and
 * CSV mode must never touch the network. These fallbacks are conservative,
 * deterministic and cover the three shapes a CSV run can take:
 *
 *  - precious metals (gold aliases)  → 2-decimal price, 0.01 lot step
 *  - non-JPY FX majors/crosses       → 5-decimal price, 1000-unit step
 *  - anything else                   → 2-decimal price, 0.01 step
 *
 * The values are used only by the execution simulator for formatting and
 * min/max quantity guards; they are not exchange truth and must not be treated
 * as such outside a backtest.
 */

const GOLD_ALIASES = new Set(['XAUUSD', 'GOLD', 'XAU', 'GOLDUSD']);

/**
 * Currency codes whose pairs quote at 5 decimals. JPY is deliberately absent:
 * JPY pairs use 3 decimals and would be mis-specified by the FX branch, so
 * they fall through to the generic fallback (which at least never rejects a
 * valid price on precision).
 */
const FX_CURRENCIES = new Set([
  'USD',
  'EUR',
  'GBP',
  'AUD',
  'NZD',
  'CAD',
  'CHF',
]);

const FALLBACK_TICK_SIZE = '0.01';
const FALLBACK_QTY_STEP = '0.01';
const FALLBACK_MIN_QTY = '0.01';
const FALLBACK_MAX_QTY = '100000';

function isNonJpyFxPair(normalized: string): boolean {
  if (normalized.length !== 6) return false;
  const base = normalized.slice(0, 3);
  const quote = normalized.slice(3);
  return FX_CURRENCIES.has(base) && FX_CURRENCIES.has(quote);
}

/**
 * Resolve an instrument specification without contacting Bybit.
 *
 * `XAUUSD`/`GOLD` always resolve to the canonical `XAUUSD` spec regardless of
 * the alias used in `SYMBOLS`; the CSV file itself is symbol-agnostic.
 */
export function resolveOfflineInstrument(symbol: string): InstrumentInfo {
  const raw = symbol.trim().toUpperCase();
  const normalized = raw.replace(/[^A-Z0-9]/g, '');

  if (GOLD_ALIASES.has(normalized)) {
    return {
      symbol: 'XAUUSD',
      tickSize: '0.01',
      qtyStep: '0.01',
      minOrderQty: '0.01',
      maxOrderQty: '1000',
    };
  }

  if (isNonJpyFxPair(normalized)) {
    return {
      symbol: normalized,
      tickSize: '0.00001',
      qtyStep: '1000',
      minOrderQty: '1000',
      maxOrderQty: '10000000',
    };
  }

  return {
    symbol: raw,
    tickSize: FALLBACK_TICK_SIZE,
    qtyStep: FALLBACK_QTY_STEP,
    minOrderQty: FALLBACK_MIN_QTY,
    maxOrderQty: FALLBACK_MAX_QTY,
  };
}
