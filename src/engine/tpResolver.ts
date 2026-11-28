import { Decimal } from 'decimal.js';
import { isMajorTimeframe } from '../utils/timeframe';
import type {
  LiquidityPool,
  MacroContext,
  SessionRange,
  TradingRange,
  Zone,
} from '../smc/patternRecognizer';

/**
 * Dynamic Take-Profit Resolver.
 *
 * WHY THIS EXISTS
 * ---------------
 * `BaseScenario.calculateLevels()` derives TP arithmetically from the stop:
 *
 *     TP = entry +/- k * |entry - SL|
 *
 * The market is never consulted, so the target carries no information about
 * whether price can actually reach it. Two independent mechanisms make the
 * blind `k * R` form negative-expectancy on 1m entries:
 *
 *   1. Fee-to-stop explosion. Round-trip fees in R units are
 *
 *          f = c / s            where s = R / entry, c = 0.0011 (taker/taker)
 *
 *      At the `calculateLevels` offset floor of s = 0.1%, f = 1.1R — the fees
 *      alone exceed the risk budget. Breakeven win rate at 3R becomes
 *
 *          p_be = (1 + f) / (k + 1)
 *
 *      i.e. 25% with no fees, 52.5% at the 0.1% floor.
 *
 *   2. MFE distribution. If the maximum favourable excursion before the stop
 *      is exponential with mean mu (in R), then E(k) = (k+1) * e^(-k/mu) - 1
 *      and the optimal target is k* = mu - 1 — never a constant. At mu = 2R,
 *      E(3R) = -0.11R; at mu = 3R, 3R is still dominated by 2R (0.472 vs 0.540).
 *
 * This module replaces the constant with the nearest structural obstacle the
 * market itself defines: opposing liquidity, the near edge of an unmitigated
 * HTF/LTF zone, range equilibrium, or a session extreme.
 *
 * CONTRACT
 * --------
 * - Pure: no I/O, no logger, no config object, no Decimal mutation.
 * - If the nearest obstacle is closer than `minRr`, the setup is REJECTED.
 *   A 1.2R long into a wall is not a trade — clamping would fabricate a
 *   target the market has already invalidated.
 * - If the nearest obstacle is further than `maxRr`, the target is clamped;
 *   a 1m scalp must not demand a 12R hold (see AGENTS.md §16.5.5).
 */

export type TpSource =
  | 'LIQUIDITY_POOL'
  | 'HTF_ZONE'
  | 'LTF_ZONE'
  | 'RANGE_EQUILIBRIUM'
  | 'SESSION_RANGE'
  | 'FIXED_FALLBACK';

export interface TpCandidate {
  /** Absolute price of the structural obstacle (never an R multiple). */
  readonly price: Decimal;
  readonly source: TpSource;
  /** Human-readable origin, e.g. `PDH level`, `240 OB`, `Range equilibrium`. */
  readonly label: string;
  /** Distance from entry expressed in R units (always > 0). */
  readonly rr: Decimal;
  /**
   * Macro barrier vs. internal noise.
   *
     * Major: PDH/PDL, PWH/PWL, EQH/EQL, DO/WO, unmitigated zones at or above the
     * configured HTF, calendar zones and caller-forced targets. Minor: BSL/SSL, LTF zones,
   * range equilibrium and session extremes.
   *
   * Only meaningful when `skipMinorObstacles` is enabled — the legacy
   * nearest-wins filter treats every candidate as a wall.
   */
  readonly major: boolean;
}

export interface TpResolveInput {
  readonly htfTimeframe?: string;
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly entry: Decimal;
  readonly stopLoss: Decimal;
  readonly zones: readonly Zone[];
  readonly liquidityPools: readonly LiquidityPool[];
  /** The liquidity event that triggered this setup cannot also be its target. */
  readonly sweptLevelPrice?: Decimal;
  readonly tradingRange: TradingRange | null;
  readonly macroContext: MacroContext | null;
  readonly sessionRanges: readonly SessionRange[];
  readonly minRr: Decimal;
  readonly maxRr: Decimal;
  readonly fixedRr: Decimal;
  readonly enableDynamicTp: boolean;
  readonly requireTarget: boolean;
  /**
   * Wall-filter mode.
   *
   * Legacy (false/undefined): every candidate — including an individual 4H
   * swing or a 15m zone — is a wall, so the NEAREST one decides the outcome.
   *
   * Enabled: minor obstacles closer than `minRr` are skipped instead of
   * rejecting the setup; the resolver keeps walking outwards and targets the
   * first candidate that clears the floor. A MAJOR barrier (macro pool, HTF
   * zone, caller-forced target) inside the floor still rejects — that is a real
   * wall, not internal noise.
   */
  readonly skipMinorObstacles?: boolean;
  /**
   * Prices that must be classified as MAJOR regardless of their source.
   *
   * Scenario 13 injects the roadmap target as a synthetic BSL/SSL pool; without
   * this the macro draw would look like an internal swing and could be skipped.
   */
  readonly majorTargets?: readonly Decimal[];
}

