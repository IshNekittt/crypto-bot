import { Decimal } from 'decimal.js';
import { buildHtfRoadmap } from '../../../src/engine/brain/htfRoadmap';
import type { HtfRoadmapInput } from '../../../src/engine/brain/htfRoadmap';
import type { Candle } from '../../../src/types';
import type {
  LiquidityPool,
  MacroContext,
  Structure,
  Zone,
} from '../../../src/smc/patternRecognizer';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function candle(
  timestamp: number,
  open: string,
  high: string,
  low: string,
  close: string,
): Candle {
  return { timestamp, open, high, low, close, volume: '1' };
}

function structure(
  type: Structure['type'],
  direction: Structure['direction'],
  timestamp: number,
  timeframe = '240',
  isValidated = true,
  price = '100',
): Structure {
  return {
    type,
    direction,
    timestamp,
    price: new Decimal(price),
    isValidated,
    timeframe,
  };
}

function zone(params: {
  type?: Zone['type'];
  top: string;
  bottom: string;
  direction: Zone['direction'];
  timeframe?: Zone['timeframe'];
  mitigated?: boolean;
}): Zone {
  return {
    type: params.type ?? 'OB',
    top: new Decimal(params.top),
    bottom: new Decimal(params.bottom),
    timestamp: 1,
    mitigated: params.mitigated ?? false,
    timeframe: params.timeframe ?? '240',
    direction: params.direction,
  };
}

function pool(
  type: LiquidityPool['type'],
  price: string,
  isTaken = false,
): LiquidityPool {
  return {
    type,
    priceLevel: new Decimal(price),
    points: [],
    isTaken,
    timestamp: 1,
  };
}

function macro(overrides: Partial<MacroContext> = {}): MacroContext {
  return {
    ath: new Decimal(0),
    atl: new Decimal(0),
    htfFvgs: [],
    htfObs: [],
    weeklyLevels: {
      pwh: new Decimal(0),
      pwl: new Decimal(0),
      wo: new Decimal(0),
    },
    dailyLevels: {
      pdh: new Decimal(0),
      pdl: new Decimal(0),
      do: new Decimal(0),
    },
    liquidityPools: [],
    ...overrides,
  };
}

function macroWithLevels(params: {
  pdh?: string;
  pdl?: string;
  pwh?: string;
  pwl?: string;
  ath?: string;
  atl?: string;
  pools?: LiquidityPool[];
}): MacroContext {
  return macro({
    dailyLevels: {
      pdh: new Decimal(params.pdh ?? '0'),
      pdl: new Decimal(params.pdl ?? '0'),
      do: new Decimal(0),
    },
    weeklyLevels: {
      pwh: new Decimal(params.pwh ?? '0'),
      pwl: new Decimal(params.pwl ?? '0'),
      wo: new Decimal(0),
    },
    ath: new Decimal(params.ath ?? '0'),
    atl: new Decimal(params.atl ?? '0'),
    liquidityPools: params.pools ?? [],
  });
}

