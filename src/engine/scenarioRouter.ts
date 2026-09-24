import { IScenario, StructureDetails } from '../types';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';
import { ZoneDetails } from '../types';
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

export interface ScenarioRouterDeps {
  readonly symbol: string;
  readonly patternRecognizer: any;
  readonly notifier: any;
  readonly activeScenarios: number[];
}

export interface MitigatedZone {
  type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
  top: string;
  bottom: string;
  timeframe: string;
  direction: string;
  timestamp: number;
}

export interface MitigatedStructure {
  type: 'SMS' | 'CHoCH' | 'BOS';
  timestamp: number;
  price: string;
  direction: 'BULLISH' | 'BEARISH';
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
  private readonly _notifier: any;

  get notifier(): any {
    return this._notifier;
  }
  private readonly scenarios: IScenario[];

  constructor(deps: ScenarioRouterDeps) {
    this.symbol = deps.symbol;
    this.patternRecognizer = deps.patternRecognizer;
    this._notifier = deps.notifier;

    const allScenarios: IScenario[] = [
      // Priority 1: Complex, high-precision scenarios (checked first)
      new Scenario5_HTFLiquiditySweep(),    // 5: HTF Liquidity Sweep
      new Scenario7_AMD(),                   // 7: AMD
      new Scenario9_TurtleSoup(),            // 9: Turtle Soup
      new Scenario10_BreakerBlock(),         // 10: Breaker Block
      new Scenario11_MitigationBlock(),      // 11: Mitigation Block
      // Priority 2: Trend continuation scenarios
      new Scenario1_HTFContinuation(),       // 1: HTF Continuation
      new Scenario3_IDM(),                   // 3: IDM
      new Scenario6_SMS(),                   // 6: Failure Swing (SMS)
      new Scenario8_RangeDeviationReclaim(), // 8: Range Deviation & Reclaim
      // Priority 3: Simple, greedy scenarios (checked last)
      new Scenario2_FVGFill(),               // 2: FVG Fill
      new Scenario4_MitigationChain(),       // 4: Mitigation Chain
    ];

    if (deps.activeScenarios && deps.activeScenarios.length > 0) {
      this.scenarios = allScenarios.filter(s => deps.activeScenarios.includes(s.id));
      logger.info(`[${this.symbol}] Active scenarios: ${this.scenarios.map(s => `${s.id}:${s.name}`).join(', ')}`);
    } else {
      this.scenarios = allScenarios;
      logger.info(`[${this.symbol}] All 11 scenarios active (no active scenarios configured)`);
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
      return !mitigatedStructures.some(ms => 
        ms.type === s.type &&
        ms.timestamp === s.timestamp &&
        ms.direction === s.direction
      );
    });
  }

  async evaluate(
    candles15m: any[], 
    candles4h: any[], 
    currentCandleTimestamp: number,
    mitigatedZones: MitigatedZone[] = [],
    mitigatedStructures: MitigatedStructure[] = []
  ): Promise<RouterResult> {
    if (!this.scenarios.length) {
      return { triggered: false, scenario: null, levels: null, reason: 'No scenarios configured', zoneDetails: null, structureDetails: null };
    }

    try {
      const patternData = await this.patternRecognizer.buildPatternData(
        this.symbol,
        candles15m,
        candles4h,
        currentCandleTimestamp
      );

      // Filter out mitigated zones from pattern data
      patternData.zones = this.filterMitigatedZones(patternData.zones, mitigatedZones);
      // Filter out mitigated structures from pattern data
      patternData.structures = this.filterMitigatedStructures(patternData.structures, mitigatedStructures);

      for (const scenario of this.scenarios) {
        try {
          const matches = scenario.evaluate(patternData);
          
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