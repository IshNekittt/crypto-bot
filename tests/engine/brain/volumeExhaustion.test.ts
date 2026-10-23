import { Decimal } from 'decimal.js';
import {
  analyzeVolumeExhaustion,
  type VolumeExhaustionInput,
} from '../../../src/engine/brain/volumeExhaustion';
import type { Candle } from '../../../src/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const BULL_POI_TOP = '110.5';
const BULL_POI_BOTTOM = '109.5';
const BEAR_POI_TOP = '109.5';
const BEAR_POI_BOTTOM = '108.5';

function candle(
  timestamp: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume = '100',
): Candle {
  return { timestamp, open, high, low, close, volume };
}

function withCandle(
  candles: readonly Candle[],
  index: number,
  patch: Partial<Candle>,
): Candle[] {
  return candles.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
}

function withVolumes(
  candles: readonly Candle[],
  replacements: Readonly<Record<number, string>>,
): Candle[] {
  return candles.map((entry, i) => {
    const replacement = replacements[i];
    return replacement === undefined ? entry : { ...entry, volume: replacement };
  });
}

/**
 * 20 impulse candles (volume 100) -> 3 low-volume corrective candles
 * (30/40/50) -> 150-volume reaction candle touching the demand POI.
 *
 * The swing high is candle #20 (index 19), which is also the last candle of
 * the baseline window. This makes the expected SMA exactly 100.
 */
function makeBullishCandles(): Candle[] {
  const result: Candle[] = [];

  for (let i = 0; i < 20; i += 1) {
    const close = new Decimal(100).plus(i);
    const open = close.minus('0.5');
    const high = close.plus('0.5');
    const low = close.minus(1);
    result.push(
      candle(
        i + 1,
        open.toString(),
        high.toString(),
        low.toString(),
        close.toString(),
      ),
    );
  }

  const pullbackCloses = ['117', '114', '111.5'];
  const pullbackVolumes = ['30', '40', '50'];
  for (let i = 0; i < pullbackCloses.length; i += 1) {
    const close = new Decimal(pullbackCloses[i]);
    const open = close.plus('0.5');
    const high = open.plus('0.5');
    const low = close.minus('0.5');
    result.push(
      candle(
        21 + i,
        open.toString(),
        high.toString(),
        low.toString(),
        close.toString(),
        pullbackVolumes[i],
      ),
    );
  }

  result.push(candle(24, '110.2', '111.2', '109.8', '111', '150'));
  return result;
}

/**
 * Mirror image of the bullish fixture: 20 declining impulse candles -> 3
 * low-volume corrective rallies -> high-volume rejection at the supply POI.
 */
function makeBearishCandles(): Candle[] {
  const result: Candle[] = [];

  for (let i = 0; i < 20; i += 1) {
    const close = new Decimal(119).minus(i);
    const open = close.plus('0.5');
    const high = open.plus('0.5');
    const low = close.minus(1);
    result.push(
      candle(
        i + 1,
        open.toString(),
        high.toString(),
        low.toString(),
        close.toString(),
      ),
    );
  }

  const pullbackCloses = ['102', '105', '107.5'];
  const pullbackVolumes = ['30', '40', '50'];
  for (let i = 0; i < pullbackCloses.length; i += 1) {
    const close = new Decimal(pullbackCloses[i]);
    const open = close.minus('0.5');
    const high = close.plus('0.5');
    const low = close.minus('0.5');
    result.push(
      candle(
        21 + i,
        open.toString(),
        high.toString(),
        low.toString(),
        close.toString(),
        pullbackVolumes[i],
      ),
    );
  }

  result.push(candle(24, '108.5', '109.2', '107', '108', '150'));
  return result;
}

function bullishInput(
  overrides: Partial<VolumeExhaustionInput> = {},
): VolumeExhaustionInput {
  return {
    candles15m: makeBullishCandles(),
    direction: 'BULLISH',
    poiZone: {
      top: new Decimal(BULL_POI_TOP),
      bottom: new Decimal(BULL_POI_BOTTOM),
    },
    atr15m: new Decimal('1'),
    ...overrides,
  };
}