function input(overrides: Partial<HtfRoadmapInput> = {}): HtfRoadmapInput {
  return {
    candles4h: [],
    structures4h: [],
    zones4h: [],
    macroContext: macro(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Range 100..110, equilibrium 105, close 101 => DISCOUNT. */
function discountCandles(): Candle[] {
  return [
    candle(1, '108', '110', '100', '102'),
    candle(2, '102', '104', '100', '101'),
    candle(3, '101', '103', '100', '101'),
  ];
}

/** Range 100..110, equilibrium 105, close 109 => PREMIUM. */
function premiumCandles(): Candle[] {
  return [
    candle(1, '102', '110', '100', '108'),
    candle(2, '108', '110', '106', '109'),
    candle(3, '109', '110', '108', '109'),
  ];
}

/** Range 100..110, equilibrium 105, close 105 => EQUILIBRIUM. */
function equilibriumCandles(): Candle[] {
  return [
    candle(1, '105', '110', '100', '105'),
    candle(2, '105', '108', '102', '105'),
    candle(3, '105', '107', '103', '105'),
  ];
}

function bullishBos(): Structure[] {
  return [
    structure('BOS', 'BULLISH', 1, '240', true, '104'),
    structure('BOS', 'BULLISH', 2, '240', true, '103'),
  ];
}

function bearishBos(): Structure[] {
  return [
    structure('BOS', 'BEARISH', 1, '240', true, '100'),
    structure('BOS', 'BEARISH', 2, '240', true, '99'),
  ];
}

// ---------------------------------------------------------------------------
// Step A + Step C: dealing range, phase, and bullish targets
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — dealing range and bullish targets', () => {
  it('builds a discount range and targets PDH for a bullish BOS sequence', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BULLISH');
    expect(result.phase).toBe('DISCOUNT');
    expect(result.dealingRange.high.toString()).toBe('110');
    expect(result.dealingRange.low.toString()).toBe('100');
    expect(result.dealingRange.equilibrium.toString()).toBe('105');

    expect(result.primaryTarget).not.toBeNull();
    expect(result.primaryTarget?.price.toString()).toBe('112');
    expect(result.primaryTarget?.label).toBe('PDH');
    expect(result.primaryTarget?.type).toBe('LIQUIDITY_POOL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('11').div(101).toString(),
    );
    expect(result.reason).toBeUndefined();
  });

  it('accepts a single directional 4H BOS when no conflicting structure exists', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: [
          structure('BOS', 'BULLISH', 1, '240', true, '104'),
        ],
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BULLISH');
    expect(result.primaryTarget?.price.toString()).toBe('112');
  });

  it('targets PWH when PDH is below price', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '99', pwh: '111' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BULLISH');
    expect(result.primaryTarget?.price.toString()).toBe('111');
    expect(result.primaryTarget?.label).toBe('PWH');
    expect(result.primaryTarget?.type).toBe('LIQUIDITY_POOL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('10').div(101).toString(),
    );
  });

  it('selects the nearest unmitigated 4H supply FVG and ignores 15m, mitigated, breaker and demand zones', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        zones4h: [
          zone({
            type: 'FVG',
            top: '109',
            bottom: '108',
            direction: 'BEARISH',
            timeframe: '240',
          }),
          zone({
            type: 'OB',
            top: '107.5',
            bottom: '106.5',
            direction: 'BEARISH',
            timeframe: '15',
          }),
          zone({
            type: 'FVG',
            top: '105',
            bottom: '104',
            direction: 'BEARISH',
            timeframe: '240',
            mitigated: true,
          }),
          zone({
            type: 'BREAKER',
            top: '107.2',
            bottom: '106.8',
            direction: 'BEARISH',
            timeframe: '240',
          }),
          zone({
            type: 'OB',
            top: '107',
            bottom: '106',
            direction: 'BULLISH',
            timeframe: '240',
          }),
        ],
        macroContext: macroWithLevels({ pdh: '120' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('108');
    expect(result.primaryTarget?.label).toBe('4H FVG');
    expect(result.primaryTarget?.type).toBe('HTF_ZONE');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('7').div(101).toString(),
    );
  });

  it('prefers a nearer 4H supply OB over a farther FVG', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        zones4h: [
          zone({
            type: 'OB',
            top: '107.5',
            bottom: '106.5',
            direction: 'BEARISH',
            timeframe: '240',
          }),
          zone({
            type: 'FVG',
            top: '109',
            bottom: '108',
            direction: 'BEARISH',
            timeframe: '240',
          }),
        ],
        macroContext: macroWithLevels({ pdh: '120' }),
      }),
    );

    expect(result.primaryTarget?.price.toString()).toBe('106.5');
    expect(result.primaryTarget?.label).toBe('4H OB');
    expect(result.primaryTarget?.type).toBe('HTF_ZONE');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('5.5').div(101).toString(),
    );
  });

  it('gives liquidity priority over a zone at the same price', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        zones4h: [
          zone({
            type: 'OB',
            top: '109',
            bottom: '108',
            direction: 'BEARISH',
            timeframe: '240',
          }),
        ],
        macroContext: macroWithLevels({ pdh: '108' }),
      }),
    );

    expect(result.primaryTarget?.price.toString()).toBe('108');
    expect(result.primaryTarget?.label).toBe('PDH');
    expect(result.primaryTarget?.type).toBe('LIQUIDITY_POOL');
  });
});

