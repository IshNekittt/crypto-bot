import { IScenario, StructureDetails, MitigatedZone, MitigatedStructure } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { ZoneDetails } from '../types';
import { BotConfig, resolveSymbolConfig } from '../config/env';
import { PatternData } from '../smc/patternRecognizer';
import { Scenario1_HTFContinuation } from './scenarios/Scenario1_HTFContinuation';
import { Scenario5_HTFLiquiditySweep } from './scenarios/Scenario5_HTFLiquiditySweep';
import { Scenario12_SniperTouch } from './scenarios/Scenario12_SniperTouch';
import { Scenario14_QuantAlpha } from './scenarios/Scenario14_QuantAlpha';
import { Scenario15_VolatilitySqueeze } from './scenarios/Scenario15_VolatilitySqueeze';
import {
  ARCHIVED_SCENARIO_IDS_LABEL,
  REGISTERED_SCENARIO_IDS,
} from './scenarioRegistry';

/**
 * Scenario IDs the router can actually construct.
 *
 * Re-exported from `scenarioRegistry.ts` — the dependency-free single source of
 * truth shared with config validation (`ACTIVE_SCENARIOS` / `SCENARIOS_<SYMBOL>`).
 * Importing `env.ts` from that module would cycle, because the router already
 * imports `BotConfig` from `env.ts`.
 *
 * Live registry: 1 (HTF Continuation), 5 (HTF Liquidity Sweep), 12 (Sniper
 * Touch), 14 (Trend Following Alpha), 15 (Volatility Squeeze).
 *
 * Archived to `src/engine/scenarios/archive/legacy_smc/` after the 180-day
 * unfiltered discovery sweep: 2, 3, 4, 6, 7, 8, 9, 10, 11. Scenario 13
 * (Top-Down Order Flow) was archived separately. Their modules still compile and
 * their suites still run, but no runtime path can schedule them.
 */
export { REGISTERED_SCENARIO_IDS } from './scenarioRegistry';

export interface ScenarioRouterDeps {
  readonly symbol: string;
  readonly patternRecognizer: any;
  readonly notifier: any;
  readonly activeScenarios: number[];
  readonly config: BotConfig;
}

export interface RouterResult {
  triggered: boolean;
  scenario: IScenario | null;
  levels: any | null;
  reason: string;
  zoneDetails: ZoneDetails | null;
  structureDetails: StructureDetails | null;
}

export class ScenarioRouter {
  private readonly symbol: string;
  private readonly patternRecognizer: any;
  private readonly config: BotConfig;
  private readonly scenarios: IScenario[];

  constructor(deps: ScenarioRouterDeps) {
    this.symbol = deps.symbol;
    this.patternRecognizer = deps.patternRecognizer;
    // Single resolution point for per-symbol calibration: the router is created
    // once per symbol (StrategyEngine live, run.ts backtest), so every scenario it
    // owns — Scenario 12 included — and the `tpResolver` inputs it feeds are
    // already symbol-correct. An uncalibrated symbol returns the same object.
    this.config = resolveSymbolConfig(deps.config, deps.symbol);

    const allScenarios: IScenario[] = [
      new Scenario1_HTFContinuation(this.config), // 1: HTF Continuation (15m Classic)
      new Scenario5_HTFLiquiditySweep(this.config), // 5: HTF Liquidity Sweep (15m Classic)
      new Scenario12_SniperTouch(this.config), // 12: Sniper Touch (1m Macro)
      new Scenario14_QuantAlpha(this.config), // 14: Trend Following / Donchian (15m Classic)
      new Scenario15_VolatilitySqueeze(this.config), // 15: BB/KC Volatility Squeeze (15m Classic)
    ];

    // `activeScenarios` NARROWS the registry — it can never add a scenario the
    // router does not own. Ids with no registered implementation are reported
    // rather than silently swallowed, because an empty intersection would
    // otherwise leave a live process scanning forever without a single scenario
    // to evaluate. `loadConfig()` already rejects such ids outright; this branch
    // is the defensive backstop for callers that bypass config validation.
    const requested = deps.activeScenarios ?? [];

    if (requested.length === 0) {
      this.scenarios = allScenarios;
      logger.info(
        `[${this.symbol}] All ${allScenarios.length} registered scenario(s) active: ${this.scenarios
          .map((s) => `${s.id}:${s.name}`)
          .join(', ')}`,
      );
    } else {
      this.scenarios = allScenarios.filter((s) => requested.includes(s.id));

      const unregistered = requested.filter((id) => !REGISTERED_SCENARIO_IDS.includes(id));
      if (unregistered.length > 0) {
        logger.warn(
          `[${this.symbol}] ACTIVE_SCENARIOS requests unregistered scenario(s) ${unregistered.join(',')} — ignored. ` +
            `Registered: ${REGISTERED_SCENARIO_IDS.join(',')} (archived: ${ARCHIVED_SCENARIO_IDS_LABEL}).`,
        );
      }

      if (this.scenarios.length === 0) {
        logger.error(
          `[${this.symbol}] ACTIVE_SCENARIOS resolves to ZERO registered scenarios — this process will evaluate nothing. ` +
            `Set ACTIVE_SCENARIOS to a subset of ${REGISTERED_SCENARIO_IDS.join(',')} or unset it.`,
        );
      } else {
        logger.info(
          `[${this.symbol}] Active scenarios: ${this.scenarios.map((s) => `${s.id}:${s.name}`).join(', ')}`,
        );
      }
    }
  }

