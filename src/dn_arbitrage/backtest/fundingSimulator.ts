import { Decimal } from 'decimal.js';
import {
  DN_DAY_MS,
  DN_HOUR_MS,
  DnConfig,
  basisReturnFraction,
  computeKMin,
  equityDenominator,
  feeReturnFraction,
  roundTripSlippageFraction,
} from '../config';
import {
  BasketMetrics,
  FundingEvent,
  FundingExitReason,
  FundingTrade,
  SymbolMetrics,
} from '../types';

/**
 * Pure funding-only simulator (architecture §8 + §9.3).
 *
 * Model:
 * - Signal: `f_ma(N)` of the N funding epochs strictly BEFORE the current
 *   timestamp (causality rule §9.4.3).
 * - Entry: at a funding timestamp `t` when `f_ma > entryThreshold`. The
 *   position does NOT accrue funding at `t` (`entry_time < f.time` is strict).
 * - Accrual: each later funding timestamp credits `rate × (mark/S0)`, with the
 *   funding-only approximation `mark ≈ S0`.
 * - Exit: MA below the exit threshold for N consecutive evaluations, a
 *   negative streak (risk override), time-lock expiry with a negative current
 *   rate, or the hard max-holding limit.
 * - Returns: `r_net_notional = r_basis + r_funding − r_fees − r_slip`, then
 *   `r_net_equity = r_net_notional / (1 + (P0/S0)/L + β)` (§8.6).
 *
 * No OHLC, no liquidation, no portfolio allocator. Each symbol compounds its
 * own equity sequentially; capital is idle between trades.
 */

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

interface OpenPosition {
  readonly entryTime: number;
  readonly entryMa: Decimal;
  readonly kMin: number;
  readonly equityBefore: Decimal;
  fundingReturn: Decimal;
  epochsHeld: number;
}

export interface FundingSimulationInput {
  readonly symbol: string;
  readonly events: readonly FundingEvent[];
  readonly intervalHours: number;
  readonly config: DnConfig;
  /**
   * Gap count measured by the fetcher over the same window. The simulator
   * cannot infer it without re-deriving the exchange interval, so it is passed
   * through rather than recomputed.
   */
  readonly dataGaps?: number;
}

function normalizeEvents(events: readonly FundingEvent[]): FundingEvent[] {
  const byTimestamp = new Map<number, Decimal>();
  for (const event of events) {
    if (!Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
    byTimestamp.set(event.timestamp, event.rate);
  }
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rate]) => ({ timestamp, rate }));
}

/** Mean of `events[endExclusive - count .. endExclusive - 1]`, or null. */
export function fundingMovingAverage(
  events: readonly FundingEvent[],
  endExclusive: number,
  count: number,
): Decimal | null {
  if (count <= 0 || endExclusive < count) return null;
  let sum = ZERO;
  for (let i = endExclusive - count; i < endExclusive; i++) {
    sum = sum.plus(events[i].rate);
  }
  return sum.div(count);
}

/** True when the last `count` events ending at `endInclusive` are all negative. */
export function hasNegativeFundingStreak(
  events: readonly FundingEvent[],
  endInclusive: number,
  count: number,
): boolean {
  if (count <= 0 || endInclusive + 1 < count) return false;
  for (let i = endInclusive - count + 1; i <= endInclusive; i++) {
    if (!events[i].rate.lt(0)) return false;
  }
  return true;
}

/**
 * APY from a total holding-period return and a window in days:
 * `(1 + r)^(365/days) − 1`. Returns 0 for a zero-length window and -100% if
 * the equity was wiped out.
 */
export function annualizeApy(totalYield: Decimal, windowDays: Decimal): Decimal {
  if (!windowDays.gt(0)) return ZERO;
  const growth = ONE.plus(totalYield);
  if (growth.lte(0)) return new Decimal(-1);
  return growth.pow(new Decimal(365).div(windowDays)).minus(1);
}

function sumDecimal(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, value) => acc.plus(value), ZERO);
}