// ---------------------------------------------------------------------------
// Bearish targets
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — bearish targets', () => {
  it('builds a premium range and targets PDL for a bearish BOS sequence', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: premiumCandles(),
        structures4h: bearishBos(),
        macroContext: macroWithLevels({ pdl: '98' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BEARISH');
    expect(result.phase).toBe('PREMIUM');
    expect(result.dealingRange.high.toString()).toBe('110');
    expect(result.dealingRange.low.toString()).toBe('100');
    expect(result.dealingRange.equilibrium.toString()).toBe('105');
    expect(result.primaryTarget?.price.toString()).toBe('98');
    expect(result.primaryTarget?.label).toBe('PDL');
    expect(result.primaryTarget?.type).toBe('LIQUIDITY_POOL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('11').div(109).toString(),
    );
  });

  it('targets PWL when PDL is unavailable', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: premiumCandles(),
        structures4h: bearishBos(),
        macroContext: macroWithLevels({ pwl: '97' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BEARISH');
    expect(result.primaryTarget?.price.toString()).toBe('97');
    expect(result.primaryTarget?.label).toBe('PWL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('12').div(109).toString(),
    );
  });

  it('selects the nearest unmitigated 4H demand OB and ignores wrong-direction zones', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: premiumCandles(),
        structures4h: bearishBos(),
        zones4h: [
          zone({
            type: 'OB',
            top: '106',
            bottom: '105',
            direction: 'BULLISH',
            timeframe: '240',
          }),
          zone({
            type: 'FVG',
            top: '105',
            bottom: '104',
            direction: 'BULLISH',
            timeframe: '240',
          }),
          zone({
            type: 'OB',
            top: '108',
            bottom: '107',
            direction: 'BEARISH',
            timeframe: '240',
          }),
        ],
        macroContext: macroWithLevels({ pdl: '98' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('106');
    expect(result.primaryTarget?.label).toBe('4H OB');
    expect(result.primaryTarget?.type).toBe('HTF_ZONE');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('3').div(109).toString(),
    );
  });
});

describe('buildHtfRoadmap — equilibrium phase', () => {
  it('allows a bullish sequence at equilibrium', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: equilibriumCandles(),
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.phase).toBe('EQUILIBRIUM');
    expect(result.bias).toBe('BULLISH');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('112');
  });

  it('allows a bearish sequence at equilibrium', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: equilibriumCandles(),
        structures4h: bearishBos(),
        macroContext: macroWithLevels({ pdl: '98' }),
      }),
    );

    expect(result.phase).toBe('EQUILIBRIUM');
    expect(result.bias).toBe('BEARISH');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('98');
  });
});

