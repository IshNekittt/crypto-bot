import { Decimal } from 'decimal.js';
import {
  resolveTakeProfit,
  TpResolveInput,
  TpResolution,
} from '../../src/engine/tpResolver';
import type {
  LiquidityPool,
  MacroContext,
  SessionRange,
  TradingRange,
  Zone,
} from '../../src/smc/patternRecognizer';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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

function zone(params: {
  top: string;
  bottom: string;
  direction: 'BULLISH' | 'BEARISH';
  timeframe?: Zone['timeframe'];
  mitigated?: boolean;
  type?: Zone['type'];
}): Zone {
  return {
    type: params.type ?? 'OB',
    top: new Decimal(params.top),
    bottom: new Decimal(params.bottom),
    timestamp: 1,
    mitigated: params.mitigated ?? false,
    timeframe: params.timeframe ?? '15',
    direction: params.direction,
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

function range(high: string, low: string): TradingRange {
  const h = new Decimal(high);
  const l = new Decimal(low);
  return {
    high: h,
    low: l,
    equilibrium: h.plus(l).div(2),
    isDeviated: false,
  };
}

function session(
  name: SessionRange['name'],
  high: string,
  low: string,
): SessionRange {
  return {
    name,
    high: new Decimal(high),
    low: new Decimal(low),
    start: 0,
    end: 1,
  };
}

/**
 * Entry 100 / SL 99 => R = 1, so a price delta maps 1:1 onto R units.
 * This keeps every expectation readable.
 */
function input(overrides: Partial<TpResolveInput> = {}): TpResolveInput {
  return {
    direction: 'BULLISH',
    entry: new Decimal(100),
    stopLoss: new Decimal(99),
    zones: [],
    liquidityPools: [],
    tradingRange: null,
    macroContext: null,
    sessionRanges: [],
    minRr: new Decimal('1.5'),
    maxRr: new Decimal(6),
    fixedRr: new Decimal(3),
    enableDynamicTp: true,
    requireTarget: false,
    ...overrides,
  };
}

function expectOk(result: TpResolution): Extract<TpResolution, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected ok:true but got rejection: ${result.reason}`);
  }
  return result;
}

function expectReject(
  result: TpResolution,
): Extract<TpResolution, { ok: false }> {
  if (result.ok) {
    throw new Error(
      `Expected ok:false but got TP=${result.takeProfit.toString()}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Toggle OFF — legacy fixed multiple must be preserved byte-for-byte
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — dynamic TP disabled', () => {
  it('returns entry + fixedRr * R for longs', () => {
    const result = expectOk(
      resolveTakeProfit(input({ enableDynamicTp: false })),
    );
    expect(result.takeProfit.toString()).toBe('103');
    expect(result.rr.toString()).toBe('3');
    expect(result.source).toBe('FIXED_FALLBACK');
    expect(result.nearest).toBeNull();
  });

  it('returns entry - fixedRr * R for shorts', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          direction: 'BEARISH',
          entry: new Decimal(100),
          stopLoss: new Decimal(101),
          enableDynamicTp: false,
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('97');
    expect(result.rr.toString()).toBe('3');
  });

  it('ignores structural candidates entirely when disabled', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          enableDynamicTp: false,
          liquidityPools: [pool('PDH', '104')],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('103');
  });

  it('honours a non-default fixedRr', () => {
    const result = expectOk(
      resolveTakeProfit(input({ enableDynamicTp: false, fixedRr: new Decimal(2) })),
    );
    expect(result.takeProfit.toString()).toBe('102');
  });
});

