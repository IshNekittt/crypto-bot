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
    if (!candles1m || candles1m.length < 20) {
      this.logRejection('Insufficient 1m candles');
      return false;
    }

    // Check if Sniper Mode is enabled in config
    if (!patternData.macroContext || !this.config.enableSniperMode) {
      this.logRejection('Sniper Mode disabled or no macro context');
      return false;
    }

    // Get current price from latest 1m candle
    const lastCandle1m = candles1m[candles1m.length - 1];
    const currentPrice = new Decimal(lastCandle1m.close);

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

    // Check if price is within 0.2% of any macro level
    const proximityPct = new Decimal('0.002'); // 0.2%
    let nearestLevel: { price: Decimal; name: string } | null = null;
    let minDistance = new Decimal('Infinity');

    for (const level of macroLevels) {
      const distance = currentPrice.minus(level.price).abs().div(currentPrice);
      if (distance.lte(proximityPct) && distance.lt(minDistance)) {
        minDistance = distance;
        nearestLevel = level;
      }
    }

    if (!nearestLevel) {
      this.logRejection(`Price not near macro level (min dist: ${minDistance.mul(100).toFixed(4)}%)`);
      return false;
    }

    // Determine direction based on which level we're near
    // PDH/PWH = resistance area -> look for bearish CHoCH (short)
    // PDL/PWL = support area -> look for bullish CHoCH (long)
    const isResistance = nearestLevel.name === 'PDH' || nearestLevel.name === 'PWH';
    const direction = isResistance ? 'BEARISH' : 'BULLISH';

    // Calculate ATR for 1m candles
    const atr1m = this.calculateATR(candles1m, 14);
    if (atr1m.lte(0)) {
      this.logRejection('Invalid ATR');
      return false;
    }

    // Detect structure breaks on 1m candles
    const structures = this.detectStructureBreaks(candles1m, atr1m);
    
    // Filter for fresh CHoCH in the expected direction
    // Look at last 30 1m candles (30 minutes)
    const recentStructures = structures.filter(s => 
      s.type === 'CHOCH' && 
      s.direction === direction &&
      s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0)
    );

    if (recentStructures.length === 0) {
      this.logRejection(`No ${direction} CHoCH found near ${nearestLevel.name}`);
      return false;
    }

    // Take the most recent CHoCH
    const choch = recentStructures[recentStructures.length - 1];
    const chochPrice = choch.price;

    // Calculate entry as midpoint of CHoCH impulse
    const impulseStart = choch.price; // CHoCH break price
    const impulseEnd = currentPrice;
    const idealEntry = impulseStart.plus(impulseEnd).div(2);

    // Calculate SL using local extreme from recent 1m candles
    const recent1m = candles1m.slice(-15); // Last 15 minutes
    let localExtreme: Decimal;
    if (direction === 'BULLISH') {
      localExtreme = Decimal.min(...recent1m.map(c => new Decimal(c.low)));
    } else {
      localExtreme = Decimal.max(...recent1m.map(c => new Decimal(c.high)));
    }

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

    this.setReason(`Sniper: ${direction} CHoCH at ${chochPrice.toFixed(4)} near ${nearestLevel.name} (${minDistance.mul(100).toFixed(4)}%)`);

    this.setZoneDetails({
      type: 'MITIGATION',
      top: nearestLevel.price,
      bottom: nearestLevel.price,
      timeframe: 'D',
      direction,
      timestamp: lastCandle1m.timestamp,
    });

    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
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