/**
 * §7.2 negative-streak economics: compare the round-trip cost of exiting now
 * with non-negative funding expected over the remaining k_min epochs.
 */
function negativeStreakJustifiesExit(
  position: OpenPosition,
  maNext: Decimal | null,
  config: DnConfig,
  feeReturn: Decimal,
  slippageReturn: Decimal,
  basisReturn: Decimal,
): boolean {
  const exitCost = feeReturn
    .plus(slippageReturn)
    .plus(Decimal.max(ZERO, basisReturn.negated()));
  const remainingEpochs = Math.max(0, position.kMin - position.epochsHeld);
  const holdExpected = Decimal.max(ZERO, (maNext ?? ZERO).mul(remainingEpochs));
  return exitCost.gt(holdExpected.plus(config.exitLossTolerance));
}

/** Accrued carry/basis loss, excluding sunk round-trip fees. */
function economicLossExceeded(position: OpenPosition, config: DnConfig, basisReturn: Decimal): boolean {
  return position.fundingReturn.plus(basisReturn).lt(config.exitLossTolerance);
}

function emptyMetrics(
  symbol: string,
  intervalHours: number,
  dataGaps: number,
  config: DnConfig,
): SymbolMetrics {
  return {
    symbol,
    eventCount: 0,
    intervalHours,
    dataGaps,
    firstTimestamp: 0,
    lastTimestamp: 0,
    windowDays: ZERO,
    trades: [],
    tradeCount: 0,
    startEquity: config.initialEquity,
    endEquity: config.initialEquity,
    totalYield: ZERO,
    netApy: ZERO,
    netPnlUsdt: ZERO,
    grossFundingUsdt: ZERO,
    grossBasisUsdt: ZERO,
    grossFeesUsdt: ZERO,
    grossSlippageUsdt: ZERO,
    avgHoldHours: null,
    avgHoldEpochs: null,
    fundingToFeeRatio: null,
  };
}

