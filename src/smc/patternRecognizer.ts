import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { BybitClient } from '../api/bybitClient';
import { Candle, Direction, Timeframe } from '../types';
import { logger } from '../utils/logger';

export interface SwingPoint {
  readonly type: 'HIGH' | 'LOW';
  readonly price: Decimal;
  readonly timestamp: number;
  readonly index: number;
  readonly isSwept: boolean;
}

export interface LiquidityPool {
  readonly type: 'BSL' | 'SSL' | 'EQH' | 'EQL' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'DO' | 'WO';
  readonly priceLevel: Decimal;
  readonly points: SwingPoint[];
  readonly isTaken: boolean;
  readonly timestamp: number;
}

export interface Zone {
  readonly type: 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION';
  readonly top: Decimal;
  readonly bottom: Decimal;
  readonly timestamp: number;
  readonly mitigated: boolean;
  readonly timeframe: Timeframe;
  readonly direction: Direction;
}

export interface SessionRange {
  readonly name: 'ASIAN' | 'LONDON' | 'NY';
  readonly high: Decimal;
  readonly low: Decimal;
  readonly start: number;
  readonly end: number;
}

export interface TradingRange {
  readonly high: Decimal;
  readonly low: Decimal;
  readonly equilibrium: Decimal;
  readonly isDeviated: boolean;
}

export interface Structure {
  readonly type: 'BOS' | 'CHOCH' | 'SMS' | 'IDM';
  readonly price: Decimal;
  readonly timestamp: number;
  readonly isValidated: boolean;
  readonly direction: Direction;
}

export interface MacroContext {
  readonly ath: Decimal;
  readonly atl: Decimal;
  readonly htfFvgs: Zone[];
  readonly htfObs: Zone[];
  readonly weeklyLevels: { pwh: Decimal; pwl: Decimal; wo: Decimal };
  readonly dailyLevels: { pdh: Decimal; pdl: Decimal; do: Decimal };
  readonly liquidityPools: LiquidityPool[];
}

export interface Killzone {
  readonly name: 'ASIAN' | 'LONDON' | 'NY';
  readonly startHour: number;
  readonly endHour: number;
}

export interface SessionConfig {
  readonly timezone: string;
  readonly asian: { start: number; end: number };
  readonly london: { start: number; end: number };
  readonly ny: { start: number; end: number };
}

export interface PatternConfig {
  readonly atrPeriod: number;
  readonly displacementMultiplier: Decimal;
  readonly sweepThreshold: Decimal;
  readonly eqThreshold: Decimal;
  readonly fvgMinGapPercent: Decimal;
  readonly equilibriumLevel: Decimal;
  readonly sessionConfig: SessionConfig;
}

export interface PatternData {
  readonly candles15m: Candle[];
  readonly candles4h: Candle[];
  readonly macroContext: MacroContext;
  readonly currentSession: 'ASIAN' | 'LONDON' | 'NY' | 'NONE';
  readonly currentKillzone: 'ASIAN' | 'LONDON' | 'NY' | 'NONE';
  readonly sessionRanges: SessionRange[];
  readonly tradingRange: TradingRange | null;
  readonly liquidityPools: LiquidityPool[];
  readonly structures: Structure[];
  readonly zones: Zone[];
  readonly swingPoints: SwingPoint[];
  readonly atr15m: Decimal;
  readonly atr4h: Decimal;
}

export const DEFAULT_PATTERN_CONFIG: PatternConfig = {
  atrPeriod: 10,
  displacementMultiplier: new Decimal(1.5),
  sweepThreshold: new Decimal('0.0005'),
  eqThreshold: new Decimal('0.0005'),
  fvgMinGapPercent: new Decimal('0.1'),
  equilibriumLevel: new Decimal('0.5'),
  sessionConfig: {
    timezone: 'America/New_York',
    asian: { start: 20, end: 24 },
    london: { start: 2, end: 5 },
    ny: { start: 7, end: 10 },
  },
};

export class PatternRecognizer {
  private readonly client: BybitClient;
  private readonly config: PatternConfig;
  private readonly timezone: string;
  private macroCache: Map<string, MacroContext> = new Map();

