import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { timeframeToMinutes } from '../utils/timeframe';
import { BybitClient } from '../api/bybitClient';
import { Candle, Direction, Timeframe, MitigatedZone, MitigatedStructure } from '../types';
import { logger } from '../utils/logger';

export interface SwingPoint {
  readonly type: 'HIGH' | 'LOW';
  readonly price: Decimal;
  readonly timestamp: number;
  readonly index: number;
  readonly isSwept: boolean;
}

const SWING_CONFIRMATION_BARS = 3;

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
  readonly impulseFactor?: Decimal;
  /**
   * Origin timeframe of the structure ('15' for LTF, '240' for HTF).
   * Tagged when structures are merged in `buildPatternData`; detection itself
   * is timeframe-agnostic. Scenarios MUST tag/filter on this to distinguish
   * 15m structure from 4H structure — without it every HTF filter is dead code.
   */
  readonly timeframe?: string;
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
  readonly ltfTimeframe: Timeframe;
  readonly htfTimeframe: Timeframe;
  readonly atrPeriod: number;
  readonly displacementMultiplier: Decimal;
  readonly sweepThreshold: Decimal;
  readonly eqThreshold: Decimal;
  readonly fvgMinGapPercent: Decimal;
  readonly equilibriumLevel: Decimal;
  readonly sessionConfig: SessionConfig;
  readonly bollingerPeriod: number;
  readonly bollingerStdDev: number;
  readonly bollingerSqueezePercentile: number; // e.g., 20 = bottom 20%
  readonly bollingerSqueezeLookback: number;  // e.g., 100 candles for percentile
  readonly rangeLookback: number;             // e.g., 30 candles for range extremes
  readonly wickRatioThreshold: Decimal;       // e.g., 0.4 = 40% wick
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
  structures: Structure[];
  zones: Zone[];
  readonly swingPoints: SwingPoint[];
  readonly atr15m: Decimal;
  readonly atrPeriod?: number;
  readonly atr4h: Decimal;
  readonly patternRecognizer: 'PatternRecognizer';
  candles1m?: Candle[];
  mitigatedZones?: MitigatedZone[];
  mitigatedStructures?: MitigatedStructure[];
}

export const DEFAULT_PATTERN_CONFIG: PatternConfig = {
  ltfTimeframe: '15',
  htfTimeframe: '240',
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
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  bollingerSqueezePercentile: 20,   // bottom 20% of bandwidth values
  bollingerSqueezeLookback: 100,    // lookback for percentile calculation
  rangeLookback: 30,                // candles for range extremes
  wickRatioThreshold: new Decimal('0.4'), // 40% wick requirement
};

export function createPatternConfigFromBotConfig(botConfig: { smcDisplacementMultiplier: string; ltfTimeframe: Timeframe; htfTimeframe: Timeframe }): Partial<PatternConfig> {
  return {
    ltfTimeframe: botConfig.ltfTimeframe,
    htfTimeframe: botConfig.htfTimeframe,
    displacementMultiplier: new Decimal(botConfig.smcDisplacementMultiplier),
  };
}

/** Simple mean of true ranges, including gaps to the preceding close. */
export function calculateATR(candles: Candle[], period = DEFAULT_PATTERN_CONFIG.atrPeriod): Decimal {
  if (candles.length <= period || !Number.isInteger(period) || period <= 0) return new Decimal(0);
  let sum = new Decimal(0);
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = new Decimal(candles[i].high);
    const low = new Decimal(candles[i].low);
    const prevClose = candles[i - 1].close;
    sum = sum.plus(Decimal.max(high.minus(low), high.minus(prevClose).abs(), low.minus(prevClose).abs()));
  }
  return sum.div(period);
}

/** For each index, extremes strictly after it and before the trigger bar. */
function followingExtremes(candles: Candle[]) {
  const highs: Decimal[] = [];
  const lows: Decimal[] = [];
  let high = new Decimal('-Infinity');
  let low = new Decimal('Infinity');
  for (let i = candles.length - 2; i >= 0; i--) {
    highs[i] = high;
    lows[i] = low;
    high = Decimal.max(high, candles[i].high);
    low = Decimal.min(low, candles[i].low);
  }
  return { highs, lows };
}

/** The cached macro anchors remain reusable by Sniper. Only the evaluation
 * snapshot marks previous-day/week liquidity crossed during the current period. */
function evaluatedMacroPools(pools: LiquidityPool[], ltf: Candle[], htf: Candle[]): LiquidityPool[] {
  if (!pools.length || !ltf.length) return pools;
  const period = DateTime.fromMillis(ltf[ltf.length - 1].timestamp, { zone: 'utc' });
  const dayStart = period.startOf('day').toMillis();
  const weekStart = period.startOf('week').toMillis();
  let dayHigh = new Decimal('-Infinity');
  let weekHigh = dayHigh;
  let dayLow = new Decimal('Infinity');
  let weekLow = dayLow;
  // The HTF window covers days outside the shorter LTF history. Exclude its
  // final bar too; the LTF history supplies the safe part of that interval.
  for (const candles of [htf, ltf]) {
    for (let i = candles.length - 2; i >= 0; i--) {
      const candle = candles[i];
      if (candle.timestamp < weekStart) break;
      weekHigh = Decimal.max(weekHigh, candle.high);
      weekLow = Decimal.min(weekLow, candle.low);
      if (candle.timestamp >= dayStart) {
        dayHigh = Decimal.max(dayHigh, candle.high);
        dayLow = Decimal.min(dayLow, candle.low);
      }
    }
  }
  return pools.map(pool => {
    let pierced: boolean;
    switch (pool.type) {
      case 'PDH': pierced = dayHigh.gt(pool.priceLevel); break;
      case 'PDL': pierced = dayLow.lt(pool.priceLevel); break;
      case 'PWH': pierced = weekHigh.gt(pool.priceLevel); break;
      case 'PWL': pierced = weekLow.lt(pool.priceLevel); break;
      default: return pool;
    }
    return pierced && !pool.isTaken ? { ...pool, isTaken: true } : pool;
  });
}