export function runFundingSimulation(input: FundingSimulationInput): SymbolMetrics {
  const { symbol, config, intervalHours } = input;
  const dataGaps = input.dataGaps ?? 0;
  const events = normalizeEvents(input.events);
  if (events.length === 0) {
    return emptyMetrics(symbol, intervalHours, dataGaps, config);
  }

  const startEquity = config.initialEquity;
  let equity = startEquity;
  let open: OpenPosition | null = null;
  let belowExitStreak = 0;
  let cooldownUntilIndex = 0;
  const trades: FundingTrade[] = [];

  const feeReturn = feeReturnFraction(config);
  const basisReturn = basisReturnFraction(config);
  const slippageReturn = roundTripSlippageFraction(config);
  const denominator = equityDenominator(config);

  const closePosition = (
    position: OpenPosition,
    exitIndex: number,
    exitMa: Decimal | null,
    exitReason: FundingExitReason,
  ): void => {
    const exitEvent = events[exitIndex];
    const netNotionalReturn = position.fundingReturn
      .plus(basisReturn)
      .minus(feeReturn)
      .minus(slippageReturn);
    const netEquityReturn = netNotionalReturn.div(denominator);

    const fundingPnlUsdt = position.equityBefore.mul(position.fundingReturn).div(denominator);
    const basisPnlUsdt = position.equityBefore.mul(basisReturn).div(denominator);
    const feesUsdt = position.equityBefore.mul(feeReturn).div(denominator);
    const slippageUsdt = position.equityBefore.mul(slippageReturn).div(denominator);
    const netPnlUsdt = position.equityBefore.mul(netEquityReturn);

    const rawEquityAfter = position.equityBefore.plus(netPnlUsdt);
    // Funding-only returns cannot realistically reach -100%, but a pathological
    // negative-rate series must not produce a negative equity that poisons the
    // next compounding step.
    const equityAfter = rawEquityAfter.gt(0) ? rawEquityAfter : ZERO;
    const holdMs = exitEvent.timestamp - position.entryTime;

    trades.push({
      symbol,
      entryTime: position.entryTime,
      exitTime: exitEvent.timestamp,
      entryMa: position.entryMa,
      exitMa,
      kMin: position.kMin,
      epochsHeld: position.epochsHeld,
      holdHours: new Decimal(holdMs).div(DN_HOUR_MS),
      fundingReturn: position.fundingReturn,
      basisReturn,
      feeReturn,
      slippageReturn,
      netNotionalReturn,
      netEquityReturn,
      fundingPnlUsdt,
      basisPnlUsdt,
      feesUsdt,
      slippageUsdt,
      netPnlUsdt,
      equityBefore: position.equityBefore,
      equityAfter,
      exitReason,
    });

    equity = equityAfter;
    cooldownUntilIndex = exitIndex + config.cooldownEpochs;
    belowExitStreak = 0;
    open = null;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (open) {
      // Accrue the current settlement first: the position was open through it.
      open.fundingReturn = open.fundingReturn.plus(event.rate);
      open.epochsHeld += 1;

      // Signal evaluation is strictly causal: the MA excludes event `i`.
      const maBefore = fundingMovingAverage(events, i, config.maEpochs);
      if (maBefore !== null && maBefore.lt(config.exitThreshold)) {
        belowExitStreak += 1;
      } else {
        belowExitStreak = 0;
      }

      const holdMs = event.timestamp - open.entryTime;
      const timeLockExpired =
        open.epochsHeld >= open.kMin &&
        holdMs >= config.minHoldingHours * DN_HOUR_MS;
      const holdingDays = new Decimal(holdMs).div(DN_DAY_MS);

      const timeLockBypassedByLoss = economicLossExceeded(open, config, basisReturn);
      const negativeStreak = hasNegativeFundingStreak(events, i, config.negativeStreakEpochs);
      const negativeStreakEconomicallyJustified =
        negativeStreak &&
        negativeStreakJustifiesExit(open, maBefore, config, feeReturn, slippageReturn, basisReturn);

      let exitReason: FundingExitReason | null = null;
      if (holdingDays.gte(config.maxHoldingDays)) {
        // Hard exposure ceiling. Unconditional — it must also bound a position
        // whose k_min equals DN_MAX_HOLDING_DAYS.
        exitReason = 'MAX_HOLDING';
      } else if (negativeStreakEconomicallyJustified && (timeLockExpired || timeLockBypassedByLoss)) {
        // Negative funding is an economic exit, not an unconditional risk
        // override. Before k_min it needs both §7.2's cost/recovery test and an
        // accrued carry/basis loss beyond DN_EXIT_LOSS_TOLERANCE.
        exitReason = 'NEGATIVE_STREAK';
      } else if (
        belowExitStreak >= config.exitConsecutiveEpochs &&
        (timeLockExpired || timeLockBypassedByLoss)
      ) {
        // MA decay respects both the epoch and wall-clock lock. It can bypass
        // them only when accrued carry/basis losses exceed the configured
        // tolerance; sunk entry fees alone must not trigger fee-churn exits.
        exitReason = 'MA_BELOW_EXIT';
      } else if (timeLockExpired && event.rate.lt(0)) {
        exitReason = 'TIME_LOCK_NEGATIVE';
      }

      if (exitReason !== null) {
        closePosition(open, i, maBefore, exitReason);
        // Do not re-enter on the same settlement; cooldown starts at this index.
        continue;
      }
    }

    if (!open && i >= cooldownUntilIndex && i < events.length - 1) {
      const maBefore = fundingMovingAverage(events, i, config.maEpochs);
      // Architecture §4.4 gate 7 / §13: `f_ma ≥ DN_MIN_FUNDING_RATE`. Inclusive
      // matters — Bybit caps most pairs at exactly 0.01%/8h, so a strict `>`
      // would reject the single most common funding level.
      if (maBefore !== null && maBefore.gte(config.entryThreshold)) {
        open = {
          entryTime: event.timestamp,
          entryMa: maBefore,
          kMin: computeKMin(maBefore, config),
          equityBefore: equity,
          fundingReturn: ZERO,
          epochsHeld: 0,
        };
      }
    }
  }

  if (open) {
    const lastIndex = events.length - 1;
    const exitMa = fundingMovingAverage(events, lastIndex, config.maEpochs);
    closePosition(open, lastIndex, exitMa, 'END_OF_DATA');
  }

  const firstTimestamp = events[0].timestamp;
  const lastTimestamp = events[events.length - 1].timestamp;
  const windowDays = new Decimal(lastTimestamp - firstTimestamp).div(DN_DAY_MS);
  const totalYield = equity.div(startEquity).minus(1);
  const netApy = annualizeApy(totalYield, windowDays);

  const tradeCount = trades.length;
  const avgHoldHours =
    tradeCount > 0
      ? sumDecimal(trades.map((trade) => trade.holdHours)).div(tradeCount)
      : null;
  const avgHoldEpochs =
    tradeCount > 0
      ? new Decimal(trades.reduce((acc, trade) => acc + trade.epochsHeld, 0)).div(tradeCount)
      : null;

  const grossFundingUsdt = sumDecimal(trades.map((trade) => trade.fundingPnlUsdt));
  const grossBasisUsdt = sumDecimal(trades.map((trade) => trade.basisPnlUsdt));
  const grossFeesUsdt = sumDecimal(trades.map((trade) => trade.feesUsdt));
  const grossSlippageUsdt = sumDecimal(trades.map((trade) => trade.slippageUsdt));

  return {
    symbol,
    eventCount: events.length,
    intervalHours,
    dataGaps,
    firstTimestamp,
    lastTimestamp,
    windowDays,
    trades,
    tradeCount,
    startEquity,
    endEquity: equity,
    totalYield,
    netApy,
    netPnlUsdt: equity.minus(startEquity),
    grossFundingUsdt,
    grossBasisUsdt,
    grossFeesUsdt,
    grossSlippageUsdt,
    avgHoldHours,
    avgHoldEpochs,
    fundingToFeeRatio: grossFeesUsdt.gt(0) ? grossFundingUsdt.div(grossFeesUsdt) : null,
  };
}