  constructor(client: BybitClient, config: Partial<PatternConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };
    this.timezone = this.config.sessionConfig.timezone;
  }

  /**
   * Get current session and killzone based on NY time
   */
  getCurrentSessionAndKillzone(timestamp: number = Date.now()): { session: 'ASIAN' | 'LONDON' | 'NY' | 'NONE'; killzone: 'ASIAN' | 'LONDON' | 'NY' | 'NONE' } {
    const nyTime = DateTime.fromMillis(timestamp).setZone(this.timezone);
    const hour = nyTime.hour;
    const minute = nyTime.minute;
    const timeInMinutes = hour * 60 + minute;

    const asianStart = this.config.sessionConfig.asian.start * 60;
    const asianEnd = this.config.sessionConfig.asian.end * 60;
    const londonStart = this.config.sessionConfig.london.start * 60;
    const londonEnd = this.config.sessionConfig.london.end * 60;
    const nyStart = this.config.sessionConfig.ny.start * 60;
    const nyEnd = this.config.sessionConfig.ny.end * 60;

    let session: 'ASIAN' | 'LONDON' | 'NY' | 'NONE' = 'NONE';
    let killzone: 'ASIAN' | 'LONDON' | 'NY' | 'NONE' = 'NONE';

    // Asian session: 20:00-24:00
    if (timeInMinutes >= asianStart && timeInMinutes < asianEnd) {
      session = 'ASIAN';
      killzone = 'ASIAN';
    }
    // London session: 02:00-05:00
    else if (timeInMinutes >= londonStart && timeInMinutes < londonEnd) {
      session = 'LONDON';
      killzone = 'LONDON';
    }
    // NY session: 07:00-10:00
    else if (timeInMinutes >= nyStart && timeInMinutes < nyEnd) {
      session = 'NY';
      killzone = 'NY';
    }

    return { session, killzone };
  }

  /**
   * Check if current time is in an active killzone
   */
  isInKillzone(timestamp: number = Date.now()): boolean {
    const { killzone } = this.getCurrentSessionAndKillzone(timestamp);
    return killzone !== 'NONE';
  }

  /**
   * Calculate ATR using decimal.js
   */
  calculateATR(candles: Candle[], period: number = 14): Decimal {
    if (candles.length < period + 1) {
      return new Decimal(0);
    }

    let trSum = new Decimal(0);
    for (let i = candles.length - period; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const high = new Decimal(current.high);
      const low = new Decimal(current.low);
      const prevClose = new Decimal(prev.close);

      const tr1 = high.minus(low);
      const tr2 = high.minus(prevClose).abs();
      const tr3 = low.minus(prevClose).abs();

      const tr = Decimal.max(tr1, tr2, tr3);
      trSum = trSum.plus(tr);
    }

    return trSum.dividedBy(period);
  }

  /**
   * Find swing points (highs and lows) using 3-candle confirmation
   */
  findSwingPoints(candles: Candle[], lookback: number = 3): SwingPoint[] {
    const swings: SwingPoint[] = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
      const current = candles[i];
      const isHigh = this.isSwingHigh(candles, i, lookback);
      const isLow = this.isSwingLow(candles, i, lookback);

      if (isHigh) {
        swings.push({
          type: 'HIGH',
          price: new Decimal(current.high),
          timestamp: current.timestamp,
          index: i,
          isSwept: false,
        });
      } else if (isLow) {
        swings.push({
          type: 'LOW',
          price: new Decimal(current.low),
          timestamp: current.timestamp,
          index: i,
          isSwept: false,
        });
      }
    }

    return swings;
  }

  private isSwingHigh(candles: Candle[], index: number, lookback: number): boolean {
    const currentHigh = new Decimal(candles[index].high);
    for (let offset = 1; offset <= lookback; offset++) {
      if (new Decimal(candles[index - offset].high).greaterThanOrEqualTo(currentHigh)) return false;
      if (new Decimal(candles[index + offset].high).greaterThanOrEqualTo(currentHigh)) return false;
    }
    return true;
  }

  private isSwingLow(candles: Candle[], index: number, lookback: number): boolean {
    const currentLow = new Decimal(candles[index].low);
    for (let offset = 1; offset <= lookback; offset++) {
      if (new Decimal(candles[index - offset].low).lessThanOrEqualTo(currentLow)) return false;
      if (new Decimal(candles[index + offset].low).lessThanOrEqualTo(currentLow)) return false;
    }
    return true;
  }

  /**
   * Detect BOS/CHoCH with Displacement (> 1.5 * ATR)
   */
  detectStructureBreaks(candles: Candle[], atr: Decimal): Structure[] {
    const structures: Structure[] = [];
    let lastValidSwing: SwingPoint | null = null;
    let trend: Direction | null = null;

    for (let i = 0; i < candles.length; i++) {
      // Update last valid swing (confirmed 3 candles ago)
      if (i >= 3) {
        const checkIndex = i - 3;
        const highSwings = this.findSwingPoints(candles.slice(0, checkIndex + 1)).filter(s => s.type === 'HIGH');
        const lowSwings = this.findSwingPoints(candles.slice(0, checkIndex + 1)).filter(s => s.type === 'LOW');

        if (highSwings.length > 0) lastValidSwing = highSwings[highSwings.length - 1];
        if (lowSwings.length > 0 && (!lastValidSwing || lowSwings[lowSwings.length - 1].index > lastValidSwing.index)) {
          lastValidSwing = lowSwings[lowSwings.length - 1];
        }
      }

      if (!lastValidSwing) continue;

      const candle = candles[i];
      const close = new Decimal(candle.close);
      const body = new Decimal(candle.close).minus(candle.open).abs();
      const minBody = atr.mul(this.config.displacementMultiplier);

      // Bullish break: close > swing high with displacement
      if (lastValidSwing.type === 'HIGH' && close.greaterThan(lastValidSwing.price) && body.greaterThanOrEqualTo(minBody)) {
        const direction: Direction = 'BULLISH';
        const type = trend === 'BULLISH' ? 'BOS' : 'CHOCH';
        trend = 'BULLISH';
        structures.push({
          type,
          price: close,
          timestamp: candles[i].timestamp,
          isValidated: true,
          direction,
        });
        lastValidSwing = null; // Reset after valid break
      }
      // Bearish break: close < swing low with displacement
      else if (lastValidSwing.type === 'LOW' && close.lessThan(lastValidSwing.price) && body.greaterThanOrEqualTo(minBody)) {
        const direction: Direction = 'BEARISH';
        const type = trend === 'BEARISH' ? 'BOS' : 'CHOCH';
        trend = 'BEARISH';
        structures.push({
          type,
          price: close,
          timestamp: candles[i].timestamp,
          isValidated: true,
          direction,
        });
        lastValidSwing = null;
      }
    }

    return structures;
  }

  /**
   * Detect FVGs (Fair Value Gaps)
   */
  detectFVGs(candles: Candle[]): Zone[] {
    const fvgs: Zone[] = [];

    for (let i = 2; i < candles.length; i++) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1];
      const c3 = candles[i];

      // Bullish FVG: gap between c1 high and c3 low
      const bullGap = new Decimal(c3.low).minus(c1.high);
      const refPrice = new Decimal(c2.close);
      if (bullGap.gt(0) && bullGap.div(refPrice).mul(100).gte(this.config.fvgMinGapPercent)) {
        fvgs.push({
          type: 'FVG',
          direction: 'BULLISH',
          top: new Decimal(c3.low),
          bottom: new Decimal(c1.high),
          timestamp: c1.timestamp,
          mitigated: false,
          timeframe: '15', // will be set by caller
        });
      }

      // Bearish FVG: gap between c1 low and c3 high
      const bearGap = new Decimal(c1.low).minus(c3.high);
      if (bearGap.gt(0) && bearGap.div(refPrice).mul(100).gte(this.config.fvgMinGapPercent)) {
        fvgs.push({
          type: 'FVG',
          direction: 'BEARISH',
          top: new Decimal(c1.low),
          bottom: new Decimal(c3.high),
          timestamp: c1.timestamp,
          mitigated: false,
          timeframe: '15',
        });
      }
    }

    return fvgs;
  }

  /**
   * Detect Order Blocks
   */
  detectOrderBlocks(candles: Candle[], breaks: Structure[]): Zone[] {
    const obs: Zone[] = [];

    for (const br of breaks) {
      // Find the last opposite candle before the break
      let obIndex = -1;
      for (let i = br.timestamp; i >= 0; i--) {
        const candleIdx = candles.findIndex(c => c.timestamp === br.timestamp) - 1;
        if (candleIdx < 0) break;

        const isBullishCandle = new Decimal(candles[candleIdx].close).gt(candles[candleIdx].open);
        const targetBullish = br.direction === 'BEARISH';

        if (isBullishCandle === targetBullish) {
          obIndex = candleIdx;
          break;
        }
      }

      if (obIndex >= 0) {
        const obCandle = candles[obIndex];
        const direction: Direction = br.direction === 'BULLISH' ? 'BULLISH' : 'BEARISH';
        obs.push({
          type: 'OB',
          direction,
          top: new Decimal(obCandle.high),
          bottom: new Decimal(obCandle.low),
          timestamp: obCandle.timestamp,
          mitigated: false,
          timeframe: '15',
        });
      }
    }

    return obs;
  }

  /**
   * Detect PDH/PDL from daily candles
   */
  detectDailyLevels(dailyCandles: Candle[]): { pdh: Decimal; pdl: Decimal; do: Decimal } {
    if (dailyCandles.length === 0) {
      return { pdh: new Decimal(0), pdl: new Decimal(0), do: new Decimal(0) };
    }
    const last = dailyCandles[dailyCandles.length - 1];
    const prev = dailyCandles[dailyCandles.length - 2] || last;

    return {
      pdh: new Decimal(prev.high),
      pdl: new Decimal(prev.low),
      do: new Decimal(last.open),
    };
  }

  /**
   * Detect weekly levels
   */
  detectWeeklyLevels(weeklyCandles: Candle[]): { pwh: Decimal; pwl: Decimal; wo: Decimal } {
    if (weeklyCandles.length === 0) {
      return { pwh: new Decimal(0), pwl: new Decimal(0), wo: new Decimal(0) };
    }
    const last = weeklyCandles[weeklyCandles.length - 1];
    const prev = weeklyCandles[weeklyCandles.length - 2] || last;

    return {
      pwh: new Decimal(prev.high),
      pwl: new Decimal(prev.low),
      wo: new Decimal(last.open),
    };
  }

  /**
   * Detect EQH/EQL (equal highs/lows within 0.05%)
   */
  detectEqualLevels(candles: Candle[]): { eqh: Decimal[]; eql: Decimal[] } {
    const highs: { price: Decimal; index: number }[] = [];
    const lows: { price: Decimal; index: number }[] = [];

    for (let i = 0; i < candles.length; i++) {
      highs.push({ price: new Decimal(candles[i].high), index: i });
      lows.push({ price: new Decimal(candles[i].low), index: i });
    }

    const eqh: Decimal[] = [];
    const eql: Decimal[] = [];

    for (let i = 0; i < highs.length; i++) {
      for (let j = i + 1; j < highs.length; j++) {
        const diff = highs[i].price.minus(highs[j].price).abs().div(highs[i].price);
        if (diff.lte(this.config.eqThreshold)) {
          eqh.push(highs[i].price);
        }
      }
    }

    for (let i = 0; i < lows.length; i++) {
      for (let j = i + 1; j < lows.length; j++) {
        const diff = lows[i].price.minus(lows[j].price).abs().div(lows[i].price);
        if (diff.lte(this.config.eqThreshold)) {
          eql.push(lows[i].price);
        }
      }
    }

    return { eqh, eql };
  }

  /**
   * Detect IDM (Inducement) - local extreme before true OB
   */
  detectIDM(candles: Candle[], obs: Zone[]): { idm: Decimal; trueOB: Zone } | null {
    // Find local extremes that are NOT the true OB
    // IDM is a local extreme that gets swept before the true OB is tested
    const sweeps = this.detectSweeps(candles);
    for (const sweep of sweeps) {
      // Check if there's a valid OB beyond the sweep
      const trueOB = obs.find(ob =>
        (sweep.direction === 'BEARISH' && ob.direction === 'BULLISH' && ob.bottom.lt(sweep.price)) ||
        (sweep.direction === 'BULLISH' && ob.direction === 'BEARISH' && ob.top.gt(sweep.price))
      );
      if (trueOB) {
        return { idm: sweep.price, trueOB };
      }
    }
    return null;
  }

  /**
   * Detect sweeps (wicks beyond level, close back inside)
   */
  detectSweeps(candles: Candle[]): { price: Decimal; direction: Direction; timestamp: number }[] {
    const sweeps: { price: Decimal; direction: Direction; timestamp: number }[] = [];
    const swings = this.findSwingPoints(candles);

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const high = new Decimal(candle.high);
      const low = new Decimal(candle.low);
      const close = new Decimal(candle.close);

      for (const swing of swings) {
        if (swing.type === 'HIGH' && high.gt(swing.price) && close.lt(swing.price)) {
          sweeps.push({ price: swing.price, direction: 'BEARISH', timestamp: candles[i].timestamp });
        } else if (swing.type === 'LOW' && low.lt(swing.price) && close.gt(swing.price)) {
          sweeps.push({ price: swing.price, direction: 'BULLISH', timestamp: candles[i].timestamp });
        }
      }
    }

    return sweeps;
  }

  /**
   * Detect SMS (Smart Money Shift) - failure to make new high/low
   */
  detectSMS(candles: Candle[]): Structure | null {
    const swings = this.findSwingPoints(candles);
    const highs = swings.filter(s => s.type === 'HIGH');
    const lows = swings.filter(s => s.type === 'LOW');

    // Bearish SMS: failure to make higher high, then CHoCH down
    if (highs.length >= 2) {
      const lastHigh = highs[highs.length - 1];
      const prevHigh = highs[highs.length - 2];
      if (lastHigh.price.lte(prevHigh.price)) {
        // Check for subsequent CHoCH down
        const lastCandle = candles[candles.length - 1];
        const close = new Decimal(lastCandle.close);
        if (close.lt(lastHigh.price)) {
          return {
            type: 'SMS',
            direction: 'BEARISH',
            price: lastHigh.price,
            timestamp: candles[candles.length - 1].timestamp,
            isValidated: true,
          };
        }
      }
    }

    // Bullish SMS: failure to make lower low, then CHoCH up
    if (lows.length >= 2) {
      const lastLow = lows[lows.length - 1];
      const prevLow = lows[lows.length - 2];
      if (lastLow.price.gte(prevLow.price)) {
        const lastCandle = candles[candles.length - 1];
        const close = new Decimal(lastCandle.close);
        if (close.gt(lastLow.price)) {
          return {
            type: 'SMS',
            direction: 'BULLISH',
            price: lastLow.price,
            timestamp: candles[candles.length - 1].timestamp,
            isValidated: true,
          };
        }
      }
    }

    return null;
  }

  /**
   * Calculate Fibonacci 0.5 (Equilibrium) and Premium/Discount
   */
  calculateEquilibrium(high: Decimal, low: Decimal): Decimal {
    return high.plus(low).dividedBy(2);
  }

  getPremiumDiscount(price: Decimal, high: Decimal, low: Decimal): { zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'; equilibrium: Decimal } {
    const eq = this.calculateEquilibrium(high, low);
    let zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';

    if (price.gt(eq)) zone = 'PREMIUM';
    else if (price.lt(eq)) zone = 'DISCOUNT';
    else zone = 'EQUILIBRIUM';

    return { zone, equilibrium: eq };
  }

  /**
   * Calculate FVG 0.5 entry level
   */
  getFVGEntryLevel(fvg: Zone): Decimal {
    return fvg.top.plus(fvg.bottom).dividedBy(2);
  }

  /**
   * Calculate OB 0.5 entry level
   */
  getOBEntryLevel(ob: Zone): Decimal {
    return ob.top.plus(ob.bottom).dividedBy(2);
  }

  /**
   * Detect Trading Range (consolidation zone) with Range High, Range Low, and Equilibrium
   * A range is valid when price respects RH/RL multiple times without breaking structure
   */
  detectTradingRange(candles: Candle[], lookback: number = 50): TradingRange | null {
    if (candles.length < lookback) return null;

    const recentCandles = candles.slice(-lookback);
    
    // Find swing highs and lows in the lookback period
    const swings = this.findSwingPoints(recentCandles, 3);
    const highs = swings.filter(s => s.type === 'HIGH');
    const lows = swings.filter(s => s.type === 'LOW');

    if (highs.length < 2 || lows.length < 2) return null;

    // Range High = highest swing high that was tested at least 2 times
    // Range Low = lowest swing low that was tested at least 2 times
    let rangeHigh = new Decimal(0);
    let rangeLow = new Decimal('Infinity');

    // Check for equal highs (EQH) - multiple tests of similar level
    for (let i = 0; i < highs.length; i++) {
      let testCount = 1;
      for (let j = i + 1; j < highs.length; j++) {
        const diff = highs[i].price.minus(highs[j].price).abs().div(highs[i].price);
        if (diff.lte(this.config.eqThreshold)) {
          testCount++;
        }
      }
      if (testCount >= 2 && highs[i].price.gt(rangeHigh)) {
        rangeHigh = highs[i].price;
      }
    }

    // Check for equal lows (EQL) - multiple tests of similar level
    for (let i = 0; i < lows.length; i++) {
      let testCount = 1;
      for (let j = i + 1; j < lows.length; j++) {
        const diff = lows[i].price.minus(lows[j].price).abs().div(lows[i].price);
        if (diff.lte(this.config.eqThreshold)) {
          testCount++;
        }
      }
      if (testCount >= 2 && lows[i].price.lt(rangeLow)) {
        rangeLow = lows[i].price;
      }
    }

    // If no clear EQH/EQL, use the extreme swing points
    if (rangeHigh.eq(0)) {
      rangeHigh = highs.reduce((max, s) => s.price.gt(max) ? s.price : max, new Decimal(0));
    }
    if (rangeLow.eq('Infinity')) {
      rangeLow = lows.reduce((min, s) => s.price.lt(min) ? s.price : min, new Decimal('Infinity'));
    }

    // Validate range: price must be contained within RH/RL
    const lastCandles = candles.slice(-20);
    let contained = true;
    for (const c of lastCandles) {
      if (new Decimal(c.high).gt(rangeHigh) || new Decimal(c.low).lt(rangeLow)) {
        contained = false;
        break;
      }
    }

    if (!contained) return null;

    const equilibrium = rangeHigh.plus(rangeLow).dividedBy(2);
    const rangeSize = rangeHigh.minus(rangeLow);
    
    // Range must have reasonable size (not too tight)
    const avgPrice = rangeHigh.plus(rangeLow).dividedBy(2);
    if (rangeSize.div(avgPrice).mul(100).lt(new Decimal('0.5'))) return null; // less than 0.5% range

    // Check for deviation - price recently poked outside RH or RL
    const lastCandle = candles[candles.length - 1];
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);
    
    const isDeviated = lastHigh.gt(rangeHigh) || lastLow.lt(rangeLow);

    return {
      high: rangeHigh,
      low: rangeLow,
      equilibrium,
      isDeviated,
    };
  }

  /**
   * Initialize macro context: fetch 1W and 1D candles, find ATH/ATL, POIs
   */
  async initializeMacroContext(symbol: string, macroCandles: number): Promise<MacroContext> {
    const cacheKey = `${symbol}_macro`;
    if (this.macroCache.has(cacheKey)) {
      return this.macroCache.get(cacheKey)!;
    }

    logger.info(`Initializing macro context for ${symbol}...`);

    // Fetch 1W and 1D candles
    const [weeklyCandles, dailyCandles] = await Promise.all([
      this.client.getKlines(symbol, 'W', macroCandles),
      this.client.getKlines(symbol, 'D', macroCandles),
    ]);

    // Find ATH/ATL
    let ath = new Decimal(0);
    let atl = new Decimal('Infinity');
    for (const c of [...weeklyCandles, ...dailyCandles]) {
      const high = new Decimal(c.high);
      const low = new Decimal(c.low);
      if (high.gt(ath)) ath = high;
      if (low.lt(atl)) atl = low;
    }

    // Daily levels
    const dailyLevels = this.detectDailyLevels(dailyCandles);
    // Weekly levels
    const weeklyLevels = this.detectWeeklyLevels(weeklyCandles);

    // HTF FVGs and OBs from daily/weekly
    const htfFvgs = [...this.detectFVGs(dailyCandles), ...this.detectFVGs(weeklyCandles)];
    const htfStructures = this.detectStructureBreaks(dailyCandles, new Decimal(0));
    const htfObs = this.detectOrderBlocks(dailyCandles, htfStructures);

    // Equal highs/lows
    const equalLevels = this.detectEqualLevels(dailyCandles);

    // Build liquidity pools
    const liquidityPools: LiquidityPool[] = [];

    // BSL/SSL from daily highs/lows
    for (const c of dailyCandles) {
      liquidityPools.push({
        type: 'BSL',
        priceLevel: new Decimal(c.high),
        points: [],
        isTaken: false,
        timestamp: c.timestamp,
      });
      liquidityPools.push({
        type: 'SSL',
        priceLevel: new Decimal(c.low),
        points: [],
        isTaken: false,
        timestamp: c.timestamp,
      });
    }

    // Add PDH/PDL, PWH/PWL, DO/WO as liquidity pools
    liquidityPools.push({ type: 'PDH', priceLevel: dailyLevels.pdh, points: [], isTaken: false, timestamp: Date.now() });
    liquidityPools.push({ type: 'PDL', priceLevel: dailyLevels.pdl, points: [], isTaken: false, timestamp: Date.now() });
    liquidityPools.push({ type: 'PWH', priceLevel: weeklyLevels.pwh, points: [], isTaken: false, timestamp: Date.now() });
    liquidityPools.push({ type: 'PWL', priceLevel: weeklyLevels.pwl, points: [], isTaken: false, timestamp: Date.now() });
    liquidityPools.push({ type: 'DO', priceLevel: dailyLevels.do, points: [], isTaken: false, timestamp: Date.now() });
    liquidityPools.push({ type: 'WO', priceLevel: weeklyLevels.wo, points: [], isTaken: false, timestamp: Date.now() });

    // EQH/EQL as liquidity
    for (const eqh of equalLevels.eqh) {
      liquidityPools.push({ type: 'EQH', priceLevel: eqh, points: [], isTaken: false, timestamp: Date.now() });
    }
    for (const eql of equalLevels.eql) {
      liquidityPools.push({ type: 'EQL', priceLevel: eql, points: [], isTaken: false, timestamp: Date.now() });
    }

    const macro: MacroContext = {
      ath,
      atl,
      htfFvgs,
      htfObs,
      weeklyLevels,
      dailyLevels,
      liquidityPools,
    };

    this.macroCache.set(cacheKey, macro);
    logger.info(`Macro context initialized for ${symbol}: ATH=${ath.toFixed(2)}, ATL=${atl.toFixed(2)}`);
    return macro;
  }

  /**
   * Build complete pattern data for a symbol
   */
  async buildPatternData(symbol: string, ltfCandles: Candle[], htfCandles: Candle[]): Promise<PatternData> {
    // Get macro context
    const macroContext = await this.initializeMacroContext(symbol, this.config.atrPeriod * 10);

    // Calculate ATRs
    const atr15m = this.calculateATR(ltfCandles, this.config.atrPeriod);
    const atr4h = this.calculateATR(htfCandles, this.config.atrPeriod);

    // Current session and killzone
    const { session, killzone } = this.getCurrentSessionAndKillzone();

    // Session ranges (simplified - would need proper session detection)
    const sessionRanges: SessionRange[] = [];

    // Find swing points
    const swingPoints15m = this.findSwingPoints(ltfCandles);
    const swingPoints4h = this.findSwingPoints(htfCandles);

    // Detect structures
    const structures15m = this.detectStructureBreaks(ltfCandles, atr15m);
    const structures4h = this.detectStructureBreaks(htfCandles, atr4h);

    // Detect Trading Range on 15m
    const tradingRange = this.detectTradingRange(ltfCandles);

    return {
      candles15m: ltfCandles,
      candles4h: htfCandles,
      macroContext,
      currentSession: session,
      currentKillzone: killzone,
      sessionRanges,
      tradingRange,
      liquidityPools: macroContext.liquidityPools,
      structures: [...structures15m, ...structures4h],
      zones: [
        ...this.detectFVGs(ltfCandles).map(f => ({ ...f, timeframe: '15' as Timeframe })),
        ...this.detectFVGs(htfCandles).map(f => ({ ...f, timeframe: '240' as Timeframe })),
        ...this.detectOrderBlocks(ltfCandles, structures15m).map(o => ({ ...o, timeframe: '15' as Timeframe })),
        ...this.detectOrderBlocks(htfCandles, structures4h).map(o => ({ ...o, timeframe: '240' as Timeframe })),
      ],
      swingPoints: [...swingPoints15m, ...swingPoints4h],
      atr15m,
      atr4h,
    };
  }
}

export function createPatternRecognizer(client: BybitClient, config: Partial<PatternConfig> = {}): PatternRecognizer {
  return new PatternRecognizer(client, config);
}