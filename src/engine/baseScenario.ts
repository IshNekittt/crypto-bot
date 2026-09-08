import { IScenario } from '../types';
import { ScenarioLevels } from '../types';
import { ZoneDetails } from '../types';

export abstract class BaseScenario implements IScenario {
  readonly id: number;
  readonly name: string;
  protected levels: ScenarioLevels | null = null;
  protected reason: string = '';
  protected zoneDetails: ZoneDetails | null = null;

  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }

  evaluate(_patternData: any): boolean {
    return false;
  }

  getLevels(): ScenarioLevels {
    return this.levels || { entry: '', stopLoss: '', takeProfit: '' };
  }

  getReason(): string {
    return this.reason;
  }

  getZoneDetails(): ZoneDetails | null {
    return this.zoneDetails;
  }

  protected setLevels(levels: ScenarioLevels): void {
    this.levels = levels;
  }

  protected setReason(reason: string): void {
    this.reason = reason;
  }

  protected setZoneDetails(zone: ZoneDetails): void {
    this.zoneDetails = zone;
  }

  protected logRejection(reason: string): void {
    this.reason = reason;
  }

  protected isInKillzone(patternData: any): boolean {
    return patternData.currentKillzone !== 'NONE';
  }

  protected isValidDisplacement(structure: any, minMultiplier: number = 1.5): boolean {
    return structure.impulseFactor?.gte(minMultiplier) ?? false;
  }

  protected isValidBodyClose(structure: any): boolean {
    return structure.isValidated === true;
  }
}