// ---------------------------------------------------------------------------
// Step B: neutral / chop rejection
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — structural bias selection', () => {
  it('follows the newest BOS when directions conflict', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: equilibriumCandles(),
        structures4h: [
          structure('BOS', 'BULLISH', 1, '240', true, '104'),
          structure('BOS', 'BEARISH', 2, '240', true, '100'),
        ],
        macroContext: macroWithLevels({ pdh: '112', pdl: '98' }),
      }),
    );

    expect(result.bias).toBe('BEARISH');
    expect(result.phase).toBe('EQUILIBRIUM');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('98');
    expect(result.primaryTarget?.label).toBe('PDL');
    expect(result.reason).toBeUndefined();
  });

  it('keeps a bullish sequence directional in premium (phase is not a trend veto)', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: premiumCandles(),
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '110' }),
      }),
    );

    expect(result.bias).toBe('BULLISH');
    expect(result.phase).toBe('PREMIUM');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('110');
    expect(result.primaryTarget?.label).toBe('PDH');
    expect(result.reason).toBeUndefined();
  });

  it('follows the newest CHoCH when it reverses the active BOS run', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: [
          ...bullishBos(),
          structure('CHOCH', 'BEARISH', 3, '240', true, '101'),
        ],
        macroContext: macroWithLevels({ pdh: '112', pdl: '98' }),
      }),
    );

    expect(result.bias).toBe('BEARISH');
    expect(result.phase).toBe('DISCOUNT');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('98');
    expect(result.primaryTarget?.label).toBe('PDL');
    expect(result.reason).toBeUndefined();
  });

  it('rejects only when no confirmed 4H structure exists', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: [
          structure('BOS', 'BULLISH', 1, '15', true, '104'),
          structure('BOS', 'BULLISH', 2, '15', true, '103'),
        ],
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.bias).toBe('NEUTRAL');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('Insufficient');
  });
});

// ---------------------------------------------------------------------------
// Phase and sweeps never override an intact structural bias
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — structural bias is independent of phase and sweeps', () => {
  it('keeps a bullish sequence BULLISH when a deep-premium high is swept', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '104', '110', '100', '108'),
          candle(2, '108', '110', '107', '109'),
          candle(3, '109', '111', '108', '109.5'),
        ],
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '110', pdl: '98' }),
      }),
    );

    expect(result.bias).toBe('BULLISH');
    expect(result.phase).toBe('PREMIUM');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('110');
    expect(result.primaryTarget?.label).toBe('PDH');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('0.5').div('109.5').toString(),
    );
  });

  it('keeps a bullish sequence BULLISH when the high sweep is not deep', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '104', '110', '100', '108'),
          candle(2, '108', '110', '107', '109'),
          candle(3, '106', '111', '105', '106'),
        ],
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '110', pdl: '98' }),
      }),
    );

    expect(result.bias).toBe('BULLISH');
    expect(result.phase).toBe('PREMIUM');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('110');
  });

  it('keeps a bearish sequence BEARISH when a deep-discount low is swept', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '106', '110', '100', '102'),
          candle(2, '102', '103', '100', '101'),
          candle(3, '101', '102', '99', '100.5'),
        ],
        structures4h: bearishBos(),
        macroContext: macroWithLevels({ pdl: '95' }),
      }),
    );

    expect(result.bias).toBe('BEARISH');
    expect(result.phase).toBe('DISCOUNT');
    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('95');
    expect(result.primaryTarget?.label).toBe('PDL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('5.5').div('100.5').toString(),
    );
  });
});