// ---------------------------------------------------------------------------
// Liquidity pools
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — liquidity pools', () => {
  it('snaps a long to the nearest pool above entry', () => {
    const result = expectOk(
      resolveTakeProfit(input({ liquidityPools: [pool('PDH', '104')] })),
    );
    expect(result.takeProfit.toString()).toBe('104');
    expect(result.rr.toString()).toBe('4');
    expect(result.source).toBe('LIQUIDITY_POOL');
    expect(result.label).toBe('PDH liquidity');
  });

  it('snaps a short to the nearest pool below entry', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          direction: 'BEARISH',
          stopLoss: new Decimal(101),
          liquidityPools: [pool('PDL', '96')],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('96');
    expect(result.rr.toString()).toBe('4');
  });

  it('selects the nearest of several candidates', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          liquidityPools: [
            pool('PDH', '106'),
            pool('EQH', '102.5'),
            pool('PWH', '104'),
          ],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('102.5');
  });

  it('ignores pools behind the entry', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({ liquidityPools: [pool('PDL', '98'), pool('SSL', '95')] }),
      ),
    );
    // No candidate beyond entry -> fixed fallback
    expect(result.source).toBe('FIXED_FALLBACK');
    expect(result.takeProfit.toString()).toBe('103');
  });

  it('ignores already-taken pools', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({ liquidityPools: [pool('PDH', '104', true)] }),
      ),
    );
    expect(result.source).toBe('FIXED_FALLBACK');
  });

  it('supports macro context levels when no pool array is supplied', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          macroContext: macro({
            dailyLevels: {
              pdh: new Decimal(104),
              pdl: new Decimal(96),
              do: new Decimal(100),
            },
          }),
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('104');
    expect(result.label).toBe('PDH level');
  });
});

// ---------------------------------------------------------------------------
// Zones — near edge, opposing direction, mitigation
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — zones', () => {
  it('targets the near (lower) edge of a bearish zone above a long', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          zones: [zone({ top: '107', bottom: '105', direction: 'BEARISH' })],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('105');
    expect(result.source).toBe('LTF_ZONE');
    expect(result.label).toBe('15 OB');
  });

  it('handles inverted zone ordering via min/max', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          zones: [zone({ top: '105', bottom: '107', direction: 'BEARISH' })],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('105');
  });

  it('targets the near (upper) edge of a bullish zone below a short', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          direction: 'BEARISH',
          stopLoss: new Decimal(101),
          zones: [zone({ top: '96', bottom: '94', direction: 'BULLISH' })],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('96');
  });

  it('classifies 4H zones as HTF_ZONE', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          zones: [
            zone({
              top: '107',
              bottom: '105',
              direction: 'BEARISH',
              timeframe: '240',
            }),
          ],
        }),
      ),
    );
    expect(result.source).toBe('HTF_ZONE');
    expect(result.label).toBe('240 OB');
  });

  it('ignores mitigated zones', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          zones: [
            zone({
              top: '107',
              bottom: '105',
              direction: 'BEARISH',
              mitigated: true,
            }),
          ],
        }),
      ),
    );
    expect(result.source).toBe('FIXED_FALLBACK');
  });

  it('ignores same-direction zones (a bullish FVG is not resistance)', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          zones: [zone({ top: '107', bottom: '105', direction: 'BULLISH' })],
        }),
      ),
    );
    expect(result.source).toBe('FIXED_FALLBACK');
  });

  it('prefers liquidity over a zone at the same price', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('PDH', '105')],
          zones: [zone({ top: '106', bottom: '105', direction: 'BEARISH' })],
        }),
      ),
    );
    expect(result.source).toBe('LIQUIDITY_POOL');
  });
});

// ---------------------------------------------------------------------------
// THE WALL FILTER — reject, never clamp
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — minimum R:R (wall filter)', () => {
  it('rejects when the nearest target is closer than minRr', () => {
    const result = expectReject(
      resolveTakeProfit(input({ liquidityPools: [pool('PDH', '101')] })),
    );
    expect(result.reason).toContain('Insufficient room');
    expect(result.reason).toContain('1.00R');
    expect(result.reason).toContain('1.50R');
    expect(result.nearest?.price.toString()).toBe('101');
  });

  it('accepts a target exactly at minRr', () => {
    const result = expectOk(
      resolveTakeProfit(input({ liquidityPools: [pool('PDH', '101.5')] })),
    );
    expect(result.takeProfit.toString()).toBe('101.5');
    expect(result.rr.toString()).toBe('1.5');
  });

  it('rejects a wall even when a valid target exists further away', () => {
    // The nearest obstacle is what the market reaches first — a 5R pool behind
    // a 1R wall is unreachable, so the setup must still be rejected.
    const result = expectReject(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('PDH', '101'), pool('PWH', '105')],
        }),
      ),
    );
    expect(result.reason).toContain('Insufficient room');
  });

  it('rejects a short whose nearest demand zone is too close', () => {
    const result = expectReject(
      resolveTakeProfit(
        input({
          direction: 'BEARISH',
          stopLoss: new Decimal(101),
          zones: [zone({ top: '99.2', bottom: '98', direction: 'BULLISH' })],
        }),
      ),
    );
    expect(result.reason).toContain('Insufficient room');
  });
});

