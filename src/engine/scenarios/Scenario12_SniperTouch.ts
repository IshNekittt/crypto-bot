import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { PatternData, MacroContext, Structure } from '../../smc/patternRecognizer';
import { logger } from '../../utils/logger';

/** CHoCH / OB must sit within 0.3% of the swept level (or 1 ATR(15m), whichever is wider). */
const MIN_PROXIMITY_PCT = new Decimal('0.003');
/** Synthetic depth for the fallback OB when no opposite-colored candle exists (0.1%). */
const FALLBACK_OB_WIDTH_PCT = new Decimal('0.001');

export class Scenario12_SniperTouch extends BaseScenario {
  constructor(config: BotConfig) {
    super(12, 'Sniper Touch (1m Macro)', config);
  }

  // Override evaluate to accept 1m candles
  override evaluate(patternData: PatternData & { candles1m?: any[] }): boolean {
    const candles1m = patternData.candles1m;
    if (!candles1m || candles1m.length < 50) {
      this.logRejection('Insufficient 1m candles (need 50+)');
      return false;
    }

    // Check if Sniper Mode is enabled in config
    if (!patternData.macroContext || !this.config.enableSniperMode) {
      this.logRejection('Sniper Mode disabled or no macro context');
      return false;
    }

    // === FILTER 1: KILLZONE CHECK ===
    // Sniper only trades during London or NY killzones (bypassable via ENFORCE_KILLZONES=false)
    const currentKillzone = patternData.currentKillzone;
    if (this.config.enforceKillzones !== false && currentKillzone !== 'LONDON' && currentKillzone !== 'NY') {
      this.logRejection(`Outside killzone: ${currentKillzone}`);
      return false;
    }

    // Get macro levels from patternData
    const macro = patternData.macroContext as MacroContext & { dailyLevels: any; weeklyLevels: any };
    const macroLevels: { price: Decimal; name: string }[] = [
      { price: macro.dailyLevels.pdh, name: 'PDH' },
      { price: macro.dailyLevels.pdl, name: 'PDL' },
      { price: macro.weeklyLevels.pwh, name: 'PWH' },
      { price: macro.weeklyLevels.pwl, name: 'PWL' },
    ].filter(l => l.price.gt(0));

    if (macroLevels.length === 0) {
      this.logRejection('No valid macro levels');
      return false;
    }

    // === FILTER 2: SWEEP VALIDATION (SFP - Swing Failure Pattern) ===
    // Check recent 1m candles (last 30-50 min) for sweep of macro level.
    // Sweep = wick pierces level, body closes back inside.
    const lookbackCandles = candles1m.slice(-50); // Last 50 minutes
    const isResistance = (levelName: string) => levelName === 'PDH' || levelName === 'PWH';

    // Find which macro level was swept and WHEN. `sweptAt` is the causality anchor:
    // only structures formed strictly after the latest sweep may trigger an entry.
    let sweptLevel: { price: Decimal; name: string; direction: 'BULLISH' | 'BEARISH' } | null = null;
    let sweptAt = 0;

    for (const level of macroLevels) {
      const resistance = isResistance(level.name);
      const levelPrice = level.price;

      // Scan newest -> oldest: the first hit is the most recent sweep of THIS level.
      for (let i = lookbackCandles.length - 1; i >= 0; i--) {
        const candle = lookbackCandles[i];
        const high = new Decimal(candle.high);
        const low = new Decimal(candle.low);
        const close = new Decimal(candle.close);

        const isSweep = resistance
          ? high.gt(levelPrice) && close.lt(levelPrice)
          : low.lt(levelPrice) && close.gt(levelPrice);

        if (isSweep) {
          // Keep the LATEST sweep across ALL macro levels.
          if (candle.timestamp > sweptAt) {
            sweptAt = candle.timestamp;
            sweptLevel = {
              price: levelPrice,
              name: level.name,
              direction: resistance ? 'BEARISH' : 'BULLISH',
            };
          }
          break;
        }
      }
    }

    if (!sweptLevel) {
      this.logRejection('No valid sweep of macro level in last 50 min');
      return false;
    }

    const direction = sweptLevel.direction;

    // === FILTER 3: VALID CHoCH + ORDER BLOCK ENTRY ===
    // Calculate ATR for 1m candles
    const atr1m = this.calculateATR(candles1m, 14);
    if (atr1m.lte(0)) {
      this.logRejection('Invalid ATR');
      return false;
    }

    // Detect structure breaks on 1m candles
    const structures = this.detectStructureBreaks(candles1m, atr1m);

    // Filter out already mitigated structures (ghost signal prevention)
    const mitigatedStructures = (patternData as any).mitigatedStructures || [];
    const isMitigated = (s: Structure) =>
      mitigatedStructures.some((ms: any) =>
        ms.timestamp === s.timestamp
      );

    // Fresh CHoCH in the expected direction, STRICTLY AFTER the latest sweep.
    // Look at last 30 1m candles, and exclude already mitigated structures.
    const recentStructures = structures.filter(s =>
      s.type === 'CHOCH' &&
      s.direction === direction &&
      s.timestamp > sweptAt &&
      s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0) &&
      !isMitigated(s)
    );