function bearishInput(
  overrides: Partial<VolumeExhaustionInput> = {},
): VolumeExhaustionInput {
  return {
    candles15m: makeBearishCandles(),
    direction: 'BEARISH',
    poiZone: {
      top: new Decimal(BEAR_POI_TOP),
      bottom: new Decimal(BEAR_POI_BOTTOM),
    },
    atr15m: new Decimal('1'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Healthy textbook behaviour
// ---------------------------------------------------------------------------

describe('analyzeVolumeExhaustion', () => {
  it('confirms textbook bullish exhaustion and a high-volume POI reaction', () => {
    const result = analyzeVolumeExhaustion(bullishInput());

    expect(result.isValid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.isExhausted).toBe(true);
    expect(result.isReactionConfirmed).toBe(true);
    expect(result.baselineVolume.eq('100')).toBe(true);
    expect(result.pullbackAvgRatio.eq('0.4')).toBe(true);
    expect(result.reactionVolumeRatio.eq('1.5')).toBe(true);
    expect(result.pullbackCandleCount).toBe(3);
  });

  it('confirms the mirrored bearish exhaustion fixture', () => {
    const result = analyzeVolumeExhaustion(bearishInput());

    expect(result.isValid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.isExhausted).toBe(true);
    expect(result.isReactionConfirmed).toBe(true);
    expect(result.baselineVolume.eq('100')).toBe(true);
    expect(result.pullbackAvgRatio.eq('0.4')).toBe(true);
    expect(result.reactionVolumeRatio.eq('1.5')).toBe(true);
    expect(result.pullbackCandleCount).toBe(3);
  });

  it('normalizes an inverted POI zone instead of trusting top/bottom labels', () => {
    const input = bullishInput({
      poiZone: {
        top: new Decimal(BULL_POI_BOTTOM),
        bottom: new Decimal(BULL_POI_TOP),
      },
    });

    const result = analyzeVolumeExhaustion(input);

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(true);
    expect(result.isReactionConfirmed).toBe(true);
  });

  it('keeps the input candles immutable and tolerates a frozen array', () => {
    const candles = Object.freeze(
      makeBullishCandles().map((entry) => Object.freeze({ ...entry })),
    );
    const before = candles.map((entry) => ({ ...entry }));

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(candles).toEqual(before);
  });

  it('uses the configured volume SMA period for the baseline window', () => {
    const base = makeBullishCandles();
    const candles = withVolumes(base, {
      15: '200',
      16: '200',
      17: '200',
      18: '200',
      19: '200',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles, volumeSmaPeriod: 5 }),
    );

    expect(result.isValid).toBe(true);
    expect(result.baselineVolume.eq('200')).toBe(true);
    // 40 average / 200 baseline.
    expect(result.pullbackAvgRatio.eq('0.2')).toBe(true);
    // 150 reaction / 200 baseline.
    expect(result.reactionVolumeRatio.eq('0.75')).toBe(true);
    expect(result.isReactionConfirmed).toBe(false);
  });

  it('honours custom exhaustion and reaction thresholds', () => {
    const strictExhaustion = analyzeVolumeExhaustion(
      bullishInput({ maxPullbackVolumeRatio: new Decimal('0.3') }),
    );
    expect(strictExhaustion.isValid).toBe(true);
    expect(strictExhaustion.isExhausted).toBe(false);

    const strictReaction = analyzeVolumeExhaustion(
      bullishInput({ minReactionVolumeRatio: new Decimal('1.6') }),
    );
    expect(strictReaction.isValid).toBe(true);
    expect(strictReaction.isReactionConfirmed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Exhaustion and reaction gates are independent of data validity
  // -------------------------------------------------------------------------

  it('reports a panic dump as valid data but not exhausted', () => {
    const candles = withVolumes(makeBullishCandles(), {
      20: '150',
      21: '180',
      22: '210',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(false);
    expect(result.isReactionConfirmed).toBe(true);
    expect(result.pullbackAvgRatio.eq('1.8')).toBe(true);
    expect(result.pullbackCandleCount).toBe(3);
    expect(result.failureCode).toBe('PULLBACK_VOLUME_HEAVY');
  });

  it('reports a low-volume reaction as valid data without confirmation', () => {
    const candles = withCandle(makeBullishCandles(), 23, { volume: '90' });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(true);
    expect(result.isReactionConfirmed).toBe(false);
    expect(result.reactionVolumeRatio.eq('0.9')).toBe(true);
    expect(result.failureCode).toBe('REACTION_VOLUME_WEAK');
  });

  it('confirms a reaction at exactly baseline volume (default threshold 1.0)', () => {
    const candles = withCandle(makeBullishCandles(), 23, { volume: '100' });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isReactionConfirmed).toBe(true);
    expect(result.reactionVolumeRatio.eq('1')).toBe(true);
  });

  it('allows a 1.4x liquidation pullback under the 1.5 default ceiling', () => {
    const candles = withVolumes(makeBullishCandles(), {
      20: '140',
      21: '140',
      22: '140',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(result.pullbackAvgRatio.eq('1.4')).toBe(true);
    expect(result.isExhausted).toBe(true);
    expect(result.pullbackCandleCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Structural invalidation
  // -------------------------------------------------------------------------

  it('tolerates a bullish corrective close inside the 50%/ATR POI buffer', () => {
    const candles = withCandle(makeBullishCandles(), 22, {
      open: '109.8',
      high: '110.2',
      low: '109.2',
      close: '109.4',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(true);
  });

  it('invalidates a bullish corrective close beyond the 50%/ATR POI buffer', () => {
    const candles = withCandle(makeBullishCandles(), 22, {
      open: '109.8',
      high: '109.8',
      low: '108.7',
      close: '108.9',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('POI structurally violated on pullback');
    expect(result.failureCode).toBe('POI_VIOLATED');
  });

  it('tolerates a bearish corrective close inside the 50%/ATR POI buffer', () => {
    const candles = withCandle(makeBearishCandles(), 22, {
      open: '109.3',
      high: '110.0',
      low: '109.2',
      close: '109.6',
    });

    const result = analyzeVolumeExhaustion(
      bearishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(true);
  });

  it('invalidates a bearish corrective close beyond the 50%/ATR POI buffer', () => {
    const candles = withCandle(makeBearishCandles(), 22, {
      open: '110.0',
      high: '110.3',
      low: '109.9',
      close: '110.1',
    });

    const result = analyzeVolumeExhaustion(
      bearishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('POI structurally violated on pullback');
    expect(result.failureCode).toBe('POI_VIOLATED');
  });

  it('uses the ATR term to tolerate noise on a thin bullish POI', () => {
    const candles = withCandle(makeBullishCandles(), 22, {
      open: '109.8',
      high: '110.2',
      low: '109.2',
      close: '109.4',
    });
    const reaction = withCandle(candles, 23, {
      high: '111.2',
      low: '109.4',
      close: '111',
    });

    // Zone height 0.10 => 50% buffer 0.05; ATR 0.25 => 40% buffer 0.10.
    // The ATR term wins, so a close 0.05 below the zone is tolerated.
    const result = analyzeVolumeExhaustion(
      bullishInput({
        candles15m: reaction,
        poiZone: {
          top: new Decimal('109.55'),
          bottom: new Decimal('109.45'),
        },
        atr15m: new Decimal('0.25'),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(true);
    expect(result.isReactionConfirmed).toBe(true);
  });

  it('still invalidates a thin bullish POI beyond the ATR buffer', () => {
    const candles = withCandle(makeBullishCandles(), 22, {
      open: '109.8',
      high: '110.0',
      low: '109.2',
      close: '109.3',
    });
    const reaction = withCandle(candles, 23, {
      high: '111.2',
      low: '109.4',
      close: '111',
    });

    // 109.45 - max(0.05, 0.10) = 109.35; a close at 109.3 is a decisive break.
    const result = analyzeVolumeExhaustion(
      bullishInput({
        candles15m: reaction,
        poiZone: {
          top: new Decimal('109.55'),
          bottom: new Decimal('109.45'),
        },
        atr15m: new Decimal('0.25'),
      }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('POI structurally violated on pullback');
    expect(result.failureCode).toBe('POI_VIOLATED');
  });

  it('invalidates a corrective candle that closes through the POI', () => {
    const candles = withCandle(makeBullishCandles(), 22, {
      open: '109.5',
      high: '110',
      low: '108.5',
      close: '108.9',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('POI structurally violated on pullback');
    expect(result.pullbackCandleCount).toBe(3);
  });

  it('invalidates a reaction candle that closes through the POI', () => {
    const candles = withCandle(makeBullishCandles(), 23, {
      open: '110.2',
      high: '111.2',
      low: '108.7',
      close: '108.9',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('POI structurally violated on pullback');
  });

  it('invalidates a bearish pullback that closes above the supply POI', () => {
    const candles = withCandle(makeBearishCandles(), 22, {
      open: '109.5',
      high: '110.5',
      low: '109',
      close: '110.1',
    });

    const result = analyzeVolumeExhaustion(
      bearishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('POI structurally violated on pullback');
  });

  // -------------------------------------------------------------------------
  // Degenerate data and fail-closed preconditions
  // -------------------------------------------------------------------------

  it('fails closed when the candle history is shorter than period + 3', () => {
    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: makeBullishCandles().slice(0, 22) }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('Insufficient history');
    expect(result.baselineVolume.eq(0)).toBe(true);
    expect(result.pullbackCandleCount).toBe(0);
  });

  it('fails closed when baseline volumes are zero', () => {
    const zeroBaseline: Record<number, string> = {};
    for (let i = 0; i < 20; i += 1) zeroBaseline[i] = '0';

    const result = analyzeVolumeExhaustion(
      bullishInput({
        candles15m: withVolumes(makeBullishCandles(), zeroBaseline),
      }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('Zero volume in baseline');
  });

  it('fails closed on a missing volume field', () => {
    const malformed = [
      ...makeBullishCandles().slice(0, 23),
      {
        ...makeBullishCandles()[23],
        volume: undefined as unknown as string,
      },
    ];

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: malformed }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('Malformed 15m candle data');
  });

  it('fails closed when the latest candle does not touch the POI', () => {
    const candles = withCandle(makeBullishCandles(), 23, {
      open: '112',
      high: '113',
      low: '111',
      close: '112.5',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('Touch candle did not touch the POI');
    expect(result.failureCode).toBe('NO_POI_TOUCH');
    expect(result.isReactionConfirmed).toBe(false);
  });

  it('finds a structural equal-high origin without a 2-left/2-right fractal', () => {
    const base = makeBullishCandles();
    // Index 19 and index 20 both print a 120.0 high. The rigid fractal test
    // rejects both (neither has a strictly lower candle on each side), while
    // the structural scan must pick the most recent extreme and see the two
    // corrective candles at indices 21 and 22.
    const candles = withCandle(base, 19, {
      open: '118.5',
      high: '120',
      low: '118',
      close: '119',
    });
    const equalHigh = withCandle(candles, 20, {
      open: '119.5',
      high: '120',
      low: '118.8',
      close: '119.5',
      volume: '100',
    });

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: equalHigh }),
    );

    expect(result.isValid).toBe(true);
    expect(result.isExhausted).toBe(true);
    expect(result.isReactionConfirmed).toBe(true);
    expect(result.pullbackCandleCount).toBe(2);
    expect(result.pullbackOriginTimestamp).toBe(21);
  });

  it('fails closed when no structural extreme sits beyond the POI', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 24; i += 1) {
      // Price oscillates inside the demand POI: no high ever clears the zone
      // top, so there is no structural pullback origin to anchor the volume
      // window. The close remains inside the invalidation buffer.
      candles.push(candle(i + 1, '109.8', '110.0', '109.6', '109.8'));
    }

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.failureCode).toBe('NO_PULLBACK_ORIGIN');
    expect(result.reason).toBe('No valid pullback origin');
  });

  it('evaluates an explicit older touch without borrowing later candles', () => {
    const base = makeBullishCandles();
    const candles = [
      ...base,
      candle(25, '111', '112', '110.5', '111.5'),
      candle(26, '111.5', '112.5', '111', '112'),
    ];

    const primed = analyzeVolumeExhaustion(
      bullishInput({
        candles15m: candles,
        touchCandleTimestamp: 24,
      }),
    );

    expect(primed.isValid).toBe(true);
    expect(primed.isExhausted).toBe(true);
    expect(primed.isReactionConfirmed).toBe(true);
    expect(primed.pullbackCandleCount).toBe(3);

    const latest = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(latest.isValid).toBe(false);
    expect(latest.failureCode).toBe('NO_POI_TOUCH');
  });

  it('fails closed when the explicit touch candle is missing', () => {
    const result = analyzeVolumeExhaustion(
      bullishInput({ touchCandleTimestamp: 9_999 }),
    );

    expect(result.isValid).toBe(false);
    expect(result.failureCode).toBe('TOUCH_CANDLE_NOT_FOUND');
  });

  it('fails closed when atr15m is missing or not positive', () => {
    const result = analyzeVolumeExhaustion(
      bullishInput({ atr15m: new Decimal(0) }),
    );

    expect(result.isValid).toBe(false);
    expect(result.failureCode).toBe('INVALID_ATR');
    expect(result.reason).toBe('Invalid atr15m');
  });

  it('fails closed when only one corrective candle is observable', () => {
    const base = makeBullishCandles();
    // Keep 20 impulse candles, introduce a final higher high, then a single
    // corrective candle and the reaction candle. Length remains 23.
    const candles = [
      ...base.slice(0, 20),
      candle(21, '119.2', '120', '118.8', '119.5', '100'),
      candle(22, '118.5', '118.8', '116.5', '117', '30'),
      candle(23, '112', '112.5', '109.8', '111', '150'),
    ];

    const result = analyzeVolumeExhaustion(
      bullishInput({ candles15m: candles }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('Insufficient corrective candles');
    expect(result.pullbackCandleCount).toBe(1);
  });

  it('fails closed on invalid POI, direction and SMA period inputs', () => {
    expect(
      analyzeVolumeExhaustion(
        bullishInput({
          poiZone: { top: new Decimal(0), bottom: new Decimal('109.5') },
        }),
      ).reason,
    ).toBe('Invalid POI zone');

    expect(
      analyzeVolumeExhaustion({
        ...bullishInput(),
        direction: 'SIDEWAYS' as unknown as 'BULLISH',
      }).reason,
    ).toBe('Invalid direction');

    expect(
      analyzeVolumeExhaustion(bullishInput({ volumeSmaPeriod: 0 })).reason,
    ).toBe('Invalid volumeSmaPeriod');
  });
});
