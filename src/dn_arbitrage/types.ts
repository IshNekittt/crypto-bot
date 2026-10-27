import { Decimal } from 'decimal.js';

/**
 * Delta-neutral funding backtester — shared domain types.
 *
 * This module is deliberately isolated from the SMC engine: it imports neither
 * `src/config/env.ts` nor any engine/scenario code. The only shared utilities
 * are the logger and (later, for live execution) the Bybit client wrappers.
 */

/** A single realized funding settlement. `timestamp` is milliseconds UTC. */
export interface FundingEvent {
  readonly timestamp: number;
  readonly rate: Decimal;
}

/**
 * Cache file shape for `data/dn_cache/funding/<SYMBOL>.json`.
 *
 * Decimal values are serialized as strings, matching the repository-wide rule
 * that money/rates are never stored as JS numbers.
 */
export interface FundingCacheFile {
  readonly symbol: string;
  readonly fetchedAt: number;
  readonly intervalHours: number;
  readonly events: ReadonlyArray<{
    readonly timestamp: number;
    readonly rate: string;
  }>;
}

/** Normalized funding history returned by the fetcher. */
export interface FundingHistory {
  readonly symbol: string;
  readonly events: ReadonlyArray<FundingEvent>;
  readonly intervalHours: number;
  readonly dataGaps: number;
  readonly fetchedAt: number;
  readonly source: FundingHistorySource;
}

export type FundingHistorySource =
  | 'cache'
  | 'network'
  | 'cache+network'
  | 'cache-fallback';

export type FundingExitReason =
  | 'MA_BELOW_EXIT'
  | 'NEGATIVE_STREAK'
  | 'TIME_LOCK_NEGATIVE'
  | 'MAX_HOLDING'
  | 'END_OF_DATA';

/**
 * One completed round trip: spot long + perp short, opened and closed.
 *
 * Return fields are fractions of the entry spot notional N0, except
 * `netEquityReturn`, which is the return on allocated equity after the
 * `E_alloc = N0 × (1 + (P0/S0)/L + β)` conversion from architecture §8.6.
 */
export interface FundingTrade {
  readonly symbol: string;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryMa: Decimal;
  readonly exitMa: Decimal | null;
  readonly kMin: number;
  readonly epochsHeld: number;
  readonly holdHours: Decimal;
  readonly fundingReturn: Decimal;
  readonly basisReturn: Decimal;
  readonly feeReturn: Decimal;
  readonly slippageReturn: Decimal;
  readonly netNotionalReturn: Decimal;
  readonly netEquityReturn: Decimal;
  readonly fundingPnlUsdt: Decimal;
  readonly basisPnlUsdt: Decimal;
  readonly feesUsdt: Decimal;
  readonly slippageUsdt: Decimal;
  readonly netPnlUsdt: Decimal;
  readonly equityBefore: Decimal;
  readonly equityAfter: Decimal;
  readonly exitReason: FundingExitReason;
}

/** Per-symbol simulation output. All yields are fractions, not percentages. */
export interface SymbolMetrics {
  readonly symbol: string;
  readonly eventCount: number;
  readonly intervalHours: number;
  readonly dataGaps: number;
  readonly firstTimestamp: number;
  readonly lastTimestamp: number;
  readonly windowDays: Decimal;
  readonly trades: ReadonlyArray<FundingTrade>;
  readonly tradeCount: number;
  readonly startEquity: Decimal;
  readonly endEquity: Decimal;
  readonly totalYield: Decimal;
  readonly netApy: Decimal;
  readonly netPnlUsdt: Decimal;
  readonly grossFundingUsdt: Decimal;
  readonly grossBasisUsdt: Decimal;
  readonly grossFeesUsdt: Decimal;
  readonly grossSlippageUsdt: Decimal;
  readonly avgHoldHours: Decimal | null;
  readonly avgHoldEpochs: Decimal | null;
  readonly fundingToFeeRatio: Decimal | null;
}

/** CLI-level aggregate across the basket. */
export interface BasketMetrics {
  readonly results: ReadonlyArray<SymbolMetrics>;
  readonly failures: ReadonlyArray<{ readonly symbol: string; readonly error: string }>;
  readonly startEquity: Decimal;
  readonly endEquity: Decimal;
  readonly totalYield: Decimal;
  readonly netApy: Decimal;
  readonly netPnlUsdt: Decimal;
  readonly tradeCount: number;
  readonly avgHoldHours: Decimal | null;
  readonly grossFundingUsdt: Decimal;
  readonly grossFeesUsdt: Decimal;
  readonly fundingToFeeRatio: Decimal | null;
  readonly firstTimestamp: number;
  readonly lastTimestamp: number;
  readonly windowDays: Decimal;
}