interface FormedZone extends Zone {
  formedAt: number;
  mitigated: boolean;
}

/** Walk backward so each query sees only bars after formation, excluding the trigger. */
function markMitigatedZones(candles: Candle[], formations: FormedZone[]): Zone[] {
  if (formations.length === 0) return [];
  const prices = new Set(candles.map(c => new Decimal(c.high).toString()));
  for (const zone of formations) prices.add(zone.top.toString());
  const highs = [...prices].map(price => new Decimal(price)).sort((a, b) => b.cmp(a));
  const rank = new Map(highs.map((price, i) => [price.toString(), i + 1]));
  // Fenwick prefix minimum on descending highs: among candles reaching the
  // zone top, did ANY SINGLE wick also reach the bottom?
  const minLows = Array<Decimal>(highs.length + 1).fill(new Decimal('Infinity'));
  let minClose = new Decimal('Infinity');
  let maxClose = new Decimal('-Infinity');
  let bar = candles.length - 2;
  for (const zone of [...formations].sort((a, b) => b.formedAt - a.formedAt)) {
    while (bar > zone.formedAt) {
      const candle = candles[bar--];
      minClose = Decimal.min(minClose, candle.close);
      maxClose = Decimal.max(maxClose, candle.close);
      const low = new Decimal(candle.low);
      for (let i = rank.get(new Decimal(candle.high).toString())!; i <= highs.length; i += i & -i) {
        minLows[i] = Decimal.min(minLows[i], low);
      }
    }
    zone.mitigated = zone.direction === 'BULLISH' ? minClose.lt(zone.bottom) : maxClose.gt(zone.top);
    for (let i = rank.get(zone.top.toString())!; i > 0 && !zone.mitigated; i -= i & -i) {
      zone.mitigated = minLows[i].lte(zone.bottom);
    }
  }
  return formations.map(({ formedAt: _index, ...zone }) => zone);
}

export class PatternRecognizer {
  private readonly client: BybitClient;
  private readonly config: PatternConfig;
  private readonly timezone: string;
  private macroCache: Map<string, MacroContext> = new Map();
  // Displacement rejection tracking
  private displacementRejections: number = 0;