// ---------------------------------------------------------------------------
// Max R:R clamp
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — maximum R:R clamp', () => {
  it('clamps a distant target to maxRr', () => {
    const result = expectOk(
      resolveTakeProfit(input({ liquidityPools: [pool('PWH', '112')] })),
    );
    expect(result.takeProfit.toString()).toBe('106');
    expect(result.rr.toString()).toBe('6');
    // Source stays the real obstacle so clamping is still observable downstream.
    expect(result.source).toBe('LIQUIDITY_POOL');
    expect(result.nearest?.rr.toString()).toBe('12');
  });

  it('clamps shorts symmetrically', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          direction: 'BEARISH',
          stopLoss: new Decimal(101),
          liquidityPools: [pool('PWL', '88')],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('94');
    expect(result.rr.toString()).toBe('6');
  });

  it('does not clamp a target inside the ceiling', () => {
    const result = expectOk(
      resolveTakeProfit(input({ liquidityPools: [pool('PDH', '105')] })),
    );
    expect(result.takeProfit.toString()).toBe('105');
    expect(result.rr.toString()).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// No-candidate behaviour
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — no structural target', () => {
  it('falls back to fixedRr when requireTarget is false', () => {
    const result = expectOk(resolveTakeProfit(input({ requireTarget: false })));
    expect(result.takeProfit.toString()).toBe('103');
    expect(result.source).toBe('FIXED_FALLBACK');
    expect(result.label).toContain('no structural target');
  });

  it('rejects when requireTarget is true', () => {
    const result = expectReject(resolveTakeProfit(input({ requireTarget: true })));
    expect(result.reason).toContain('No opposing structural target');
    expect(result.nearest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Range equilibrium / session ranges
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — derived levels', () => {
  it('ignores equilibrium sitting exactly at entry', () => {
    // range 110/90 => EQ = 100 = entry, which is not *beyond* the entry.
    const result = expectOk(
      resolveTakeProfit(input({ tradingRange: range('110', '90') })),
    );
    expect(result.source).toBe('FIXED_FALLBACK');
    expect(result.takeProfit.toString()).toBe('103');
  });

  it('targets range equilibrium when it sits beyond entry', () => {
    const result = expectOk(
      resolveTakeProfit(input({ tradingRange: range('112', '94') })),
    );
    // EQ = 103
    expect(result.takeProfit.toString()).toBe('103');
    expect(result.source).toBe('RANGE_EQUILIBRIUM');
  });

  it('targets the session high for a long', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({ sessionRanges: [session('ASIAN', '104', '98')] }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('104');
    expect(result.source).toBe('SESSION_RANGE');
    expect(result.label).toBe('ASIAN range high');
  });

  it('targets the session low for a short', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          direction: 'BEARISH',
          stopLoss: new Decimal(101),
          sessionRanges: [session('NY', '104', '96')],
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('96');
    expect(result.label).toBe('NY range low');
  });
});

// ---------------------------------------------------------------------------
// Macro-only wall filter (skipMinorObstacles)
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — macro-only wall filter', () => {
  it('legacy mode still rejects on the nearest minor swing', () => {
    const result = expectReject(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('BSL', '101'), pool('PDH', '105')],
        }),
      ),
    );
    expect(result.reason).toContain('Insufficient room');
    expect(result.reason).toContain('1.00R');
    expect(result.nearest?.label).toBe('BSL liquidity');
  });

  it('skips a minor swing inside the floor and targets the macro pool beyond it', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('BSL', '101'), pool('PDH', '105')],
          skipMinorObstacles: true,
        }),
      ),
    );
    expect(result.takeProfit.toString()).toBe('105');
    expect(result.rr.toString()).toBe('5');
    expect(result.nearest?.label).toBe('PDH liquidity');
    expect(result.nearest?.major).toBe(true);
  });

  it('still rejects on a MAJOR barrier inside the floor', () => {
    const result = expectReject(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('PDH', '101'), pool('PWH', '105')],
          skipMinorObstacles: true,
        }),
      ),
    );
    expect(result.reason).toContain('Insufficient room');
    expect(result.reason).toContain('major obstacle');
    expect(result.nearest?.label).toBe('PDH liquidity');
  });

  it('rejects when only minor obstacles exist and none clears the floor', () => {
    const result = expectReject(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('BSL', '101')],
          skipMinorObstacles: true,
        }),
      ),
    );
    expect(result.reason).toContain('Insufficient room');
    expect(result.reason).toContain('no structural target');
  });

  it('treats caller-forced targets as major regardless of pool type', () => {
    const result = expectReject(
      resolveTakeProfit(
        input({
          liquidityPools: [pool('BSL', '101')],
          skipMinorObstacles: true,
          majorTargets: [new Decimal('101')],
        }),
      ),
    );
    expect(result.reason).toContain('major obstacle');
    expect(result.nearest?.major).toBe(true);
  });

  it('keeps the legacy 15m zone a minor obstacle', () => {
    const result = expectOk(
      resolveTakeProfit(
        input({
          zones: [
            zone({ top: '101.2', bottom: '101.0', direction: 'BEARISH', timeframe: '15' }),
            zone({ top: '105', bottom: '104.5', direction: 'BEARISH', timeframe: '240' }),
          ],
          skipMinorObstacles: true,
        }),
      ),
    );
    expect(result.source).toBe('HTF_ZONE');
    expect(result.takeProfit.toString()).toBe('104.5');
  });
});

