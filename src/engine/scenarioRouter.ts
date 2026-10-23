import { IScenario, StructureDetails, MitigatedZone, MitigatedStructure } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { ZoneDetails } from '../types';
import { BotConfig } from '../config/env';
import { PatternData } from '../smc/patternRecognizer';
import { Scenario1_HTFContinuation } from './scenarios/Scenario1_HTFContinuation';
import { Scenario2_FVGFill } from './scenarios/Scenario2_FVGFill';
import { Scenario3_IDM } from './scenarios/Scenario3_IDM';
import { Scenario4_MitigationChain } from './scenarios/Scenario4_MitigationChain';
import { Scenario5_HTFLiquiditySweep } from './scenarios/Scenario5_HTFLiquiditySweep';
import { Scenario6_SMS } from './scenarios/Scenario6_SMS';
import { Scenario7_AMD } from './scenarios/Scenario7_AMD';
import { Scenario8_RangeDeviationReclaim } from './scenarios/Scenario8_RangeDeviationReclaim';
import { Scenario9_TurtleSoup } from './scenarios/Scenario9_TurtleSoup';
import { Scenario10_BreakerBlock } from './scenarios/Scenario10_BreakerBlock';
import { Scenario11_MitigationBlock } from './scenarios/Scenario11_MitigationBlock';
import { Scenario12_SniperTouch } from './scenarios/Scenario12_SniperTouch';

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
    this.config = deps.config;

    const allScenarios: IScenario[] = [
      // Priority 1: Complex, high-precision scenarios (checked first)
      new Scenario5_HTFLiquiditySweep(this.config),    // 5: HTF Liquidity Sweep
      new Scenario7_AMD(this.config),                   // 7: AMD
      new Scenario9_TurtleSoup(this.config),            // 9: Turtle Soup
      new Scenario10_BreakerBlock(this.config),         // 10: Breaker Block
      new Scenario11_MitigationBlock(this.config),      // 11: Mitigation Block
      new Scenario12_SniperTouch(this.config),          // 12: Sniper Touch (1m Macro)
      // Priority 2: Trend continuation scenarios
      new Scenario1_HTFContinuation(this.config),       // 1: HTF Continuation
      new Scenario3_IDM(this.config),                   // 3: IDM
      new Scenario6_SMS(this.config),                   // 6: Failure Swing (SMS)
      new Scenario8_RangeDeviationReclaim(this.config), // 8: Range Deviation & Reclaim
      // Priority 3: Simple, greedy scenarios (checked last)
      new Scenario2_FVGFill(this.config),               // 2: FVG Fill
      new Scenario4_MitigationChain(this.config),       // 4: Mitigation Chain
    ];

    if (deps.activeScenarios && deps.activeScenarios.length > 0) {
      this.scenarios = allScenarios.filter(s => deps.activeScenarios.includes(s.id));
      logger.info(`[${this.symbol}] Active scenarios: ${this.scenarios.map(s => `${s.id}:${s.name}`).join(', ')}`);
    } else {
      this.scenarios = allScenarios;
      logger.info(`[${this.symbol}] All ${allScenarios.length} scenarios active (no active scenarios configured)`);
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