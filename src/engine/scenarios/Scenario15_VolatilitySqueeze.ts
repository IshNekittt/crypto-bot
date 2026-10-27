import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { PatternData } from '../../smc/patternRecognizer';
import { BaseScenario } from '../baseScenario';
import { resolveTakeProfit } from '../tpResolver';
import { calculateVolatilitySqueeze } from '../quant/volatilitySqueeze';

export interface Scenario15RejectionStats {
  totalEvals: number;
  wrongMode: number;
  insufficientCandles: number;
  noSqueezeFiring: number;
  neutralMomentum: number;
  invalidAtr: number;
  tpInvalid: number;
  triggered: number;
}

const EMPTY_STATS: Scenario15RejectionStats = {
  totalEvals: 0,
  wrongMode: 0,
  insufficientCandles: 0,
  noSqueezeFiring: 0,
  neutralMomentum: 0,
  invalidAtr: 0,
  tpInvalid: 0,
  triggered: 0,
};

const PERIOD = 20;
const BB_MULTIPLIER = new Decimal(2);
const ATR_MULTIPLIER = new Decimal('1.5');
const MIN_SQUEEZE_CANDLES = 5;
const STOP_ATR_MULTIPLIER = new Decimal('1.5');

/** 15m Bollinger/Keltner volatility compression and breakout. */
export class Scenario15_VolatilitySqueeze extends BaseScenario {
  private static stats: Scenario15RejectionStats = { ...EMPTY_STATS };

  constructor(config: BotConfig) {
    super(15, 'Volatility Compression Squeeze (BB/KC)', config);
  }

  static getRejectionStats(): Readonly<Scenario15RejectionStats> {
    return { ...Scenario15_VolatilitySqueeze.stats };
  }

  static resetStats(): void {
    Scenario15_VolatilitySqueeze.stats = { ...EMPTY_STATS };
  }

  protected override evaluateInternal(patternData: PatternData): boolean {
    const stats = Scenario15_VolatilitySqueeze.stats;
    stats.totalEvals++;

    if (this.config.enableSniperMode || this.config.ltfTimeframe !== '15') {
      return this.reject('wrongMode', 'Scenario 15 requires Classic Mode on 15m candles');
    }

    const candles = patternData.candles15m ?? [];
    if (candles.length < PERIOD + MIN_SQUEEZE_CANDLES) {
      return this.reject(
        'insufficientCandles',
        `Requires at least ${PERIOD + MIN_SQUEEZE_CANDLES} closed 15m candles`,
      );
    }

    let snapshots;
    try {
      snapshots = calculateVolatilitySqueeze(
        candles,
        PERIOD,
        BB_MULTIPLIER,
        ATR_MULTIPLIER,
        MIN_SQUEEZE_CANDLES,
      );
    } catch (error) {
      return this.reject(
        'insufficientCandles',
        `Invalid squeeze input: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const current = snapshots[snapshots.length - 1];
    if (!current?.isFiring) {
      return this.reject('noSqueezeFiring', 'No first BB expansion after a 5+ candle squeeze');
    }
    if (current.momentum.isZero()) {
      return this.reject('neutralMomentum', 'Breakout momentum slope is neutral');
    }

    const direction = current.momentum.gt(0) ? 'BULLISH' : 'BEARISH';
    const entry = new Decimal(candles[candles.length - 1].close);
    if (!entry.isFinite() || entry.lte(0) || !current.atr.isFinite() || current.atr.lte(0)) {
      return this.reject('invalidAtr', 'Invalid breakout price or True Range ATR');
    }

    // Stop sits beyond the Keltner midline by 1.5 × True Range ATR. The shared
    // geometry helper enforces correct-side placement and the minimum offset.
    const stopGeometry = this.calculateLevels(
      entry,
      { top: current.keltnerMiddle, bottom: current.keltnerMiddle, direction },
      direction,
      current.atr,
      new Decimal(1),
      STOP_ATR_MULTIPLIER,
      true,
    );

    const resolution = resolveTakeProfit({
      direction,
      entry,
      stopLoss: stopGeometry.stopLoss,
      zones: patternData.zones ?? [],
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
      skipMinorObstacles: true,
    });

    if (!resolution.ok) {
      return this.reject('tpInvalid', `Take-profit rejected: ${resolution.reason}`);
    }

    this.setLevels({
      entry,
      stopLoss: stopGeometry.stopLoss,
      takeProfit: resolution.takeProfit,
    });
    // The trigger candle is the consumed structure; no synthetic zone is
    // emitted because a volatility band is not an SMC mitigation zone.
    this.setStructureDetails({
      type: 'BOS',
      timestamp: current.timestamp,
      price: entry,
      direction,
    });
    this.setReason(
      `Squeeze fired after ${current.priorSqueezeCandles} candles; momentum=${current.momentum.toSignificantDigits(6).toString()}`,
    );
    stats.triggered++;
    return true;
  }

  private reject(
    bucket: keyof Omit<Scenario15RejectionStats, 'totalEvals'>,
    reason: string,
  ): false {
    Scenario15_VolatilitySqueeze.stats[bucket]++;
    this.setReason(reason);
    return false;
  }
}
