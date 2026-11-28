import { IScenario, StructureDetails } from '../types';
import { ScenarioLevels } from '../types';
import { ZoneDetails } from '../types';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../config/env';
import { timeframeToMinutes } from '../utils/timeframe';

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
  protected readonly config: BotConfig;

  constructor(id: number, name: string, config: BotConfig) {
    this.id = id;
    this.name = name;
    this.config = config;
  }

  /**
   * Single evaluation entry point for every scenario.
   *
   * Resets per-evaluation state BEFORE delegating to the concrete scenario. A
   * scenario instance is reused for the lifetime of the process (one router per
   * symbol evaluates the same 12 instances), so without this reset a successful
   * evaluation on symbol A could leak `levels` / `zoneDetails` / `structureDetails`
   * into a later evaluation on symbol B that returns true without setting them.
   *
   * Concrete scenarios MUST implement `evaluateInternal()` and MUST NOT override
   * this method — otherwise the reset can be bypassed.
   */
  evaluate(patternData: any): boolean {
    this.levels = null;
    this.zoneDetails = null;
    this.structureDetails = null;

    return this.evaluateInternal(patternData);
  }

  /**
   * Concrete scenario logic (Scenario 1–12). Called only through `evaluate()`.
   */
  protected evaluateInternal(_patternData: any): boolean {
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
    // Global bypass: ENFORCE_KILLZONES=false disables all killzone gates (backtesting use case).
    // Entry filter ONLY — trade management is never affected.
    if (this.config.enforceKillzones === false) return true;
    return patternData.currentKillzone !== 'NONE';
  }

  protected isClassicMode(): boolean {
    return !this.config.enableSniperMode && timeframeToMinutes(this.config.ltfTimeframe) >= 5;
  }

  protected isValidDisplacement(structure: any, minMultiplier: number = 1.5): boolean {
    const factor = structure.impulseFactor;
    return Decimal.isDecimal(factor) && factor.isFinite() && factor.gte(minMultiplier);
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
    offsetMultiplier: Decimal = new Decimal(0.5),
    overrideOffsetMultiplier = false,
  ): TradeLevels {
    // Use config value unless a scenario explicitly requires a fixed, strategy-owned
    // stop geometry (Scenario 14's 2ATR breakout stop). Keeping this opt-in is
    // backward-compatible: all existing callers retain SMC_SL_ATR_OFFSET.
    const effectiveOffsetMultiplier = overrideOffsetMultiplier
      ? offsetMultiplier
      : (this.config?.smcSlAtrOffset
        ? new Decimal(this.config.smcSlAtrOffset)
        : offsetMultiplier);
    
    // Safety: minimum offset = 0.1% of entry (prevents zero offset when ATR is near zero)
    const minOffset = entry.mul(new Decimal('0.001'));
    const atrOffset = atr.mul(effectiveOffsetMultiplier);
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

  /**
   * Calculate trade levels where the take-profit is supplied by market structure
   * instead of being derived from the stop.
   *
   * WHY: `calculateLevels(..., rr)` always returns `TP = entry +/- rr * |entry - SL|`.
   * That target is a restatement of the stop distance — the market is never
   * consulted. Round-trip fees expressed in R units are `f = c / s` (with
   * `s = R / entry`), so a tight stop silently converts a nominal "3R" winner
   * into a loser. The structural target comes from `src/engine/tpResolver.ts`.
   *
   * The stop geometry is still delegated to `calculateLevels()` with `rr = 1`,
   * keeping the 0.1% offset floor and the inverted-zone defense as the single
   * source of truth (Invariant 11). Only the target is replaced.
   *
   * @throws if `takeProfit` is not strictly beyond `entry` in `direction`.
   */
  protected calculateLevelsWithTarget(
    entry: Decimal,
    zone: { top: Decimal; bottom: Decimal; direction: 'BULLISH' | 'BEARISH' },
    direction: 'BULLISH' | 'BEARISH',
    atr: Decimal,
    takeProfit: Decimal,
    offsetMultiplier: Decimal = new Decimal(0.5)
  ): TradeLevels {
    const base = this.calculateLevels(
      entry,
      zone,
      direction,
      atr,
      new Decimal(1),
      offsetMultiplier
    );

    const correctSide =
      direction === 'BULLISH'
        ? takeProfit.gt(base.entry)
        : takeProfit.lt(base.entry);

    if (!correctSide) {
      throw new Error(
        `calculateLevelsWithTarget: take-profit ${takeProfit.toString()} is on the wrong side of entry ${base.entry.toString()} for ${direction}`
      );
    }

    return {
      entry: base.entry,
      stopLoss: base.stopLoss,
      takeProfit,
    };
  }
}