export type TpResolution =
  | {
      readonly ok: true;
      readonly takeProfit: Decimal;
      readonly rr: Decimal;
      readonly source: TpSource;
      readonly label: string;
      readonly nearest: TpCandidate | null;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly nearest: TpCandidate | null;
    };

/**
 * Tie-break order when two sources describe the same price. Liquidity is the
 * most authoritative (it is where stops actually rest), zones are next, and
 * derived levels (range/session) last.
 */
const SOURCE_PRIORITY: Record<TpSource, number> = {
  LIQUIDITY_POOL: 0,
  HTF_ZONE: 1,
  LTF_ZONE: 2,
  RANGE_EQUILIBRIUM: 3,
  SESSION_RANGE: 4,
  FIXED_FALLBACK: 5,
};

/**
 * Pool types that represent genuine macro liquidity rather than an internal
 * swing. PDH/PDL/PWH/PWL are previous-session extremes, EQH/EQL are equal
 * highs/lows (resting-stop clusters) and DO/WO are session opens. `BSL`/`SSL`
 * are individual swing points — useful as a first target, but too dense to be
 * treated as an impenetrable wall (see the wall-filter note below).
 */
const MAJOR_POOL_TYPES = new Set<LiquidityPool['type']>([
  'PDH',
  'PDL',
  'PWH',
  'PWL',
  'EQH',
  'EQL',
  'DO',
  'WO',
]);

interface RawCandidate {
  readonly price: Decimal;
  readonly source: TpSource;
  readonly label: string;
  readonly major: boolean;
}

function isUsablePrice(value: unknown): value is Decimal {
  return value instanceof Decimal && value.isFinite() && value.gt(0);
}

/**
 * Collect every structural obstacle strictly beyond the entry in trade
 * direction. Never returns an obstacle behind or at the entry.
 */