    if (recentStructures.length === 0) {
      this.logRejection(`No ${direction} CHoCH after latest ${sweptLevel.name} sweep`);
      return false;
    }

    // Take the most recent CHoCH
    const choch = recentStructures[recentStructures.length - 1];
    const chochPrice = choch.price;

    // Find the Order Block that triggered this CHoCH
    // OB is the last opposite-direction candle before the CHoCH break
    const chochIndex = candles1m.findIndex(c => c.timestamp === choch.timestamp);
    let entryOB: { top: Decimal; bottom: Decimal } | null = null;

    if (chochIndex > 0) {
      // Look backwards for the OB candle (opposite color to CHoCH direction)
      for (let i = chochIndex - 1; i >= Math.max(0, chochIndex - 5); i--) {
        const c = candles1m[i];
        const isBullishCandle = new Decimal(c.close).gt(c.open);
        const isOB = direction === 'BULLISH' ? !isBullishCandle : isBullishCandle;

        if (isOB) {
          entryOB = {
            top: new Decimal(c.high),
            bottom: new Decimal(c.low),
          };
          break;
        }
      }
    }

    // Fallback: if no OB found, use recent local extreme.
    // Raw Decimals only — no toFixed() precision overrides.
    if (!entryOB) {
      const recent1m = candles1m.slice(-15);
      if (direction === 'BULLISH') {
        const low = Decimal.min(...recent1m.map(c => new Decimal(c.low)));
        entryOB = { top: low.plus(low.mul(FALLBACK_OB_WIDTH_PCT)), bottom: low };
      } else {
        const high = Decimal.max(...recent1m.map(c => new Decimal(c.high)));
        entryOB = { top: high, bottom: high.minus(high.mul(FALLBACK_OB_WIDTH_PCT)) };
      }
    }

    // === FILTER 3.1: SPATIAL PROXIMITY TO THE SWEPT MACRO LEVEL ===
    // The entry OB is the actual POI, so its MIDPOINT (the real entry price) must sit
    // near the liquidity that was just swept. Nearest-edge distance is misleading for
    // wide blocks: an OB can straddle the level while its midpoint is far away.
    // Tolerance = max(1 ATR(15m), 0.3%).
    // The CHoCH close is measured for observability (a strong displacement may
    // close further away while the pullback OB remains at the level).
    const atr15m = this.resolveAtr15m(patternData);
    const proximityTolerance = Decimal.max(atr15m, sweptLevel.price.mul(MIN_PROXIMITY_PCT));
    const chochDistance = chochPrice.minus(sweptLevel.price).abs();
    const obMidpoint = entryOB.top.plus(entryOB.bottom).div(2);
    const obDistance = obMidpoint.minus(sweptLevel.price).abs();

    if (obDistance.gt(proximityTolerance)) {
      this.logRejection(
        `Entry too far from swept ${sweptLevel.name} (${sweptLevel.price.toFixed(4)}): ` +
        `CHoCH=${chochDistance.toFixed(4)}, OB_MID=${obDistance.toFixed(4)}, ` +
        `tolerance=${proximityTolerance.toFixed(4)} (1xATR15m / 0.3%)`
      );
      return false;
    }

    // idealEntry = 0.5 of the Order Block (midpoint)
    const idealEntry = entryOB.top.plus(entryOB.bottom).div(2);

    // Create OB zone for calculateLevels
    const obZone = {
      top: entryOB.top,
      bottom: entryOB.bottom,
      direction: direction,
    };

    // Safety check: entry must be on correct side of zone extreme
    const localExtreme = direction === 'BULLISH' ? entryOB.bottom : entryOB.top;
    if (direction === 'BULLISH' && idealEntry.lte(localExtreme)) {
      this.logRejection('Invalid SL for long');
      return false;
    }
    if (direction === 'BEARISH' && idealEntry.gte(localExtreme)) {
      this.logRejection('Invalid SL for short');
      return false;
    }

    // Use standard calculateLevels from BaseScenario
    const levels = this.calculateLevels(
      idealEntry,
      obZone,
      direction,
      atr1m,
      new Decimal(3), // R:R = 3
      this.config.smcSlAtrOffset ? new Decimal(this.config.smcSlAtrOffset) : new Decimal('0.5')
    );

    // SAFETY NET: Hard mathematical check to prevent invalid SL levels reaching the exchange
    if (direction === 'BULLISH' && levels.stopLoss.gte(levels.entry)) {
      this.logRejection(`Math Error: BULLISH SL (${levels.stopLoss}) >= Entry (${levels.entry})`);
      return false;
    }
    if (direction === 'BEARISH' && levels.stopLoss.lte(levels.entry)) {
      this.logRejection(`Math Error: BEARISH SL (${levels.stopLoss}) <= Entry (${levels.entry})`);
      return false;
    }