  private filterMitigatedZones(zones: any[], mitigatedZones: MitigatedZone[]): any[] {
    if (!mitigatedZones.length) return zones;
    return zones.filter(zone => {
      // Check if this zone matches any mitigated zone (by price levels and type)
      return !mitigatedZones.some(mz => 
        mz.type === zone.type &&
        mz.timeframe === zone.timeframe &&
        mz.direction === zone.direction &&
        new Decimal(mz.top).eq(zone.top) &&
        new Decimal(mz.bottom).eq(zone.bottom)
      );
    });
  }

  private filterMitigatedStructures(structures: any[], mitigatedStructures: MitigatedStructure[]): any[] {
    if (!mitigatedStructures.length) return structures;
    return structures.filter(s => {
      return !mitigatedStructures.some(ms => ms.timestamp === s.timestamp);
    });
  }

async evaluate(
    candles15m: any[],
    candles4h: any[],
    currentCandleTimestamp: number,
    mitigatedZones: MitigatedZone[] = [],
    mitigatedStructures: MitigatedStructure[] = [],
    candles1m: any[] = [], // 1m candles for Sniper Mode (Scenario 12)
    patternData?: PatternData // Pre-computed PatternData for performance
  ): Promise<RouterResult> {
    // Day-of-Week filter (UTC): block NEW entries on disallowed weekdays (e.g., weekends).
    // Applies identically to Live Trading and Backtesting (router-level gate).
    // NOTE: Entry filter ONLY — it never affects active trade management (SL trailing/closing).
    const allowedDays = this.config.allowedDaysOfWeek;
    if (allowedDays && allowedDays.length > 0) {
      const weekday = DateTime.fromMillis(currentCandleTimestamp, { zone: 'utc' }).weekday;
      if (!allowedDays.includes(weekday)) {
        logger.debug(
          `[${this.symbol}] Entry scan skipped: UTC weekday ${weekday} is not in ALLOWED_DAYS_OF_WEEK (${allowedDays.join(',')})`,
        );
        return { triggered: false, scenario: null, levels: null, reason: 'Day-of-week filter', zoneDetails: null, structureDetails: null };
      }
    }

    if (!this.scenarios.length) {
      return { triggered: false, scenario: null, levels: null, reason: 'No scenarios configured', zoneDetails: null, structureDetails: null };
    }

    try {
      // Use pre-computed PatternData or build it (for backward compatibility / live mode)
      const basePd: PatternData = patternData
        ? patternData
        : await this.patternRecognizer.buildPatternData(
            this.symbol,
            candles15m,
            candles4h,
            currentCandleTimestamp
          );

      // NEVER mutate the cached PatternData: the backtester reuses one object across
      // 1m iterations, and in-place filtering would permanently strip structures and
      // zones from the cache until the next 15m rebuild. Filtering is applied to local
      // copies that are handed to the scenarios instead.
      const baseStructures = Array.isArray(basePd.structures) ? basePd.structures : [];
      const baseZones = Array.isArray(basePd.zones) ? basePd.zones : [];
      const safeStructures = this.filterMitigatedStructures([...baseStructures], mitigatedStructures);
      const safeZones = this.filterMitigatedZones([...baseZones], mitigatedZones);

      const evaluationData: PatternData = {
        ...basePd,
        zones: safeZones,
        structures: safeStructures,
        candles1m,
        mitigatedZones,
        mitigatedStructures,
      };

      for (const scenario of this.scenarios) {
        try {
          const matches = scenario.evaluate(evaluationData);
          
          if (matches) {
            const levels = scenario.getLevels();
            const reason = scenario.getReason();
            const zoneDetails = scenario.getZoneDetails();
            
            logger.info(`Scenario ${scenario.name} triggered`, {
              symbol: this.symbol,
              scenario: scenario.name,
              scenarioId: scenario.id,
              reason,
              levels,
            });

            return {
              triggered: true,
              scenario,
              levels,
              reason,
              zoneDetails,
              structureDetails: scenario.getStructureDetails(),
            };
          } else {
            // Debug log for rejected scenario
            const rejectionReason = scenario.getReason() || 'Conditions not met';
            logger.debug(`[${this.symbol}] ${scenario.name} rejected: ${rejectionReason}`);
          }
        } catch (err) {
          logger.error('Scenario evaluation error', {
            symbol: this.symbol,
            scenario: scenario.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { triggered: false, scenario: null, levels: null, reason: 'No scenario matched', zoneDetails: null, structureDetails: null };
    } catch (err) {
      logger.error('Pattern recognition failed', {
        symbol: this.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return { triggered: false, scenario: null, levels: null, reason: 'Pattern recognition error', zoneDetails: null, structureDetails: null };
    }
  }
}

export function createScenarioRouter(deps: any): ScenarioRouter {
  return new ScenarioRouter(deps);
}