function collectCandidates(
  input: TpResolveInput,
  risk: Decimal,
): TpCandidate[] {
  const isLong = input.direction === 'BULLISH';
  const beyond = (price: Decimal): boolean =>
    isLong ? price.gt(input.entry) : price.lt(input.entry);

  // Caller-forced macro targets (e.g. Scenario 13's roadmap draw, which is
  // injected as a synthetic swing pool and would otherwise look minor).
  const forcedMajor = new Set(
    (input.majorTargets ?? [])
      .filter((price): price is Decimal => isUsablePrice(price))
      .map((price) => price.toFixed(8)),
  );
  const isMajorPrice = (price: Decimal, sourceMajor: boolean): boolean =>
    sourceMajor || forcedMajor.has(price.toFixed(8));

  const raw: RawCandidate[] = [];

  // --- 1. Liquidity pools (macro PDH/PDL/PWH/PWL + swing BSL/SSL/EQH/EQL) ---
  // `buildPatternData` already merges macro pools into `liquidityPools`, so the
  // macro levels below are only a fallback for callers that pass a bare array;
  // price-level deduplication prevents double counting.
  const takenPrices = new Set<string>();
  for (const pool of input.liquidityPools ?? []) {
    if (!isUsablePrice(pool.priceLevel)) continue;
    if (pool.isTaken) {
      takenPrices.add(pool.priceLevel.toString());
      continue;
    }
    if (!beyond(pool.priceLevel)) continue;
    const sourceMajor = MAJOR_POOL_TYPES.has(pool.type);
    raw.push({
      price: pool.priceLevel,
      source: 'LIQUIDITY_POOL',
      label: `${pool.type} liquidity`,
      major: isMajorPrice(pool.priceLevel, sourceMajor),
    });
  }

  // --- 2. Opposing unmitigated zones (near edge only) ---
  // A long targets supply above (BEARISH zones); a short targets demand below
  // (BULLISH zones). The near edge is the first price the market reaches, so it
  // is the conservative and correct exit — never the far edge.
  const opposingDirection = isLong ? 'BEARISH' : 'BULLISH';
  for (const zone of input.zones ?? []) {
    if (zone.mitigated) continue;
    if (zone.direction !== opposingDirection) continue;
    if (!isUsablePrice(zone.top) || !isUsablePrice(zone.bottom)) continue;

    // Zone top/bottom ordering is NOT guaranteed — use min/max (Invariant 11).
    const nearEdge = isLong
      ? Decimal.min(zone.top, zone.bottom)
      : Decimal.max(zone.top, zone.bottom);

    if (!beyond(nearEdge)) continue;

    const isHtf = isMajorTimeframe(zone.timeframe, input.htfTimeframe);
    raw.push({
      price: nearEdge,
      source: isHtf ? 'HTF_ZONE' : 'LTF_ZONE',
      label: `${zone.timeframe} ${zone.type}`,
      major: isMajorPrice(nearEdge, isHtf),
    });
  }

  // --- 3. Range equilibrium (mean-reversion magnet) ---
  const equilibrium = input.tradingRange?.equilibrium;
  if (isUsablePrice(equilibrium) && beyond(equilibrium)) {
    raw.push({
      price: equilibrium,
      source: 'RANGE_EQUILIBRIUM',
      label: 'Range equilibrium',
      major: isMajorPrice(equilibrium, false),
    });
  }

  // --- 4. Session extremes (Asian/London/NY) ---
  for (const range of input.sessionRanges ?? []) {
    const target = isLong ? range.high : range.low;
    if (!isUsablePrice(target)) continue;
    if (!beyond(target)) continue;
    raw.push({
      price: target,
      source: 'SESSION_RANGE',
      label: `${range.name} range ${isLong ? 'high' : 'low'}`,
      major: isMajorPrice(target, false),
    });
  }

  // --- 5. Macro context fallback ---
  const macro = input.macroContext;
  if (macro) {
    const levels: Array<readonly [string, Decimal | undefined]> = [
      ['PDH', macro.dailyLevels?.pdh],
      ['PDL', macro.dailyLevels?.pdl],
      ['PWH', macro.weeklyLevels?.pwh],
      ['PWL', macro.weeklyLevels?.pwl],
      ['ATH', macro.ath],
      ['ATL', macro.atl],
    ];
    for (const [label, price] of levels) {
      if (!isUsablePrice(price)) continue;
      if (takenPrices.has(price.toString())) continue;
      if (!beyond(price)) continue;
      raw.push({
        price,
        source: 'LIQUIDITY_POOL',
        label: `${label} level`,
        major: isMajorPrice(price, true),
      });
    }
  }

  // --- Deduplicate by price, keeping the highest-priority source ---
  // Equal-priority collisions keep the MAJOR classification: a synthetic swing
  // pool must never downgrade a real macro level sitting at the same price.
  const byPrice = new Map<string, RawCandidate>();
  for (const candidate of raw) {
    if (input.sweptLevelPrice?.eq(candidate.price)) continue;
    const key = candidate.price.toFixed(8);
    const existing = byPrice.get(key);
    const priority = SOURCE_PRIORITY[candidate.source];
    const existingPriority = existing ? SOURCE_PRIORITY[existing.source] : Infinity;
    if (
      !existing ||
      priority < existingPriority ||
      (priority === existingPriority && candidate.major && !existing.major)
    ) {
      byPrice.set(key, candidate);
    }
  }

  // --- Express distance in R and sort ascending (nearest wins) ---
  return [...byPrice.values()]
    .map<TpCandidate>((candidate) => ({
      price: candidate.price,
      source: candidate.source,
      label: candidate.label,
      rr: candidate.price.minus(input.entry).abs().div(risk),
      major: candidate.major,
    }))
    .sort((a, b) => {
      const byRr = a.rr.comparedTo(b.rr);
      if (byRr !== 0) return byRr;
      // Deterministic tie-break so identical RR never reorders between runs.
      return a.price.comparedTo(b.price);
    });
}

function fixedTarget(
  input: TpResolveInput,
  risk: Decimal,
): { takeProfit: Decimal; rr: Decimal } {
  const distance = risk.mul(input.fixedRr);
  return {
    takeProfit:
      input.direction === 'BULLISH'
        ? input.entry.plus(distance)
        : input.entry.minus(distance),
    rr: input.fixedRr,
  };
}

/**
 * Resolve the take-profit for a setup.
 *
 * Order of operations mirrors the audit (§3.4):
 *   1. Validate R.
 *   2. Collect + rank structural candidates.
 *   3. `nearest.rr < minRr`  -> REJECT (no clamp).
 *   4. `nearest.rr > maxRr`  -> clamp.
 *   5. No candidates         -> `fixedRr` unless `requireTarget`.
 *   6. Re-assert the side invariant.
 */
