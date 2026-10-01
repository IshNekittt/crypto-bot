import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { PatternData, MacroContext, Structure } from '../../smc/patternRecognizer';

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
    // Sniper only trades during London or NY killzones
    const currentKillzone = patternData.currentKillzone;
    if (currentKillzone !== 'LONDON' && currentKillzone !== 'NY') {
      this.logRejection(`Outside killzone: ${currentKillzone}`);
      return false;
    }

    // Get current price from latest 1m candle
    const lastCandle1m = candles1m[candles1m.length - 1];

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
    // Check recent 1m candles (last 30-50 min) for sweep of macro level
    // Sweep = wick pierces level, body closes back inside
    const lookbackCandles = candles1m.slice(-50); // Last 50 minutes
    const isResistance = (levelName: string) => levelName === 'PDH' || levelName === 'PWH';
    
    // Find which macro level was swept
    let sweptLevel: { price: Decimal; name: string; direction: 'BULLISH' | 'BEARISH' } | null = null;
    
    for (const level of macroLevels) {
      const resistance = isResistance(level.name);
      const levelPrice = level.price;
      
      if (resistance) {
        // Resistance sweep: wick > level, close < level (bearish sweep for short setup)
        const swept = lookbackCandles.some(c => {
          const high = new Decimal(c.high);
          const close = new Decimal(c.close);
          return high.gt(levelPrice) && close.lt(levelPrice);
        });
        if (swept) {
          sweptLevel = { price: levelPrice, name: level.name, direction: 'BEARISH' };
          break;
        }
      } else {
        // Support sweep: wick < level, close > level (bullish sweep for long setup)
        const swept = lookbackCandles.some(c => {
          const low = new Decimal(c.low);
          const close = new Decimal(c.close);
          return low.lt(levelPrice) && close.gt(levelPrice);
        });
        if (swept) {
          sweptLevel = { price: levelPrice, name: level.name, direction: 'BULLISH' };
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

    // Detect structure breaks and order blocks on 1m candles
    const { structures } = this.detectStructureBreaksAndOBs(candles1m, atr1m);
    
    // Filter out already mitigated structures (ghost signal prevention)
    const mitigatedStructures = (patternData as any).mitigatedStructures || [];
    const isMitigated = (s: Structure) => 
      mitigatedStructures.some((ms: any) => 
        ms.type === s.type && 
        ms.timestamp === s.timestamp && 
        ms.direction === s.direction
      );

    // Filter for fresh CHoCH in the expected direction (after the sweep)
    // Look at last 30 1m candles, and exclude already mitigated structures
    const recentStructures = structures.filter(s => 
      s.type === 'CHOCH' && 
      s.direction === direction &&
      s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0) &&
      !isMitigated(s)
    );

    if (recentStructures.length === 0) {
      this.logRejection(`No ${direction} CHoCH found after sweep of ${sweptLevel.name}`);
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

    // Fallback: if no OB found, use recent local extreme
    if (!entryOB) {
      const recent1m = candles1m.slice(-15);
      if (direction === 'BULLISH') {
        const low = Decimal.min(...recent1m.map(c => new Decimal(c.low)));
        entryOB = { top: low.plus(low.mul('0.001')), bottom: low };
      } else {
        const high = Decimal.max(...recent1m.map(c => new Decimal(c.high)));
        entryOB = { top: high, bottom: high.minus(high.mul('0.001')) };
      }
    }

    // idealEntry = 0.5 of the Order Block (midpoint)
    const idealEntry = entryOB.top.plus(entryOB.bottom).div(2);

    // SL at OB extreme
    const localExtreme = direction === 'BULLISH' ? entryOB.bottom : entryOB.top;

    // Safety check: entry must be on correct side of SL
    if (direction === 'BULLISH' && idealEntry.lte(localExtreme)) {
      this.logRejection('Invalid SL for long');
      return false;
    }
    if (direction === 'BEARISH' && idealEntry.gte(localExtreme)) {
      this.logRejection('Invalid SL for short');
      return false;
    }

    // Use sniper displacement multiplier from config (default 0.5)
    const sniperDispMult = this.config.sniperDisplacementMultiplier 
      ? new Decimal(this.config.sniperDisplacementMultiplier)
      : new Decimal('0.5');
    const offset = Decimal.max(localExtreme.mul(new Decimal('0.0005')), atr1m.mul(sniperDispMult));

    const sl = direction === 'BULLISH'
      ? localExtreme.minus(offset)
      : localExtreme.plus(offset);
    const tp = direction === 'BULLISH'
      ? idealEntry.plus(idealEntry.minus(sl).mul(3))
      : idealEntry.minus(sl.minus(idealEntry).mul(3));

    // Set levels and details
    this.setLevels({
      entry: idealEntry,
      stopLoss: sl,
      takeProfit: tp,
    });

    this.setReason(`Sniper: ${direction} CHoCH at ${chochPrice.toFixed(4)} after ${sweptLevel.name} sweep, entry from 1m OB midpoint`);

    this.setZoneDetails({
      type: 'MITIGATION',
      top: sweptLevel.price,
      bottom: sweptLevel.price,
      timeframe: 'D',
      direction,
      timestamp: lastCandle1m.timestamp,
    });

    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction: choch.direction,
    });

    return true;
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

  // Helper: Detect structure breaks (CHoCH/BOS) AND Order Blocks on 1m candles
  private detectStructureBreaksAndOBs(candles: any[], atr: Decimal): { structures: Structure[]; orderBlocks: { top: Decimal; bottom: Decimal; timestamp: number; direction: 'BULLISH' | 'BEARISH' }[] } {
    const structures: Structure[] = [];
    const orderBlocks: { top: Decimal; bottom: Decimal; timestamp: number; direction: 'BULLISH' | 'BEARISH' }[] = [];
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

    // Detect breaks and OBs
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

          // Create Order Block from the candle BEFORE the break (opposite direction)
          if (i > 0) {
            const obCandle = candles[i - 1];
            const obTop = new Decimal(obCandle.high);
            const obBottom = new Decimal(obCandle.low);
            orderBlocks.push({
              top: obTop,
              bottom: obBottom,
              timestamp: obCandle.timestamp,
              direction: dir,
            });
          }
        }
      }
    }
    return { structures, orderBlocks };
  }
}