    // Set levels and details.
    // NOTE: Scenario 12 intentionally emits ONLY structureDetails (the 1m CHoCH).
    // Emitting a synthetic zone at the macro level would let burnSetup() add the
    // macro pool to mitigatedZones, violating Invariant 21 (macro pools are never burned).
    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    this.setReason(`Sniper: ${direction} CHoCH at ${chochPrice.toFixed(4)} after ${sweptLevel.name} sweep, entry from 1m OB midpoint`);

    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction: choch.direction,
    });

    return true;
  }

  /**
   * Resolve the 15m ATR used for the proximity tolerance.
   *
   * patternData.atr15m is the canonical, router-computed value and MUST be preferred.
   * A local ATR(14) recomputation is only a defensive fallback — it is explicitly
   * logged as such so a missing ATR never silently masquerades as the canonical one.
   */
  private resolveAtr15m(patternData: PatternData): Decimal {
    const provided = patternData.atr15m;
    if (provided instanceof Decimal && provided.gt(0)) {
      return provided;
    }

    logger.warn(
      `[Scenario 12] patternData.atr15m is missing or invalid (${String(provided)}) — ` +
      `FALLBACK ATR will be computed from candles15m. Proximity tolerance may differ from the canonical ATR.`,
    );

    const candles15m = patternData.candles15m;
    if (Array.isArray(candles15m) && candles15m.length >= 15) {
      const atr = this.calculateATR(candles15m, 14);
      if (atr.gt(0)) {
        logger.warn(`[Scenario 12] FALLBACK LTF ATR(14) = ${atr.toString()} used for proximity tolerance.`);
        return atr;
      }
      logger.error(
        `[Scenario 12] FALLBACK ATR(14) computed to ${atr.toString()} from ${candles15m.length} candles — unusable.`,
      );
    } else {
      logger.error(
        `[Scenario 12] FALLBACK ATR unavailable: candles15m has ${Array.isArray(candles15m) ? candles15m.length : 0} candles (need >= 15).`,
      );
    }

    logger.error(
      '[Scenario 12] No usable ATR — proximity tolerance collapses to the 0.3% percentage floor only.',
    );
    return new Decimal(0);
  }

  // Helper: Calculate ATR
  private calculateATR(candles: any[], period: number = 14): Decimal {
    if (candles.length < period + 1) return new Decimal(0);
    let trSum = new Decimal(0);
    for (let i = candles.length - period; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const high = new Decimal(current.high);
      const low = new Decimal(current.low);
      const prevClose = new Decimal(prev.close);
      const tr = Decimal.max(high.minus(low), high.minus(prevClose).abs(), low.minus(prevClose).abs());
      trSum = trSum.plus(tr);
    }
    return trSum.dividedBy(period);
  }

  // Helper: Detect structure breaks (CHoCH/BOS) on 1m candles
  private detectStructureBreaks(candles: any[], atr: Decimal): Structure[] {
    const structures: Structure[] = [];
    const swingLookback = 3;
    const displacementMult = this.config.sniperDisplacementMultiplier
      ? new Decimal(this.config.sniperDisplacementMultiplier)
      : new Decimal('0.5');

    // Find swing points
    const swings: { type: 'HIGH' | 'LOW'; price: Decimal; index: number; timestamp: number }[] = [];
    for (let i = swingLookback; i < candles.length - swingLookback; i++) {
      const high = new Decimal(candles[i].high);
      const low = new Decimal(candles[i].low);
      let isHigh = true, isLow = true;
      for (let j = 1; j <= swingLookback; j++) {
        if (new Decimal(candles[i - j].high).gte(high) || new Decimal(candles[i + j].high).gte(high)) isHigh = false;
        if (new Decimal(candles[i - j].low).lte(low) || new Decimal(candles[i + j].low).lte(low)) isLow = false;
      }
      if (isHigh) swings.push({ type: 'HIGH', price: high, index: i, timestamp: candles[i].timestamp });
      if (isLow) swings.push({ type: 'LOW', price: low, index: i, timestamp: candles[i].timestamp });
    }

    // Detect breaks
    for (let i = 0; i < candles.length; i++) {
      const close = new Decimal(candles[i].close);
      const body = close.minus(candles[i].open).abs();
      const minBody = atr.mul(displacementMult);

      for (const swing of swings) {
        if (swing.index >= i - 3) continue; // Swing must be confirmed (3 candles ago)

        const bullishBreak = swing.type === 'HIGH' && close.gt(swing.price);
        const bearishBreak = swing.type === 'LOW' && close.lt(swing.price);

        if ((bullishBreak || bearishBreak) && body.gte(minBody)) {
          const dir = bullishBreak ? 'BULLISH' : 'BEARISH';
          const type = structures.length > 0 && structures[structures.length - 1].direction === dir ? 'BOS' : 'CHOCH';
          structures.push({
            type,
            direction: dir,
            price: close,
            timestamp: candles[i].timestamp,
            isValidated: true,
            impulseFactor: body.div(atr),
          });
        }
      }
    }

    return structures;
  }
}
