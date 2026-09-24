import { IScenario, StructureDetails } from '../types';
import { ScenarioLevels } from '../types';
import { ZoneDetails } from '../types';
import { Decimal } from 'decimal.js';

export interface Zone {
  type: string;
  direction: 'BULLISH' | 'BEARISH';
  top: Decimal;
  bottom: Decimal;
  timestamp: number;
  mitigated: boolean;
  timeframe: string;
}

export interface TradeLevels {
  entry: Decimal;
  stopLoss: Decimal;
  takeProfit: Decimal;
}

export abstract class BaseScenario implements IScenario {
  readonly id: number;
  readonly name: string;
  protected levels: ScenarioLevels | null = null;
  protected reason: string = '';
  protected zoneDetails: ZoneDetails | null = null;
  protected structureDetails: StructureDetails | null = null;

  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }

  evaluate(_patternData: any): boolean {
    return false;
  }

  getLevels(): ScenarioLevels {
    return this.levels || { entry: new Decimal(0), stopLoss: new Decimal(0), takeProfit: new Decimal(0) };
  }

  getReason(): string {
    return this.reason;
  }

  getZoneDetails(): ZoneDetails | null {
    return this.zoneDetails;
  }

  getStructureDetails(): StructureDetails | null {
    return this.structureDetails;
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

  protected setStructureDetails(structure: StructureDetails): void {
    this.structureDetails = structure;
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

  /**
   * Calculate trade levels (entry, SL, TP) from zone and entry price
   * This method can be called directly for testing without triggering full evaluate()
   */
  public calculateLevels(
    entry: Decimal,
    zone: { top: Decimal; bottom: Decimal; direction: 'BULLISH' | 'BEARISH' },
    direction: 'BULLISH' | 'BEARISH',
    atr: Decimal,
    rr: Decimal = new Decimal(3),
    offsetMultiplier: Decimal = new Decimal(0.5)
  ): TradeLevels {
    // Safety: minimum offset = 0.1% of entry (prevents zero offset when ATR is near zero)
    const minOffset = entry.mul(new Decimal('0.001'));
    const atrOffset = atr.mul(offsetMultiplier);
    const offset = Decimal.max(atrOffset, minOffset);
    
    // CRITICAL: Ensure SL is on correct side of Entry regardless of zone top/bottom convention
    // Use min/max of ALL THREE (top, bottom, entry) to handle inverted zones safely
    // BULLISH (Long): SL must be BELOW entry. Use min(zone.top, zone.bottom, entry) - offset
    // BEARISH (Short): SL must be ABOVE entry. Use max(zone.top, zone.bottom, entry) + offset
    const sl = direction === 'BULLISH'
      ? Decimal.min(zone.top, zone.bottom, entry).minus(offset)
      : Decimal.max(zone.top, zone.bottom, entry).plus(offset);
    const tp = direction === 'BULLISH'
      ? entry.plus(entry.minus(sl).mul(rr))
      : entry.minus(sl.minus(entry).mul(rr));

    return { entry, stopLoss: sl, takeProfit: tp };
  }
}