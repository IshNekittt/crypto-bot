import { IScenario } from '../types';
import { logger } from '../utils/logger';
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
}

export class ScenarioRouter {
  private readonly symbol: string;
  private readonly patternRecognizer: any;
  private readonly _notifier: any;

  get notifier(): any {
    return this._notifier;
  }
  private readonly scenarios: IScenario[];

  constructor(deps: { symbol: string; patternRecognizer: any; notifier: any }) {
    this.symbol = deps.symbol;
    this.patternRecognizer = deps.patternRecognizer;
    this._notifier = deps.notifier;
    this.scenarios = [
      new Scenario1_HTFContinuation(),
      new Scenario2_FVGFill(),
      new Scenario3_IDM(),
      new Scenario4_MitigationChain(),
      new Scenario5_HTFLiquiditySweep(),
      new Scenario6_SMS(),
      new Scenario7_AMD(),
      new Scenario8_RangeDeviationReclaim(),
      new Scenario9_TurtleSoup(),
      new Scenario10_BreakerBlock(),
      new Scenario11_MitigationBlock(),
    ];
  }

  async evaluate(candles15m: any[], candles4h: any[]): Promise<{ triggered: boolean; scenario: IScenario | null; levels: any | null; reason: string }> {
    if (!this.scenarios.length) {
      return { triggered: false, scenario: null, levels: null, reason: 'No scenarios configured' };
    }

    try {
      const patternData = await this.patternRecognizer.buildPatternData(
        this.symbol,
        candles15m,
        candles4h
      );

      for (const scenario of this.scenarios) {
        try {
          const matches = scenario.evaluate(patternData);
          
          if (matches) {
            const levels = scenario.getLevels();
            const reason = scenario.getReason();
            
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
            };
          } else {
            logger.debug(`Scenario ${scenario.name} not matched`, {
              symbol: this.symbol,
              scenario: scenario.name,
            });
          }
        } catch (err) {
          logger.error('Scenario evaluation error', {
            symbol: this.symbol,
            scenario: scenario.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { triggered: false, scenario: null, levels: null, reason: 'No scenario matched' };
    } catch (err) {
      logger.error('Pattern recognition failed', {
        symbol: this.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return { triggered: false, scenario: null, levels: null, reason: 'Pattern recognition error' };
    }
  }
}

export function createScenarioRouter(deps: any): ScenarioRouter {
  return new ScenarioRouter(deps);
}