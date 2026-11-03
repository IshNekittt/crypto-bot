/**
 * Canonical scenario IDs the router can actually construct.
 *
 * This is the single source of truth for the live registry. It lives in its own
 * dependency-free module because BOTH the router (which instantiates the
 * scenarios) and the config layer (which validates `ACTIVE_SCENARIOS` /
 * `SCENARIOS_<SYMBOL>`) must agree on the same set. Importing the router from
 * `env.ts` would create a cycle: the router already imports `BotConfig` and
 * `resolveSymbolConfig` from `env.ts`.
 *
 * Live registry (see AGENTS.md §8):
 *   1  HTF Continuation        (15m Classic)
 *   5  HTF Liquidity Sweep     (15m Classic)
 *   12 Sniper Touch            (1m Sniper — requires ENABLE_SNIPER_MODE=true)
 *   14 Trend Following Alpha   (15m Classic)
 *   15 Volatility Squeeze      (15m Classic)
 *
 * Archived and NOT constructible: 2, 3, 4, 6, 7, 8, 9, 10, 11 (legacy SMC
 * discovery sweep), 13 (Top-Down Order Flow) and 16 (ATR Exhaustion
 * Reversal). Their modules remain under `src/engine/scenarios/archive/` for
 * reference and are still unit-tested, but no runtime path can schedule them.
 */
export const REGISTERED_SCENARIO_IDS: readonly number[] = Object.freeze([
  1, 5, 12, 14, 15,
]);

const REGISTERED_SCENARIO_SET: ReadonlySet<number> = new Set(
  REGISTERED_SCENARIO_IDS,
);

/** IDs that are only valid when `ENABLE_SNIPER_MODE=true`. */
export const SNIPER_ONLY_SCENARIO_IDS: readonly number[] = Object.freeze([12]);

/** IDs that require Classic mode on a 15m execution timeframe. */
export const CLASSIC_ONLY_SCENARIO_IDS: readonly number[] = Object.freeze([
  1, 5, 14, 15,
]);

/** True when `id` can be constructed by the live router. */
export function isRegisteredScenarioId(id: number): boolean {
  return REGISTERED_SCENARIO_SET.has(id);
}

/**
 * Comma-separated registry list for validation errors and boot logs,
 * e.g. `1,5,12,14,15`.
 */
export function describeRegisteredScenarios(): string {
  return REGISTERED_SCENARIO_IDS.join(',');
}

/**
 * Human-readable list of archived IDs, kept next to the registry so an
 * operator reading a validation failure sees exactly what was retired.
 */
export const ARCHIVED_SCENARIO_IDS_LABEL = '2-4, 6-11, 13, 16';