  constructor(client: BybitClient, config: Partial<PatternConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };
    this.timezone = this.config.sessionConfig.timezone;
  }

  getDisplacementRejections(): number {
    return this.displacementRejections;
  }

  resetDisplacementRejections(): void {
    this.displacementRejections = 0;
  }

  /**
   * Get current session and killzone based on NY time
   * @param timestamp - Timestamp in milliseconds
   */
  getCurrentSessionAndKillzone(timestamp: number): { session: 'ASIAN' | 'LONDON' | 'NY' | 'NONE'; killzone: 'ASIAN' | 'LONDON' | 'NY' | 'NONE' } {
    // Use luxon with explicit UTC zone then setZone to NY (tzdata installed in Docker)
    const nyTime = DateTime.fromMillis(timestamp, { zone: 'utc' }).setZone(this.timezone);
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

    // Asian session: 20:00-24:00 NY time
    if (timeInMinutes >= asianStart && timeInMinutes < asianEnd) {
      session = 'ASIAN';
      killzone = 'ASIAN';
    }
    // London session: 02:00-05:00 NY time
    else if (timeInMinutes >= londonStart && timeInMinutes < londonEnd) {
      session = 'LONDON';
      killzone = 'LONDON';
    }
    // NY session: 07:00-10:00 NY time
    else if (timeInMinutes >= nyStart && timeInMinutes < nyEnd) {
      session = 'NY';
      killzone = 'NY';
    }

    return { session, killzone };
  }

  /**
   * Check if current time is in an active killzone
   */
  isInKillzone(timestamp: number): boolean {
    const { killzone } = this.getCurrentSessionAndKillzone(timestamp);
    return killzone !== 'NONE';
  }

  /**
   * Detect session ranges (Asian, London, NY) from candles
   * Asian: 20:00-24:00 NY time (Accumulation phase)
   * London: 02:00-05:00 NY time (Manipulation phase)
   * NY: 07:00-10:00 NY time (Distribution phase)
   * Only processes two days of LTF bars.
   */
  detectSessionRanges(candles: Candle[]): SessionRange[] {
    const ranges: SessionRange[] = [];
    
    const barsPerDay = Math.ceil(1440 / timeframeToMinutes(this.config.ltfTimeframe));
    const relevantCandles = candles.slice(-2 * barsPerDay);
    
    // Group candles by session day (NY time)
    const sessionDays = new Map<string, { high: Decimal; low: Decimal; start: number; end: number }>();
    
    for (const candle of relevantCandles) {
      const nyTime = DateTime.fromMillis(candle.timestamp).setZone(this.timezone);
      const dayKey = nyTime.toISODate(); // YYYY-MM-DD in NY time
      if (!dayKey) continue; // Skip if date is invalid
      const hour = nyTime.hour;
      const minute = nyTime.minute;
      const timeInMinutes = hour * 60 + minute;
      
      const asianStart = this.config.sessionConfig.asian.start * 60; // 20:00 = 1200
      const asianEnd = this.config.sessionConfig.asian.end * 60;     // 24:00 = 1440 (0:00 next day)
      
      // Check if candle is in Asian session (20:00-24:00 NY time)
      if (timeInMinutes >= asianStart && timeInMinutes < asianEnd) {
        if (!sessionDays.has(dayKey)) {
          sessionDays.set(dayKey, {
            high: new Decimal(candle.high),
            low: new Decimal(candle.low),
            start: candle.timestamp,
            end: candle.timestamp,
          });
        } else {
          const day = sessionDays.get(dayKey)!;
          const high = new Decimal(candle.high);
          const low = new Decimal(candle.low);
          if (high.gt(day.high)) day.high = high;
          if (low.lt(day.low)) day.low = low;
          day.end = candle.timestamp;
        }
      }
    }
    
    // Convert to SessionRange array (only last 2 days for relevance)
    const dayKeys = Array.from(sessionDays.keys()).slice(-2);
    for (const dayKey of dayKeys) {
      const day = sessionDays.get(dayKey)!;
      ranges.push({
        name: 'ASIAN',
        high: day.high,
        low: day.low,
        start: day.start,
        end: day.end,
      });
    }
    
    return ranges;
  }

  /**
   * Calculate ATR using decimal.js
   */
  calculateATR(candles: Candle[], period = this.config.atrPeriod): Decimal {
    return calculateATR(candles, period);
  }

  /**
   * Calculate Bollinger Bands
   * Returns { upper, middle, lower, bandwidth }
   * Bandwidth = (Upper - Lower) / Middle
   */
  calculateBollingerBands(candles: Candle[], period: number = 20, stdDev: number = 2): { upper: Decimal; middle: Decimal; lower: Decimal; bandwidth: Decimal } {
    if (candles.length < period) {
      return { upper: new Decimal(0), middle: new Decimal(0), lower: new Decimal(0), bandwidth: new Decimal(0) };
    }

    // Calculate SMA (middle band)
    const recentCandles = candles.slice(-period);
    let sum = new Decimal(0);
    for (const c of recentCandles) {
      sum = sum.plus(new Decimal(c.close));
    }
    const middle = sum.dividedBy(period);

    // Calculate standard deviation
    let sqSum = new Decimal(0);
    for (const c of recentCandles) {
      const close = new Decimal(c.close);
      const diff = close.minus(middle);
      sqSum = sqSum.plus(diff.mul(diff));
    }
    const variance = sqSum.dividedBy(period);
    const std = variance.sqrt();

    const multiplier = new Decimal(stdDev);
    const upper = middle.plus(std.mul(multiplier));
    const lower = middle.minus(std.mul(multiplier));
    const bandwidth = upper.minus(lower).div(middle);

    return { upper, middle, lower, bandwidth };
  }

  /**
   * Calculate Bollinger Bands series for percentile calculation
   * Returns array of bandwidth values for each period
   */
  calculateBollingerBandwidthSeries(candles: Candle[], period: number = 20, stdDev: number = 2, lookback: number = 100): Decimal[] {
    if (candles.length < period + lookback) return [];

    const bandwidths: Decimal[] = [];
    const maxStart = candles.length - period;
    const start = Math.max(0, maxStart - lookback + 1);

    for (let i = start; i <= maxStart; i++) {
      const window = candles.slice(i, i + period);
      const bb = this.calculateBollingerBands(window, period, stdDev);
      bandwidths.push(bb.bandwidth);
    }

    return bandwidths;
  }

  /**
   * Check if current Bollinger Bandwidth indicates a squeeze
   * Squeeze = current bandwidth is in bottom percentile of recent bandwidths
   */
  isBollingerSqueeze(candles: Candle[], period: number, stdDev: number, squeezePercentile: number, squeezeLookback: number): boolean {
    const bandwidths = this.calculateBollingerBandwidthSeries(candles, period, stdDev, squeezeLookback);
    if (bandwidths.length < 10) return false; // Need enough data

    const currentBandwidth = bandwidths[bandwidths.length - 1];
    const sorted = [...bandwidths].sort((a, b) => a.comparedTo(b));
    const thresholdIndex = Math.floor(sorted.length * (squeezePercentile / 100));
    const threshold = sorted[thresholdIndex];

    return currentBandwidth.lte(threshold);
  }

  /**
   * Calculate trading range with Bollinger Bands squeeze filter
   * Range is valid only if Bollinger Bands are in squeeze (low volatility)
   * Range boundaries = extremes of last N candles
   */
  detectTradingRange(
    candles: Candle[],
    rangeLookback: number = 30,
    bbPeriod: number = 20,
    bbStdDev: number = 2,
    squeezePercentile: number = 20,
    squeezeLookback: number = 100
  ): TradingRange | null {
    if (candles.length < Math.max(rangeLookback, bbPeriod) + 1) return null;

    // Check Bollinger Bands squeeze FIRST - this is the gatekeeper
    if (!this.isBollingerSqueeze(candles, bbPeriod, bbStdDev, squeezePercentile, squeezeLookback)) {
      return null; // No squeeze = no valid range
    }

    // Exclude the last candle (current) from range formation
    const recentCandles = candles.slice(-(rangeLookback + 1), -1);
    if (recentCandles.length < rangeLookback) return null;

    // Range boundaries = actual extremes of last N candles
    let rangeHigh = new Decimal(0);
    let rangeLow = new Decimal('Infinity');

    for (const c of recentCandles) {
      const high = new Decimal(c.high);
      const low = new Decimal(c.low);
      if (high.gt(rangeHigh)) rangeHigh = high;
      if (low.lt(rangeLow)) rangeLow = low;
    }

    // Range size check - realistic for crypto (0.3% to 15%)
    const rangeSize = rangeHigh.minus(rangeLow);
    const avgPrice = rangeHigh.plus(rangeLow).dividedBy(2);
    const rangePct = rangeSize.div(avgPrice).mul(100);
    if (rangePct.lt(new Decimal('0.3')) || rangePct.gt(new Decimal('15'))) return null;

    // Check for recent deviation - current candle poked outside RH or RL
    const lastCandle = candles[candles.length - 1];
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);

    const isDeviated = lastHigh.gt(rangeHigh) || lastLow.lt(rangeLow);

    const equilibrium = rangeHigh.plus(rangeLow).dividedBy(2);

    return {
      high: rangeHigh,
      low: rangeLow,
      equilibrium,
      isDeviated,
    };
  }

  /**
   * Calculate Premium/Discount levels using Fibonacci
   * Determines trading range from last valid Swing Low to Swing High
   * Returns { equilibrium, isPremium, isDiscount, rangeHigh, rangeLow }
   */
  calculatePremiumDiscount(candles: Candle[], swingLookback: number = 20): { equilibrium: Decimal; isPremium: boolean; isDiscount: boolean; rangeHigh: Decimal; rangeLow: Decimal } | null {
    if (candles.length < swingLookback + 5) return null;

    // Find recent swing points
    const swings = this.findSwingPoints(candles.slice(-swingLookback), 3);
    if (swings.length < 2) return null;

    const highs = swings.filter(s => s.type === 'HIGH');
    const lows = swings.filter(s => s.type === 'LOW');
    if (highs.length === 0 || lows.length === 0) return null;

    // Use the most recent valid swing high and swing low
    const rangeHigh = highs[highs.length - 1].price;
    const rangeLow = lows[lows.length - 1].price;

    // Ensure rangeLow < rangeHigh (valid range)
    if (rangeLow.gte(rangeHigh)) return null;

    const equilibrium = rangeHigh.plus(rangeLow).dividedBy(2);

    return {
      equilibrium,
      rangeHigh,
      rangeLow,
      isPremium: false, // Will be set by caller based on current price
      isDiscount: false,
    };
  }

  /**
   * Find swing points (highs and lows) using 3-candle confirmation
   */
  findSwingPoints(candles: Candle[], lookback = SWING_CONFIRMATION_BARS): SwingPoint[] {
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
   * Optimized: compute swing points ONCE, then iterate with simple for loops
   * @param customDisplacementMultiplier - optional override for displacement threshold (e.g., for 1m timeframe)
   */
  detectStructureBreaks(candles: Candle[], atr: Decimal, customDisplacementMultiplier?: Decimal, timeframe = this.config.ltfTimeframe): Structure[] {
    if (!atr.isFinite() || atr.lte(0)) return [];
    const structures: Structure[] = [];
    let lastValidSwing: SwingPoint | null = null;
    let trend: Direction | null = null;

    // Use custom multiplier if provided, otherwise use config default
    const displacementMultiplier = customDisplacementMultiplier ?? this.config.displacementMultiplier;

    // Pre-compute all swing points ONCE (O(N))
    const allSwingPoints = this.findSwingPoints(candles);
    const highSwingsAll = allSwingPoints.filter(s => s.type === 'HIGH');
    const lowSwingsAll = allSwingPoints.filter(s => s.type === 'LOW');

    // Pointers to track the latest valid swing up to index i-3
    let highSwingIdx = -1;
    let lowSwingIdx = -1;

    for (let i = 0; i < candles.length; i++) {
      // Update last valid swing (confirmed 3 candles ago)
      if (i >= SWING_CONFIRMATION_BARS) {
        const checkIndex = i - SWING_CONFIRMATION_BARS;

        // Advance highSwingIdx to include swings up to checkIndex
        for (let h = highSwingIdx + 1; h < highSwingsAll.length; h++) {
          if (highSwingsAll[h].index <= checkIndex) {
            highSwingIdx = h;
          } else {
            break;
          }
        }
        // Advance lowSwingIdx to include swings up to checkIndex
        for (let l = lowSwingIdx + 1; l < lowSwingsAll.length; l++) {
          if (lowSwingsAll[l].index <= checkIndex) {
            lowSwingIdx = l;
          } else {
            break;
          }
        }

        if (highSwingIdx >= 0) lastValidSwing = highSwingsAll[highSwingIdx];
        if (lowSwingIdx >= 0 && (!lastValidSwing || lowSwingsAll[lowSwingIdx].index > lastValidSwing.index)) {
          lastValidSwing = lowSwingsAll[lowSwingIdx];
        }
      }

      if (!lastValidSwing) continue;

      const candle = candles[i];
      const close = new Decimal(candle.close);
      const body = new Decimal(candle.close).minus(candle.open).abs();
      const minBody = atr.mul(displacementMultiplier);

      // Check if price breaks the swing level
      const bullishBreak = lastValidSwing.type === 'HIGH' && close.greaterThan(lastValidSwing.price);
      const bearishBreak = lastValidSwing.type === 'LOW' && close.lessThan(lastValidSwing.price);

      if (bullishBreak || bearishBreak) {
        // Check displacement - body must be >= 1.5 * ATR
        if (body.greaterThanOrEqualTo(minBody)) {
          const direction: Direction = bullishBreak ? 'BULLISH' : 'BEARISH';
          const type = trend === direction ? 'BOS' : 'CHOCH';
          trend = direction;
          const impulseFactor = body.div(atr);
          structures.push({
            type,
            price: close,
            timestamp: candles[i].timestamp,
            isValidated: true,
            direction,
            impulseFactor,
          });
          lastValidSwing = null; // Reset after valid break
        } else {
          // Track displacement rejection - structure break without sufficient impulse
          this.displacementRejections++;
          lastValidSwing = null; // Reset - invalid break doesn't count
        }
      }
    }

    // === Detect SMS (Smart Money Shift) - Failure Swings ===
    // Bearish SMS: Higher High fails to follow through, then CHoCH down
    // Bullish SMS: Lower Low fails to follow through, then CHoCH up
    const smsStructures = this.detectSMS(candles, atr);
    structures.push(...smsStructures);

    return structures.map(s => ({ ...s, timeframe }));
  }

  /**
   * Detect FVGs (Fair Value Gaps)
   */
  detectFVGs(candles: Candle[], timeframe = this.config.ltfTimeframe): Zone[] {
    const fvgs: FormedZone[] = [];

    for (let i = 2; i < candles.length; i++) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1];
      const c3 = candles[i];

      // Bullish FVG: gap between c1 high and c3 low
      const bullGap = new Decimal(c3.low).minus(c1.high);
      const refPrice = new Decimal(c2.close);
      if (bullGap.gt(0) && bullGap.div(refPrice).mul(100).gte(this.config.fvgMinGapPercent)) {
        fvgs.push({
          formedAt: i,
          type: 'FVG',
          direction: 'BULLISH',
          top: new Decimal(c3.low),
          bottom: new Decimal(c1.high),
          timestamp: c1.timestamp,
          mitigated: false,
          timeframe,
        });
      }

      // Bearish FVG: gap between c1 low and c3 high
      const bearGap = new Decimal(c1.low).minus(c3.high);
      if (bearGap.gt(0) && bearGap.div(refPrice).mul(100).gte(this.config.fvgMinGapPercent)) {
        fvgs.push({
          formedAt: i,
          type: 'FVG',
          direction: 'BEARISH',
          top: new Decimal(c1.low),
          bottom: new Decimal(c3.high),
          timestamp: c1.timestamp,
          mitigated: false,
          timeframe,
        });
      }
    }

    return markMitigatedZones(candles, fvgs);
  }

  /**
   * Detect Order Blocks
   */
  detectOrderBlocks(candles: Candle[], breaks: Structure[], timeframe = this.config.ltfTimeframe): Zone[] {
    const obs: FormedZone[] = [];
    const indexByTime = new Map(candles.map((c, i) => [c.timestamp, i]));

    for (const br of breaks) {
      // Find the index of the break candle
      const breakIdx = indexByTime.get(br.timestamp) ?? -1;
      if (breakIdx <= 0) continue; // No candle before the break

      let obIndex = -1;

      // Go BACKWARDS from the candle BEFORE the break, using array indices (not timestamps!)
      for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - 15); i--) {
        const isBullishCandle = new Decimal(candles[i].close).gt(candles[i].open);
        const targetBullish = br.direction === 'BEARISH';

        if (isBullishCandle === targetBullish) {
          obIndex = i;
          break;
        }
      }

      if (obIndex >= 0) {
        const direction: Direction = br.direction === 'BULLISH' ? 'BULLISH' : 'BEARISH';
        obs.push({
          formedAt: breakIdx,
          type: 'OB',
          direction,
          top: new Decimal(candles[obIndex].high),
          bottom: new Decimal(candles[obIndex].low),
          timestamp: candles[obIndex].timestamp,
          mitigated: false,
          timeframe,
        });
      }
    }

    return markMitigatedZones(candles, obs);
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
   * Detect EQH/EQL (equal highs/lows within tolerance)
   * Uses tolerance of max(0.1%, 0.5 * ATR) for better noise filtering
   */
  detectEqualLevels(candles: Candle[], atr?: Decimal): { eqh: Decimal[]; eql: Decimal[] } {
    const pools = this.equalLevelPools(candles, this.findSwingPoints(candles), atr);
    return {
      eqh: pools.filter(p => p.type === 'EQH').map(p => p.priceLevel),
      eql: pools.filter(p => p.type === 'EQL').map(p => p.priceLevel),
    };
  }

  private equalLevelPools(candles: Candle[], swings: SwingPoint[], atr?: Decimal): LiquidityPool[] {
    if (!swings.length) return [];
    const close = new Decimal(candles[candles.length - 1].close);
    const threshold = Decimal.max('0.001', atr && close.gt(0) ? atr.mul('0.5').div(close) : 0);
    const extremes = followingExtremes(candles);
    const pools: LiquidityPool[] = [];
    for (const side of ['HIGH', 'LOW'] as const) {
      const sorted = swings.filter(s => s.type === side && s.price.gt(0))
        .sort((a, b) => a.price.cmp(b.price));
      // Compare each cluster to its first price so adjacent near-equalities
      // cannot chain together two distant extremes. Emit one pool per cluster.
      for (let i = 0; i < sorted.length;) {
        const first = sorted[i++];
        const points = [first];
        while (i < sorted.length) {
          const price = sorted[i].price;
          const midpoint = first.price.plus(price).div(2);
          if (price.minus(first.price).div(midpoint).gt(threshold)) break;
          points.push(sorted[i++]);
        }
        if (points.length < 2) continue;
        points.sort((a, b) => a.index - b.index);
        const priceLevel = points[0].price; // First touch sets the level; later touches confirm it.
        const last = points[points.length - 1];
        pools.push({
          type: side === 'HIGH' ? 'EQH' : 'EQL',
          priceLevel, points, timestamp: last.timestamp,
          isTaken: side === 'HIGH' ? extremes.highs[last.index].gt(priceLevel) : extremes.lows[last.index].lt(priceLevel),
        });
      }
    }
    return pools;
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
        if (swing.index >= i) break; // Swing points are chronological.
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
   * Returns array of SMS structures with displacement validation
   * Uses more candles for better detection of failure swings
   * Tolerance: max(0.5%, 0.5*ATR/price) for realistic crypto equal highs/lows
   */
  detectSMS(candles: Candle[], atr: Decimal): Structure[] {
    if (!candles.length || !atr.isFinite() || atr.lte(0)) return [];
    const smsStructures: Structure[] = [];
    
    // Use more candles for better SMS detection (last 100 candles)
    const relevantCandles = candles.slice(-100);
    const swings = this.findSwingPoints(relevantCandles);
    const highs = swings.filter(s => s.type === 'HIGH');
    const lows = swings.filter(s => s.type === 'LOW');
    const minBody = atr.mul(this.config.displacementMultiplier);

    // Dynamic tolerance for equal highs/lows: max(0.5%, 0.5 * ATR / price)
    const lastPrice = new Decimal(relevantCandles[relevantCandles.length - 1].close);
    const atrTolerance = atr.mul(new Decimal('0.5')).div(lastPrice);
    const baseThreshold = new Decimal('0.005'); // 0.5%
    const equalTolerance = Decimal.max(baseThreshold, atrTolerance);

    // Bearish SMS: failure to make higher high (last high <= prev high), then CHoCH down
    if (highs.length >= 2) {
      const lastHigh = highs[highs.length - 1];
      const prevHigh = highs[highs.length - 2];
      
      // Failure swing: last high <= previous high (failed to make higher high)
      // Allow equal highs within dynamic tolerance
      const highDiff = lastHigh.price.minus(prevHigh.price).abs().div(prevHigh.price);
      if (highDiff.lte(equalTolerance)) {
        // Look for bearish CHoCH after the failure swing
        // The CHoCH must occur AFTER the lastHigh index
        for (let i = lastHigh.index + SWING_CONFIRMATION_BARS; i < relevantCandles.length; i++) {
          const candle = relevantCandles[i];
          const close = new Decimal(candle.close);
          
          // Bearish CHoCH: close breaks below the last swing low
          // Find the most recent swing low before this point
          const recentLows = lows.filter(l => l.index < i);
          if (recentLows.length > 0) {
            const lastLow = recentLows[recentLows.length - 1];
            if (close.lessThan(lastLow.price)) {
              // Check displacement on the CHoCH candle
              const body = new Decimal(candle.close).minus(candle.open).abs();
              if (body.greaterThanOrEqualTo(minBody)) {
                const impulseFactor = body.div(atr);
                smsStructures.push({
                  type: 'SMS',
                  direction: 'BEARISH',
                  price: lastHigh.price,
                  timestamp: candle.timestamp,
                  isValidated: true,
                  impulseFactor,
                });
                break; // Only one SMS per failure swing
              }
            }
          }
        }
      }
    }

    // Bullish SMS: failure to make lower low (last low >= prev low), then CHoCH up
    if (lows.length >= 2) {
      const lastLow = lows[lows.length - 1];
      const prevLow = lows[lows.length - 2];
      
      // Failure swing: last low >= previous low (failed to make lower low)
      // Allow equal lows within dynamic tolerance
      const lowDiff = lastLow.price.minus(prevLow.price).abs().div(prevLow.price);
      if (lowDiff.lte(equalTolerance)) {
        // Look for bullish CHoCH after the failure swing
        for (let i = lastLow.index + SWING_CONFIRMATION_BARS; i < relevantCandles.length; i++) {
          const candle = relevantCandles[i];
          const close = new Decimal(candle.close);
          const body = new Decimal(candle.close).minus(candle.open).abs();
          
          // Bullish CHoCH: close breaks above the last swing high
          const recentHighs = highs.filter(h => h.index < i);
          if (recentHighs.length > 0) {
            const lastHigh = recentHighs[recentHighs.length - 1];
            if (close.greaterThan(lastHigh.price)) {
              // Check displacement on the CHoCH candle
              if (body.greaterThanOrEqualTo(minBody)) {
                const impulseFactor = body.div(atr);
                smsStructures.push({
                  type: 'SMS',
                  direction: 'BULLISH',
                  price: lastLow.price,
                  timestamp: candle.timestamp,
                  isValidated: true,
                  impulseFactor,
                });
                break; // Only one SMS per failure swing
              }
            }
          }
        }
      }
    }

    return smsStructures;
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
   * Initialize macro context: fetch 1W and 1D candles, find ATH/ATL, POIs
   * ULTRA-FAST: ~5ms - NO heavy SMC analysis on macro timeframes!
   * Only computes: ATH, ATL, PWH/PWL, PDH/PDL, DO/WO, recent FVGs (last 20 daily)
   */
  async initializeMacroContext(symbol: string, macroCandles: number): Promise<MacroContext> {
    const cacheKey = `${symbol}_macro`;
    if (this.macroCache.has(cacheKey)) {
      return this.macroCache.get(cacheKey)!;
    }

    const startMs = Date.now();
    logger.info(`Initializing macro context for ${symbol}...`);

    try {
      // Single request for 1W and 1D with limit=1000 (no pagination, no heavy SMC)
      const [weeklyCandles, dailyCandles] = await Promise.all([
        this.client.getKlines(symbol, 'W', macroCandles),
        this.client.getKlines(symbol, 'D', macroCandles),
      ]);

      if (!weeklyCandles.length || !dailyCandles.length) {
        throw new Error('Empty candles from Bybit');
      }

      // === ATH/ATL: simple linear scan O(N) ===
      let ath = new Decimal(0);
      let atl = new Decimal('Infinity');
      for (const c of [...weeklyCandles, ...dailyCandles]) {
        const high = new Decimal(c.high);
        const low = new Decimal(c.low);
        if (high.gt(ath)) ath = high;
        if (low.lt(atl)) atl = low;
      }

      // === PWH/PWL: Previous Week High/Low (2nd last weekly candle) ===
      const prevWeek = weeklyCandles[weeklyCandles.length - 2] || weeklyCandles[weeklyCandles.length - 1];
      const wo = new Decimal(weeklyCandles[weeklyCandles.length - 1].open);

      // === PDH/PDL: Previous Day High/Low (2nd last daily candle) ===
      const prevDay = dailyCandles[dailyCandles.length - 2] || dailyCandles[dailyCandles.length - 1];
      const do_ = new Decimal(dailyCandles[dailyCandles.length - 1].open);

      // === Recent FVGs: only last 20 daily candles (not 1000!) ===
      const recentDaily = dailyCandles.slice(-20);
      const htfFvgs = this.detectFVGs(recentDaily, 'D');

      // === Simple levels only - NO heavy SMC on macro timeframes! ===
      const weeklyLevels = { 
        pwh: new Decimal(prevWeek.high), 
        pwl: new Decimal(prevWeek.low), 
        wo 
      };
      const dailyLevels = { 
        pdh: new Decimal(prevDay.high), 
        pdl: new Decimal(prevDay.low), 
        do: do_ 
      };

      // === Build liquidity pools from macro levels ===
      const liquidityPools: LiquidityPool[] = [
        // Previous Day High/Low
        { type: 'PDH', priceLevel: dailyLevels.pdh, timestamp: prevDay.timestamp, isTaken: false, points: [] },
        { type: 'PDL', priceLevel: dailyLevels.pdl, timestamp: prevDay.timestamp, isTaken: false, points: [] },
        // Previous Week High/Low
        { type: 'PWH', priceLevel: weeklyLevels.pwh, timestamp: prevWeek.timestamp, isTaken: false, points: [] },
        { type: 'PWL', priceLevel: weeklyLevels.pwl, timestamp: prevWeek.timestamp, isTaken: false, points: [] },
        // Daily/Weekly Open
        { type: 'DO', priceLevel: dailyLevels.do, timestamp: dailyCandles[dailyCandles.length - 1].timestamp, isTaken: false, points: [] },
        { type: 'WO', priceLevel: weeklyLevels.wo, timestamp: weeklyCandles[weeklyCandles.length - 1].timestamp, isTaken: false, points: [] },
      ];

      const macro: MacroContext = {
        ath,
        atl,
        htfFvgs,
        htfObs: [],
        weeklyLevels,
        dailyLevels,
        liquidityPools,
      };

      this.macroCache.set(`${symbol}_macro`, macro);
      const elapsed = Date.now() - startMs;
      logger.info(`[${symbol}] Macro context loaded in ${elapsed}ms: ATH=${ath.toFixed(2)}, ATL=${atl.toFixed(2)}`);
      return macro;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to initialize macro context for ${symbol}: ${message}`);
      // Return empty macro context to allow bot to continue without macro data
      return {
        ath: new Decimal(0),
        atl: new Decimal('Infinity'),
        htfFvgs: [],
        htfObs: [],
        weeklyLevels: { pwh: new Decimal(0), pwl: new Decimal(0), wo: new Decimal(0) },
        dailyLevels: { pdh: new Decimal(0), pdl: new Decimal(0), do: new Decimal(0) },
        liquidityPools: [],
      };
    }
  }

  /**
   * Force refresh of macro context by clearing cache and re-initializing.
   * This is called daily at 00:00 UTC to refresh PDH/PDL/PWH/PWL levels.
   * Uses atomic cache replacement to prevent race conditions.
   */
  async refreshMacroContext(symbol: string, macroCandles: number): Promise<MacroContext> {
    const cacheKey = `${symbol}_macro`;
    // Atomically replace the cache entry
    this.macroCache.delete(cacheKey);
    return this.initializeMacroContext(symbol, macroCandles);
  }

  /**
   * Directly set macro context cache (for backtesting with dynamic updates)
   * Allows atomic update without fetching from API
   */
  public setMacroContext(symbol: string, context: MacroContext): void {
    this.macroCache.set(`${symbol}_macro`, context);
  }

  /**
   * Get current macro context from cache
   */
  public getMacroContext(symbol: string): MacroContext | undefined {
    return this.macroCache.get(`${symbol}_macro`);
  }

  /**
   * Build complete pattern data for a symbol
   * Uses pre-initialized macro context from cache (initialized at startup)
   * @param currentCandleTimestamp - Timestamp of the current 15m candle being analyzed (for killzone calculation)
   */
  async buildPatternData(symbol: string, ltfCandles: Candle[], htfCandles: Candle[], currentCandleTimestamp: number): Promise<PatternData> {
    const startMs = Date.now();
    // Get macro context from cache (pre-initialized at startup)
    const macroContext = this.macroCache.get(`${symbol}_macro`) ?? {
      ath: new Decimal(0),
      atl: new Decimal('Infinity'),
      htfFvgs: [],
      htfObs: [],
      weeklyLevels: { pwh: new Decimal(0), pwl: new Decimal(0), wo: new Decimal(0) },
      dailyLevels: { pdh: new Decimal(0), pdl: new Decimal(0), do: new Decimal(0) },
      liquidityPools: [],
    };

    // Calculate ATRs
    const atr15m = this.calculateATR(ltfCandles, this.config.atrPeriod);
    const atr4h = this.calculateATR(htfCandles, this.config.atrPeriod);

    // Current session and killzone (using candle timestamp to avoid lookahead bias)
    const { session, killzone } = this.getCurrentSessionAndKillzone(currentCandleTimestamp);

    // Session ranges - detect Asian session ranges for AMD scenario
    const sessionRanges = this.detectSessionRanges(ltfCandles);

    // Find swing points
    const swingPoints15m = this.findSwingPoints(ltfCandles);
    const swingPoints4h = this.findSwingPoints(htfCandles);

    // Detect structures.
    // Tag each structure with its origin timeframe BEFORE merging: detection is
    // timeframe-agnostic, and scenarios filter on `timeframe` to distinguish
    // 15m structure from 4H structure (Scenarios 2 & 4 HTF trend filters).
    const { ltfTimeframe, htfTimeframe } = this.config;
    const structures15m = this.detectStructureBreaks(ltfCandles, atr15m, undefined, ltfTimeframe);
    const structures4h = this.detectStructureBreaks(htfCandles, atr4h, undefined, htfTimeframe);

    // Detect Trading Range on 15m with Bollinger Bands squeeze filter
    const tradingRange = this.detectTradingRange(
      ltfCandles,
      this.config.rangeLookback,
      this.config.bollingerPeriod,
      this.config.bollingerStdDev,
      this.config.bollingerSqueezePercentile,
      this.config.bollingerSqueezeLookback
    );

    // === Add BSL/SSL from 4H swing points ===
    // BSL = Buy Side Liquidity = Swing Highs (where buy stops are placed above)
    // SSL = Sell Side Liquidity = Swing Lows (where sell stops are placed below)
    const htfExtremes = followingExtremes(htfCandles);
    // A prior 15m candle may have pierced a 4H level since the last HTF
    // close. Include that evidence, still reserving the signal candle for S5.
    let ltfIndex = ltfCandles.length - 2;
    let ltfHigh = new Decimal('-Infinity');
    let ltfLow = new Decimal('Infinity');
    const swingPools: LiquidityPool[] = [];
    for (let i = swingPoints4h.length - 1; i >= 0; i--) {
      const sp = swingPoints4h[i];
      while (ltfIndex >= 0 && ltfCandles[ltfIndex].timestamp > sp.timestamp) {
        ltfHigh = Decimal.max(ltfHigh, ltfCandles[ltfIndex].high);
        ltfLow = Decimal.min(ltfLow, ltfCandles[ltfIndex].low);
        ltfIndex--;
      }
      swingPools.push({
        type: sp.type === 'HIGH' ? 'BSL' : 'SSL',
        priceLevel: sp.price,
        timestamp: sp.timestamp,
        points: [sp],
        isTaken: sp.type === 'HIGH'
          ? Decimal.max(htfExtremes.highs[sp.index], ltfHigh).gt(sp.price)
          : Decimal.min(htfExtremes.lows[sp.index], ltfLow).lt(sp.price),
      });
    }
    const allLiquidityPools = [
      ...evaluatedMacroPools(macroContext.liquidityPools, ltfCandles, htfCandles),
      ...swingPools.reverse(),
      ...this.equalLevelPools(ltfCandles, swingPoints15m, atr15m),
    ];

    const ms = Date.now() - startMs;
    logger.debug(`[${symbol}] PatternData built in ${ms}ms`);

    // Merge 15m + 4H structures/zones and enforce a strict chronological order
    // (oldest → newest). Scenarios assume ascending timestamps when they pick the
    // freshest match via `arr[arr.length - 1]` or `[...arr].reverse().find(...)`.
    // Naive concatenation ([...15m, ...4H]) breaks that assumption whenever a 4H
    // structure is older than the newest 15m structure.
    const combinedStructures: Structure[] = [...structures15m, ...structures4h].sort(
      (a, b) => a.timestamp - b.timestamp
    );

    const combinedZones: Zone[] = [
      ...this.detectFVGs(ltfCandles, ltfTimeframe),
      ...this.detectFVGs(htfCandles, htfTimeframe),
      ...this.detectOrderBlocks(ltfCandles, structures15m, ltfTimeframe),
      ...this.detectOrderBlocks(htfCandles, structures4h, htfTimeframe),
    ].sort((a, b) => a.timestamp - b.timestamp);

    return {
      candles15m: ltfCandles,
      candles4h: htfCandles,
      macroContext,
      currentSession: session,
      currentKillzone: killzone,
      sessionRanges,
      tradingRange,
      liquidityPools: allLiquidityPools,
      structures: combinedStructures,
      zones: combinedZones,
      swingPoints: [...swingPoints15m, ...swingPoints4h],
      atrPeriod: this.config.atrPeriod,
      atr15m,
      atr4h,
      patternRecognizer: this as any,
    };
  }
}

export function createPatternRecognizer(client: BybitClient, config: Partial<PatternConfig> = {}): PatternRecognizer {
  return new PatternRecognizer(client, config);
}