/**
 * Aggregate per-symbol results. Each symbol starts with `initialEquity`, so the
 * portfolio start equity is `initialEquity × successfulSymbols`. APY is
 * annualized over the common data window, not averaged from per-symbol APYs.
 */
export function buildBasketMetrics(
  results: readonly SymbolMetrics[],
  failures: ReadonlyArray<{ symbol: string; error: string }>,
  config: DnConfig,
): BasketMetrics {
  const startEquity = config.initialEquity.mul(results.length);
  const endEquity = sumDecimal(results.map((result) => result.endEquity));
  const totalYield = startEquity.gt(0) ? endEquity.div(startEquity).minus(1) : ZERO;

  const timestamps = results
    .filter((result) => result.eventCount > 0)
    .flatMap((result) => [result.firstTimestamp, result.lastTimestamp]);
  const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const lastTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : 0;
  const windowDays =
    lastTimestamp > firstTimestamp
      ? new Decimal(lastTimestamp - firstTimestamp).div(DN_DAY_MS)
      : ZERO;
  const netApy = annualizeApy(totalYield, windowDays);

  const allTrades = results.flatMap((result) => result.trades);
  const tradeCount = allTrades.length;
  const avgHoldHours =
    tradeCount > 0
      ? sumDecimal(allTrades.map((trade) => trade.holdHours)).div(tradeCount)
      : null;

  const grossFundingUsdt = sumDecimal(results.map((result) => result.grossFundingUsdt));
  const grossFeesUsdt = sumDecimal(results.map((result) => result.grossFeesUsdt));

  return {
    results,
    failures,
    startEquity,
    endEquity,
    totalYield,
    netApy,
    netPnlUsdt: endEquity.minus(startEquity),
    tradeCount,
    avgHoldHours,
    grossFundingUsdt,
    grossFeesUsdt,
    fundingToFeeRatio: grossFeesUsdt.gt(0) ? grossFundingUsdt.div(grossFeesUsdt) : null,
    firstTimestamp,
    lastTimestamp,
    windowDays,
  };
}
