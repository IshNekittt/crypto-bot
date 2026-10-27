import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { PatternData } from '../../smc/patternRecognizer';
import { BaseScenario } from '../baseScenario';
import { resolveTakeProfit } from '../tpResolver';

export interface Scenario14RejectionStats {
  totalEvals: number;
  insufficientCandles: number;
  insideChannel: number;
  lowVolumeBreakout: number;
  insufficientRr: number;
  tpInvalid: number;
  triggered: number;
}

const EMPTY_STATS: Scenario14RejectionStats = {
  totalEvals: 0,
  insufficientCandles: 0,
  insideChannel: 0,
  lowVolumeBreakout: 0,
  insufficientRr: 0,
  tpInvalid: 0,
  triggered: 0,
};

const CHANNEL_CANDLES = 20;
const VOLUME_SMA_CANDLES = 20;
const MIN_VOLUME_RATIO = new Decimal('1.3');
const STOP_ATR_MULTIPLE = new Decimal('2');
const TARGET_RR = new Decimal('4');
const MIN_ACCEPTED_RR = new Decimal('2.5');

/** Institutional systematic trend-following breakout. */
export class Scenario14_QuantAlpha extends BaseScenario {
  private static stats: Scenario14RejectionStats = { ...EMPTY_STATS };

  constructor(config: BotConfig) {
    super(14, 'Trend Following Alpha (Donchian / Volume Breakout)', config);
  }

  static getRejectionStats(): Readonly<Scenario14RejectionStats> {
    return { ...Scenario14_QuantAlpha.stats };
  }

  static resetStats(): void {
    Scenario14_QuantAlpha.stats = { ...EMPTY_STATS };
  }

  protected override evaluateInternal(patternData: PatternData): boolean {
    const stats = Scenario14_QuantAlpha.stats;
    stats.totalEvals++;

    const candles15m = patternData.candles15m ?? [];
    const candles4h = patternData.candles4h ?? [];

    // The channel excludes the forming/current 4H bar. The confirmed 15m bar
    // is the only trigger; neither channel nor volume is future-aware.
    if (
      candles15m.length < VOLUME_SMA_CANDLES + 1 ||
      candles4h.length < CHANNEL_CANDLES + 1
    ) {
      return this.reject(
        'insufficientCandles',
        `Requires ${VOLUME_SMA_CANDLES + 1} confirmed 15m and ${CHANNEL_CANDLES + 1} confirmed 4H candles`,
      );
    }

    const current = candles15m[candles15m.length - 1];
    const entry = new Decimal(current.close);
    const atr15m = patternData.atr15m;

    if (!entry.isFinite() || entry.lte(0) || !atr15m || !atr15m.isFinite() || atr15m.lte(0)) {
      return this.reject('insufficientCandles', 'Entry or ATR15m is unavailable');
    }

    const closed4h = candles4h.slice(-(CHANNEL_CANDLES + 1), -1);
    let channelHigh = new Decimal('-Infinity');
    let channelLow = new Decimal('Infinity');
    for (const candle of closed4h) {
      channelHigh = Decimal.max(channelHigh, new Decimal(candle.high));
      channelLow = Decimal.min(channelLow, new Decimal(candle.low));
    }

    const isLong = entry.gt(channelHigh);
    const isShort = entry.lt(channelLow);
    if (!isLong && !isShort) {
      return this.reject('insideChannel', 'Price inside Donchian range');
    }

    const direction: 'BULLISH' | 'BEARISH' = isLong ? 'BULLISH' : 'BEARISH';
    const volumeAverage = candles15m
      .slice(0, -1)
      .slice(-VOLUME_SMA_CANDLES)
      .reduce((sum, candle) => sum.plus(new Decimal(candle.volume)), new Decimal(0))
      .div(VOLUME_SMA_CANDLES);
    const breakoutVolume = new Decimal(current.volume);

    if (
      !volumeAverage.isFinite() ||
      !breakoutVolume.isFinite() ||
      volumeAverage.lte(0) ||
      breakoutVolume.lt(volumeAverage.mul(MIN_VOLUME_RATIO))
    ) {
      return this.reject('lowVolumeBreakout', 'Breakout lacks volume expansion');
    }

    // calculateLevels() adds the ATR stop offset to the relevant zone edge.
    // Feed entry itself for both edges here so the 2ATR stop is applied exactly
    // once; supplying entry ± stopDistance would double it.
    const baseZone = {
      top: entry,
      bottom: entry,
      direction,
    };
    const baseLevels = this.calculateLevels(
      entry,
      baseZone,
      direction,
      atr15m,
      new Decimal(1),
      STOP_ATR_MULTIPLE,
      true,
    );

    const resolution = resolveTakeProfit({
      direction,
      entry,
      stopLoss: baseLevels.stopLoss,
      zones: patternData.zones ?? [],
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: Decimal.min(this.config.dynamicTpMaxRr, TARGET_RR),
      fixedRr: TARGET_RR,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: false,
      skipMinorObstacles: true,
    });

    if (!resolution.ok) {
      return this.reject('tpInvalid', `Take-profit rejected: ${resolution.reason}`);
    }

    const actualRisk = entry.minus(baseLevels.stopLoss).abs();
    const actualReward = resolution.takeProfit.minus(entry).abs();
    const rr = actualRisk.gt(0) ? actualReward.div(actualRisk) : new Decimal(0);

    if (rr.lt(MIN_ACCEPTED_RR)) {
      return this.reject(
        'insufficientRr',
        `Trend target is only ${rr.toFixed(2)}R; requires ${MIN_ACCEPTED_RR.toFixed(1)}R`,
      );
    }

    this.setLevels({
      entry,
      stopLoss: baseLevels.stopLoss,
      takeProfit: resolution.takeProfit,
    });
    this.setZoneDetails({
      type: 'MITIGATION',
      top: isLong ? channelHigh : entry,
      bottom: isLong ? entry : channelLow,
      timeframe: '15',
      direction,
      timestamp: current.timestamp,
    });
    this.setStructureDetails({
      type: 'BOS',
      timestamp: current.timestamp,
      price: entry,
      direction,
    });

    stats.triggered++;
    return true;
  }

  private reject(
    bucket: keyof Omit<Scenario14RejectionStats, 'totalEvals'>,
    reason: string,
  ): false {
    Scenario14_QuantAlpha.stats[bucket]++;
    this.setReason(reason);
    return false;
  }
}