// ---------------------------------------------------------------------------
// Liquidity targets: EQH / EQL
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — 4H equal highs/lows', () => {
  it('uses a non-taken EQH pool and ignores BSL / taken EQH pools', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        macroContext: macroWithLevels({
          pools: [
            pool('EQH', '107'),
            pool('BSL', '103'),
            pool('EQL', '95'),
            pool('EQH', '108', true),
          ],
        }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('107');
    expect(result.primaryTarget?.label).toBe('4H EQH');
    expect(result.primaryTarget?.type).toBe('LIQUIDITY_POOL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('6').div(101).toString(),
    );
  });

  it('derives 4H EQH from confirmed equal swing highs', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '100', '101', '99', '100'),
          candle(2, '100', '102', '99', '101'),
          candle(3, '101', '103', '100', '102'),
          candle(4, '102', '110', '101', '104'),
          candle(5, '104', '105', '102', '103'),
          candle(6, '103', '104', '101', '102'),
          candle(7, '102', '103', '100', '101'),
          candle(8, '101', '110', '100', '103'),
          candle(9, '103', '104', '100', '101'),
          candle(10, '101', '103', '100', '101'),
          candle(11, '101', '102', '100', '101'),
        ],
        structures4h: bullishBos(),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BULLISH');
    expect(result.phase).toBe('DISCOUNT');
    expect(result.primaryTarget?.price.toString()).toBe('110');
    expect(result.primaryTarget?.label).toBe('4H EQH');
    expect(result.primaryTarget?.type).toBe('LIQUIDITY_POOL');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal('9').div(101).toString(),
    );
  });

  it('ignores 15m zones when selecting the primary target', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        zones4h: [
          zone({
            type: 'FVG',
            top: '105',
            bottom: '104',
            direction: 'BEARISH',
            timeframe: '15',
          }),
        ],
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('112');
    expect(result.primaryTarget?.label).toBe('PDH');
  });

  it('uses only daily structures and zones when the HTF is D', () => {
    const result = buildHtfRoadmap(input({
      htfTimeframe: 'D',
      candles4h: discountCandles(),
      structures4h: [
        ...bullishBos().map(s => ({ ...s, timeframe: 'D' })),
        structure('CHOCH', 'BEARISH', discountCandles().at(-1)!.timestamp, '240'),
      ],
      zones4h: [
        zone({ top: '106', bottom: '105', direction: 'BEARISH', timeframe: '240' }),
        zone({ top: '110', bottom: '109', direction: 'BEARISH', timeframe: 'D' }),
      ],
      macroContext: macroWithLevels({ pdh: '112' }),
    }));
    expect(result.bias).toBe('BULLISH');
    expect(result.primaryTarget?.price.toString()).toBe('109');
    expect(result.primaryTarget?.label).toBe('1D OB');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: fail closed
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — fail-closed edge cases', () => {
  it('fails closed on empty candle input', () => {
    const result = buildHtfRoadmap(input({ candles4h: [] }));

    expect(result.isValid).toBe(false);
    expect(result.bias).toBe('NEUTRAL');
    expect(result.phase).toBe('EQUILIBRIUM');
    expect(result.dealingRange.high.toString()).toBe('0');
    expect(result.dealingRange.low.toString()).toBe('0');
    expect(result.dealingRange.equilibrium.toString()).toBe('0');
    expect(result.primaryTarget).toBeNull();
    expect(result.targetDistancePct.toString()).toBe('0');
    expect(result.reason).toContain('No 4H candles');
  });

  it('fails closed on a single candle', () => {
    const result = buildHtfRoadmap(
      input({ candles4h: [candle(1, '100', '110', '100', '105')] }),
    );

    expect(result.isValid).toBe(false);
    expect(result.bias).toBe('NEUTRAL');
    expect(result.reason).toContain('Insufficient');
  });

  it('fails closed on zero volatility (high equals low)', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '100', '100', '100', '100'),
          candle(2, '100', '100', '100', '100'),
        ],
      }),
    );

    expect(result.isValid).toBe(false);
    expect(result.bias).toBe('NEUTRAL');
    expect(result.reason).toContain('Degenerate');
  });

  it('fails closed on malformed OHLC', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '100', '110', '100', '105'),
          candle(2, '100', '90', '95', '100'),
        ],
      }),
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('Malformed');
  });

  it('reports a bullish bias but null target when no liquidity or zone exists above price', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
      }),
    );

    expect(result.bias).toBe('BULLISH');
    expect(result.isValid).toBe(false);
    expect(result.primaryTarget).toBeNull();
    expect(result.targetDistancePct.toString()).toBe('0');
    expect(result.reason).toContain('No 4H liquidity pool');
  });

  it('ignores targets at or below the current close and falls through to the next level', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        zones4h: [
          zone({
            type: 'FVG',
            top: '101.5',
            bottom: '101',
            direction: 'BEARISH',
            timeframe: '240',
          }),
          zone({
            type: 'OB',
            top: '101',
            bottom: '100.5',
            direction: 'BEARISH',
            timeframe: '240',
          }),
        ],
        macroContext: macroWithLevels({ pdh: '104' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.primaryTarget?.price.toString()).toBe('104');
    expect(result.primaryTarget?.label).toBe('PDH');
    expect(result.targetDistancePct.toString()).toBe(
      new Decimal(3).div(101).toString(),
    );
  });

  it('returns a null target and zero distance when only zero-distance targets exist', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: discountCandles(),
        structures4h: bullishBos(),
        zones4h: [
          zone({
            type: 'OB',
            top: '102',
            bottom: '101',
            direction: 'BEARISH',
            timeframe: '240',
          }),
        ],
      }),
    );

    expect(result.bias).toBe('BULLISH');
    expect(result.isValid).toBe(false);
    expect(result.primaryTarget).toBeNull();
    expect(result.targetDistancePct.toString()).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Range construction
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — active dealing range', () => {
  it('starts the range at the latest confirmed 4H CHoCH', () => {
    const result = buildHtfRoadmap(
      input({
        candles4h: [
          candle(1, '195', '200', '190', '195'),
          candle(2, '101', '110', '100', '108'),
          candle(3, '108', '110', '105', '107'),
          candle(4, '107', '109', '104', '106'),
          candle(5, '106', '108', '102', '103'),
        ],
        structures4h: [
          structure('CHOCH', 'BULLISH', 2, '240', true, '106'),
          structure('BOS', 'BULLISH', 3, '240', true, '108'),
          structure('BOS', 'BULLISH', 4, '240', true, '109'),
        ],
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BULLISH');
    expect(result.phase).toBe('DISCOUNT');
    expect(result.dealingRange.high.toString()).toBe('110');
    expect(result.dealingRange.low.toString()).toBe('100');
    expect(result.dealingRange.equilibrium.toString()).toBe('105');
  });

  it('falls back to the last 50 4H candles when no CHoCH is available', () => {
    const candles: Candle[] = [candle(1, '195', '200', '190', '195')];
    for (let i = 2; i <= 60; i += 1) {
      candles.push(candle(i, '101', '110', '100', '101'));
    }

    const result = buildHtfRoadmap(
      input({
        candles4h: candles,
        structures4h: bullishBos(),
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.phase).toBe('DISCOUNT');
    expect(result.dealingRange.high.toString()).toBe('110');
    expect(result.dealingRange.low.toString()).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe('buildHtfRoadmap — input immutability', () => {
  it('does not mutate or reorder the caller arrays', () => {
    const candles4h = Object.freeze([
      candle(2, '102', '104', '100', '101'),
      candle(1, '108', '110', '100', '102'),
      candle(3, '101', '103', '100', '101'),
    ]);

    const structures4h = Object.freeze([
      structure('BOS', 'BULLISH', 2, '240', true, '103'),
      structure('BOS', 'BULLISH', 1, '240', true, '104'),
    ]);

    const zones4h = Object.freeze([
      zone({
        type: 'FVG',
        top: '109',
        bottom: '108',
        direction: 'BEARISH',
        timeframe: '240',
      }),
      zone({
        type: 'FVG',
        top: '105',
        bottom: '104',
        direction: 'BEARISH',
        timeframe: '240',
        mitigated: true,
      }),
    ]);

    const candlesBefore = JSON.stringify(candles4h);
    const structuresBefore = JSON.stringify(structures4h);
    const zonesBefore = JSON.stringify(zones4h);

    const result = buildHtfRoadmap(
      input({
        candles4h,
        structures4h,
        zones4h,
        macroContext: macroWithLevels({ pdh: '112' }),
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.bias).toBe('BULLISH');
    expect(JSON.stringify(candles4h)).toBe(candlesBefore);
    expect(JSON.stringify(structures4h)).toBe(structuresBefore);
    expect(JSON.stringify(zones4h)).toBe(zonesBefore);
  });
});