export function resolveTakeProfit(input: TpResolveInput): TpResolution {
  const { entry, stopLoss, direction } = input;

  if (!entry.isFinite() || entry.lte(0)) {
    return {
      ok: false,
      reason: `Invalid entry price: ${String(entry)}`,
      nearest: null,
    };
  }
  if (!stopLoss.isFinite()) {
    return {
      ok: false,
      reason: `Invalid stop-loss price: ${String(stopLoss)}`,
      nearest: null,
    };
  }
  if (!input.fixedRr.gt(0)) {
    return {
      ok: false,
      reason: `fixedRr must be > 0, got ${input.fixedRr.toString()}`,
      nearest: null,
    };
  }
  if (!input.minRr.gt(0) || !input.maxRr.gt(0)) {
    return {
      ok: false,
      reason: `minRr/maxRr must be > 0 (min=${input.minRr.toString()}, max=${input.maxRr.toString()})`,
      nearest: null,
    };
  }

  const risk = entry.minus(stopLoss).abs();
  if (risk.lte(0)) {
    return {
      ok: false,
      reason: 'Stop-loss distance is zero — R is undefined',
      nearest: null,
    };
  }

  // Toggle OFF: preserve the legacy fixed-multiple behaviour exactly.
  if (!input.enableDynamicTp) {
    const { takeProfit, rr } = fixedTarget(input, risk);
    return {
      ok: true,
      takeProfit,
      rr,
      source: 'FIXED_FALLBACK',
      label: `Fixed ${input.fixedRr.toString()}R (dynamic TP disabled)`,
      nearest: null,
    };
  }

  const candidates = collectCandidates(input, risk);
  const nearest = candidates[0] ?? null;

  if (!nearest) {
    if (input.requireTarget) {
      return {
        ok: false,
        reason:
          'No opposing structural target beyond entry and dynamicTpRequireTarget is enabled',
        nearest: null,
      };
    }
    const { takeProfit, rr } = fixedTarget(input, risk);
    return {
      ok: true,
      takeProfit,
      rr,
      source: 'FIXED_FALLBACK',
      label: `Fixed ${input.fixedRr.toString()}R (no structural target)`,
      nearest: null,
    };
  }

  // THE WALL FILTER — reject, never clamp. A target closer than minRr means the
  // market has no room to run; pretending otherwise is how negative expectancy
  // gets reintroduced through the back door.
  //
  // With `skipMinorObstacles`, the filter distinguishes a genuine macro wall
  // from internal swing noise. A minor 4H/15m swing inside the floor is simply
  // stepped over — the position is not actually blocked by it — and the search
  // continues to the first candidate that clears the floor. A MAJOR barrier
  // inside the floor still rejects, because price really does have to absorb it.
  let selected: TpCandidate = nearest;

  if (input.skipMinorObstacles === true) {
    let chosen: TpCandidate | null = null;
    let blockingMajor: TpCandidate | null = null;

    for (const candidate of candidates) {
      if (candidate.rr.gte(input.minRr)) {
        chosen = candidate;
        break;
      }
      if (candidate.major) {
        blockingMajor = candidate;
        break;
      }
    }

    if (!chosen) {
      const culprit = blockingMajor ?? nearest;
      const kind = blockingMajor ? 'major obstacle' : 'no structural target';
      return {
        ok: false,
        reason: `Insufficient room: ${kind} at ${culprit.rr.toFixed(2)}R < min ${input.minRr.toFixed(2)}R (${culprit.label})`,
        nearest: culprit,
      };
    }

    selected = chosen;
  } else if (nearest.rr.lt(input.minRr)) {
    return {
      ok: false,
      reason: `Insufficient room: nearest target at ${nearest.rr.toFixed(2)}R < min ${input.minRr.toFixed(2)}R (${nearest.label})`,
      nearest,
    };
  }

  let takeProfit = selected.price;
  let rr = selected.rr;

  if (rr.gt(input.maxRr)) {
    // The obstacle is real but too far for a 1m hold — cap the distance.
    const distance = risk.mul(input.maxRr);
    takeProfit =
      direction === 'BULLISH' ? entry.plus(distance) : entry.minus(distance);
    rr = input.maxRr;
  }

  const correctSide =
    direction === 'BULLISH' ? takeProfit.gt(entry) : takeProfit.lt(entry);
  if (!correctSide) {
    return {
      ok: false,
      reason: `Resolved take-profit ${takeProfit.toString()} is on the wrong side of entry ${entry.toString()} for ${direction}`,
      nearest: selected,
    };
  }

  return {
    ok: true,
    takeProfit,
    rr,
    source: selected.source,
    label: selected.label,
    nearest: selected,
  };
}