// ---------------------------------------------------------------------------
// Invalid inputs
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — invalid inputs', () => {
  it('rejects a zero-R stop', () => {
    const result = expectReject(
      resolveTakeProfit(input({ stopLoss: new Decimal(100) })),
    );
    expect(result.reason).toContain('zero');
  });

  it('rejects a non-positive entry', () => {
    const result = expectReject(
      resolveTakeProfit(input({ entry: new Decimal(0) })),
    );
    expect(result.reason).toContain('Invalid entry price');
  });

  it('rejects a non-positive fixedRr', () => {
    const result = expectReject(
      resolveTakeProfit(input({ fixedRr: new Decimal(0) })),
    );
    expect(result.reason).toContain('fixedRr');
  });

  it('rejects non-positive min/max R:R', () => {
    expect(
      expectReject(resolveTakeProfit(input({ minRr: new Decimal(0) }))).reason,
    ).toContain('minRr/maxRr');
  });
});

// ---------------------------------------------------------------------------
// Side invariant & purity
// ---------------------------------------------------------------------------

describe('resolveTakeProfit — invariants', () => {
  it('always returns a target strictly beyond entry for a long', () => {
    const cases = ['101.5', '103', '105', '110'];
    for (const price of cases) {
      const result = expectOk(
        resolveTakeProfit(input({ liquidityPools: [pool('PDH', price)] })),
      );
      expect(result.takeProfit.gt(new Decimal(100))).toBe(true);
    }
  });

  it('always returns a target strictly beyond entry for a short', () => {
    const cases = ['98.5', '97', '95', '90'];
    for (const price of cases) {
      const result = expectOk(
        resolveTakeProfit(
          input({
            direction: 'BEARISH',
            stopLoss: new Decimal(101),
            liquidityPools: [pool('PDL', price)],
          }),
        ),
      );
      expect(result.takeProfit.lt(new Decimal(100))).toBe(true);
    }
  });

  it('never mutates the input Decimal instances', () => {
    const entry = new Decimal(100);
    const stopLoss = new Decimal(99);
    const minRr = new Decimal('1.5');
    const result = resolveTakeProfit(
      input({
        entry,
        stopLoss,
        minRr,
        liquidityPools: [pool('PDH', '104')],
      }),
    );

    expectOk(result);
    expect(entry.toString()).toBe('100');
    expect(stopLoss.toString()).toBe('99');
    expect(minRr.toString()).toBe('1.5');
  });

  it('is deterministic across repeated calls', () => {
    const make = () =>
      resolveTakeProfit(
        input({
          liquidityPools: [pool('PDH', '104'), pool('EQH', '104')],
        }),
      );
    const a = expectOk(make());
    const b = expectOk(make());
    expect(a.takeProfit.toString()).toBe(b.takeProfit.toString());
    expect(a.source).toBe(b.source);
  });
});
