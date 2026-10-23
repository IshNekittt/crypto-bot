import { Scenario12_SniperTouch } from '../../src/engine/scenarios/Scenario12_SniperTouch';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../src/config/env';

const mockConfig: BotConfig = {
  apiKey: '',
  apiSecret: '',
  testnet: false,
  demoTrading: true,
  symbols: [],
  riskPercent: '2',
  reducedRiskPercent: '1',
  leverage: '10',
  dataDir: 'data',
  historyCandles: 200,
  ltfTimeframe: '15',
  htfTimeframe: '240',
  macroCandles: 1000,
  telegramBotToken: null,
  telegramChatId: null,
  databaseUrl: null,
  autoTrading: false,
  tradeApprovalTimeoutMinutes: 5,
  enableLiveTestOrders: false,
  activeScenarios: [12],
  enableFundingMonitor: false,
  fundingMonitorSymbols: [],
  fundingAlertThresholdPct: '0.0',
  fundingRestoreThresholdPct: '0.0001',
  symbolScenarios: new Map(),
  backtestCsvPath: null,
  cooldownCandles: 16,
  smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5',
  sniperDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6,
  sniperLimitExpirationCandles: 15,
  smcSweepMinWickRatio: new Decimal('0.25'),
  smartEntryThresholdPct: '0.0015',
  enableSniperMode: true,
  enableDynamicTp: false,
  fixedTpRr: new Decimal(3),
  dynamicTpMinRr: new Decimal('1.5'),
  dynamicTpMaxRr: new Decimal(6),
  dynamicTpRequireTarget: false,
  minTpDistancePct: new Decimal('0.0035'),
  backtestDays: 60,
  useLocalCacheOnly: false,
  maxWorkingCapital: 0,
  preflightBufferPct: '0.05',
  enableHealthcheckServer: false,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  enforceKillzones: true,
  enableTradeNotifications: true,
};

const BASE_TS = 1788675600000; // London killzone
const MINUTE = 60_000;
const SWEEP_INDEX = 20;
const OB_INDEX = 29;
const CHOCH_INDEX = 30;
const SWING_HIGH_INDEX = 10;
const PDL = new Decimal(100);

function candle(index: number, overrides: Record<string, string> = {}) {
  return {
    timestamp: BASE_TS + index * MINUTE,
    open: '100.5',
    high: '100.8',
    low: '100.4',
    close: '100.6',
    volume: '1',
    ...overrides,
  };
}

/**
 * 60 one-minute candles forming a bullish Sniper setup:
 * - index 10: confirmed swing high at 101.0
 * - index 20: PDL (100) sweep candle (low 99.8, close 100.5, lower wick 70% of range)
 * - index 29: bearish OB candle (top 101.05 / bottom 100.7), near the swept level
 * - index 30: bullish CHoCH closing at 101.4 (body 0.65)
 *
 * ATR(1m) of the trailing flat candles is 0.4 and the displacement multiplier is
 * 1.5 (the strict default), so a structure break needs a body of at least 0.6.
 */
function buildCandles(options: { sweepAfterChoch?: boolean; farOb?: boolean } = {}) {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i));

  candles[SWING_HIGH_INDEX] = candle(SWING_HIGH_INDEX, {
    open: '100.7',
    high: '101.0',
    low: '100.5',
    close: '100.9',
  });

  const sweepIndex = options.sweepAfterChoch ? 40 : SWEEP_INDEX;
  candles[sweepIndex] = candle(sweepIndex, {
    open: '100.6',
    high: '100.8',
    low: '99.8',
    close: '100.5',
  });

  if (options.farOb) {
    // OB at ~103 (3.0 from the swept 100 level) while the CHoCH closes at 101.01,
    // only 1.01 away. The OB must still be rejected as spatially disconnected.
    candles[OB_INDEX] = candle(OB_INDEX, {
      open: '103.1',
      high: '103.2',
      low: '103.0',
      close: '103.05',
    });
    candles[CHOCH_INDEX] = candle(CHOCH_INDEX, {
      open: '103.3',
      high: '103.35',
      low: '100.95',
      close: '101.01',
    });
  } else {
    candles[OB_INDEX] = candle(OB_INDEX, {
      open: '101.0',
      high: '101.05',
      low: '100.7',
      close: '100.85',
    });

    candles[CHOCH_INDEX] = candle(CHOCH_INDEX, {
      open: '100.75',
      high: '101.45',
      low: '100.7',
      close: '101.4',
    });
  }

  return candles;
}

/**
 * Closed 4H history for the persistent trend gate.
 *
 * S12 now fails closed below 20 closed 4H candles, so an empty `candles4h` would
 * disable every fixture. The default series is an uptrend whose last close sits
 * comfortably above the SMA50; `direction: 'down'` mirrors it for counter-trend
 * tests.
 */
function buildHtfCandles(direction: 'up' | 'down' = 'up', count = 60) {
  return Array.from({ length: count }, (_, i) => {
    const price = direction === 'up' ? 90 + i * 0.2 : 110 - i * 0.2;
    return {
      timestamp: BASE_TS - (count - i) * 4 * 60 * MINUTE,
      open: (price - 0.1).toFixed(4),
      high: (price + 0.3).toFixed(4),
      low: (price - 0.3).toFixed(4),
      close: price.toFixed(4),
      volume: '100',
    };
  });
}

function buildPatternData(candles: any[], options: { atr15m?: Decimal } = {}) {
  return {
    candles15m: candles,
    candles4h: buildHtfCandles(),
    macroContext: {
      ath: new Decimal(200),
      atl: new Decimal(1),
      htfFvgs: [],
      htfObs: [],
      weeklyLevels: {
        pwh: new Decimal(200),
        pwl: new Decimal(1),
        wo: new Decimal(100),
      },
      dailyLevels: {
        pdh: new Decimal(200),
        pdl: PDL,
        do: new Decimal(100),
      },
      liquidityPools: [],
    },
    currentSession: 'LONDON',
    currentKillzone: 'LONDON',
    sessionRanges: [],
    // Dealing range deliberately centred on the OB midpoint (100.875) so the
    // fixture sits at equilibrium: the premium/discount filter is neutral here
    // and each filter gets its own dedicated test below.
    tradingRange: {
      high: new Decimal('101.75'),
      low: new Decimal('100'),
      equilibrium: new Decimal('100.875'),
      isDeviated: false,
    },
    liquidityPools: [],
    structures: [],
    zones: [],
    swingPoints: [],
    atr15m: options.atr15m ?? new Decimal(1),
    atr4h: new Decimal(1),
    patternRecognizer: 'PatternRecognizer',
    candles1m: candles,
    mitigatedStructures: [],
  } as any;
}

describe('Scenario12: Sniper Touch (1m Macro)', () => {
  let scenario: Scenario12_SniperTouch;

  beforeEach(() => {
    scenario = new Scenario12_SniperTouch(mockConfig);
  });

  it('triggers on a CHoCH that occurs after the sweep and near the swept level', () => {
    const candles = buildCandles();
    const result = scenario.evaluate(buildPatternData(candles));

    expect(result).toBe(true);

    const levels = scenario.getLevels();
    expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    expect(levels.entry.lt(levels.takeProfit)).toBe(true);

    // Invariant 21: no synthetic macro zone is emitted — only the 1m CHoCH structure.
    expect(scenario.getZoneDetails()).toBeNull();
    const structure = scenario.getStructureDetails();
    expect(structure).not.toBeNull();
    expect(structure?.type).toBe('CHoCH');
    expect(structure?.timestamp).toBe(candles[CHOCH_INDEX].timestamp);
  });

  it('rejects a CHoCH that formed before the sweep (causality)', () => {
    const candles = buildCandles({ sweepAfterChoch: true });
    const result = scenario.evaluate(buildPatternData(candles));

    expect(result).toBe(false);
    expect(scenario.getReason()).toMatch(/No CHoCH after sweep of PDL/);
  });

  it('rejects a setup whose CHoCH/OB is far from the swept level (proximity)', () => {
    const candles = buildCandles();
    // atr15m 0.1 → tolerance = max(0.1, 100 * 0.003) = 0.3; OB distance is 0.7.
    const result = scenario.evaluate(buildPatternData(candles, { atr15m: new Decimal('0.1') }));

    expect(result).toBe(false);
    expect(scenario.getReason()).toMatch(/Entry too far from swept PDL/);
  });

  it('rejects when the CHoCH is near the level but its entry OB forms far away', () => {
    const candles = buildCandles({ farOb: true });
    // Tolerance 1.05: CHoCH distance is 1.01, but the OB MIDPOINT is 3.1 away.
    const result = scenario.evaluate(buildPatternData(candles, { atr15m: new Decimal('1.05') }));

    expect(result).toBe(false);
    expect(scenario.getReason()).toMatch(/Entry too far from swept PDL/);
    expect(scenario.getReason()).toMatch(/OB_MID=3\.1000/);
  });

  it('rejects a CHoCH whose timestamp was already mitigated (ghost protection)', () => {
    const candles = buildCandles();
    const patternData = buildPatternData(candles);
    patternData.mitigatedStructures = [
      { type: 'CHoCH', direction: 'BULLISH', price: '101.4', timestamp: candles[CHOCH_INDEX].timestamp },
    ];

    const result = scenario.evaluate(patternData);

    expect(result).toBe(false);
    expect(scenario.getReason()).toMatch(/No fresh CHoCH/);
  });
});

// ---------------------------------------------------------------------------
// Sweep sources, per-CHoCH causality, dedupe and proximity bands
// ---------------------------------------------------------------------------

describe('Scenario12: Sniper sweep sources', () => {
  function withSessionLow(data: any, low: string) {
    data.sessionRanges = [
      {
        name: 'ASIAN',
        high: new Decimal(200),
        low: new Decimal(low),
        start: BASE_TS,
        end: BASE_TS + 4 * 60 * MINUTE,
      },
    ];
    return data;
  }

  function poolAt(price: string, type: 'EQH' | 'EQL' = 'EQL') {
    return {
      type,
      priceLevel: new Decimal(price),
      points: [],
      isTaken: false,
      timestamp: 1,
    } as any;
  }

  it('pairs a CHoCH with the sweep that preceded it even when another level is swept later', () => {
    const candles = buildCandles();
    // A later PDH sweep at index 40 must NOT move the causality anchor past the
    // CHoCH at index 30. Under the old global "latest sweep" rule this setup was
    // rejected even though the PDL sweep at index 20 caused the reversal.
    candles[40] = candle(40, {
      open: '101.5',
      high: '101.65',
      low: '101.4',
      close: '101.5',
    });

    const patternData = buildPatternData(candles);
    patternData.macroContext.dailyLevels.pdh = new Decimal('101.6');

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(patternData)).toBe(true);
    expect(s.getReason()).toContain('PDL');
    expect(s.getStructureDetails()?.timestamp).toBe(candles[CHOCH_INDEX].timestamp);
  });

  it('still rejects a CHoCH that precedes the sweep of its OWN source', () => {
    const candles = buildCandles({ sweepAfterChoch: true });
    const patternData = buildPatternData(candles);
    // The only swept level (PDL) is swept after the CHoCH: no valid pairing exists.
    expect(new Scenario12_SniperTouch(mockConfig).evaluate(patternData)).toBe(false);
  });

  it('ignores session extremes when S12_SESSION_SWEEPS is off (default)', () => {
    const patternData = buildPatternData(buildCandles(), { atr15m: new Decimal(2) });
    // Move every macro level away from the sweep wick: only the ASIAN low is swept.
    patternData.macroContext.dailyLevels.pdl = new Decimal(90);
    withSessionLow(patternData, '100');

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toMatch(/No valid sweep/);
  });

  it('uses the newest ASIAN low as a sweep source when S12_SESSION_SWEEPS is on', () => {
    const patternData = buildPatternData(buildCandles(), { atr15m: new Decimal(2) });
    patternData.macroContext.dailyLevels.pdl = new Decimal(90);
    withSessionLow(patternData, '100');

    const s = new Scenario12_SniperTouch({ ...mockConfig, s12SessionSweeps: true });
    expect(s.evaluate(patternData)).toBe(true);
    expect(s.getReason()).toContain('ASIAN LOW');
    expect(s.getReason()).toContain('SESSION');
  });

  it('ignores EQH/EQL when S12_EQH_EQL_SWEEPS is off (default)', () => {
    const patternData = buildPatternData(buildCandles(), { atr15m: new Decimal(2) });
    patternData.macroContext.dailyLevels.pdl = new Decimal(90);
    patternData.liquidityPools = [poolAt('100', 'EQL')];

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toMatch(/No valid sweep/);
  });

  it('uses EQL as a sweep source when S12_EQH_EQL_SWEEPS is on', () => {
    const patternData = buildPatternData(buildCandles(), { atr15m: new Decimal(2) });
    patternData.macroContext.dailyLevels.pdl = new Decimal(90);
    patternData.liquidityPools = [poolAt('100', 'EQL')];

    const s = new Scenario12_SniperTouch({ ...mockConfig, s12EqhEqlSweeps: true });
    expect(s.evaluate(patternData)).toBe(true);
    expect(s.getReason()).toContain('EQL');
    expect(s.getReason()).toContain('EQH_EQL');
  });

  it('dedupes equal-priced sources with macro priority (PDH > Session > EQH/EQL)', () => {
    // PDL, the ASIAN low and an EQL all print 100. If an intraday source owned the
    // duplicated price, the tighter 0.5 ATR band would reject the 0.875 OB distance;
    // only the macro PDL (1.0 ATR) admits it.
    const patternData = buildPatternData(buildCandles(), { atr15m: new Decimal(1) });
    withSessionLow(patternData, '100');
    patternData.liquidityPools = [poolAt('100', 'EQL')];

    const s = new Scenario12_SniperTouch({
      ...mockConfig,
      s12SessionSweeps: true,
      s12EqhEqlSweeps: true,
    });

    expect(s.evaluate(patternData)).toBe(true);
    expect(s.getReason()).toContain('PDL');
    expect(s.getReason()).toContain('MACRO');
  });

  it('uses 1.0 ATR15m for macro sweeps and only 0.5 ATR15m for intraday sweeps', () => {
    // OB midpoint (100.875) is 0.875 from the swept level. At ATR15m = 1.5 the
    // macro band is 1.5 (pass) while the intraday band is 0.75 (fail).
    const macro = new Scenario12_SniperTouch(mockConfig);
    expect(
      macro.evaluate(buildPatternData(buildCandles(), { atr15m: new Decimal('1.5') })),
    ).toBe(true);

    const intradayData = buildPatternData(buildCandles(), { atr15m: new Decimal('1.5') });
    intradayData.macroContext.dailyLevels.pdl = new Decimal(90);
    withSessionLow(intradayData, '100');

    const intraday = new Scenario12_SniperTouch({ ...mockConfig, s12SessionSweeps: true });
    expect(intraday.evaluate(intradayData)).toBe(false);
    expect(intraday.getReason()).toMatch(/Entry too far from swept ASIAN LOW/);
    expect(intraday.getReason()).toMatch(/0\.5xATR15m/);
  });

  it('keeps the 0.3% floor when ATR15m is tiny', () => {
    // atr15m 0.1 → intraday band max(0.05, 0.3) = 0.3; the 0.875 OB distance fails.
    const patternData = buildPatternData(buildCandles(), { atr15m: new Decimal('0.1') });
    patternData.macroContext.dailyLevels.pdl = new Decimal(90);
    withSessionLow(patternData, '100');

    const s = new Scenario12_SniperTouch({ ...mockConfig, s12SessionSweeps: true });
    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toMatch(/tolerance=0\.3000/);
  });
});

// ---------------------------------------------------------------------------
// Dynamic Take-Profit wiring
// ---------------------------------------------------------------------------

/**
 * Reference geometry for the fixture above (verified by the first `false` test):
 *   idealEntry = OB midpoint            = (101.05 + 100.70) / 2 = 100.875
 *   ATR(1m) on the trailing flat candles = 0.4
 *   offset     = max(0.4 * 0.5, 100.875 * 0.001) = 0.2
 *   SL         = min(101.05, 100.70, 100.875) - 0.2 = 100.5
 *   R          = 100.875 - 100.5        = 0.375
 *   fixed 3R   = 100.875 + 0.375 * 3    = 102
 */
describe('Scenario12: Dynamic Take-Profit', () => {
  const FIXED_3R = new Decimal('102');

  function configWith(overrides: Partial<BotConfig>): BotConfig {
    return { ...mockConfig, ...overrides };
  }

  function poolAt(price: string) {
    return {
      type: 'EQH' as const,
      priceLevel: new Decimal(price),
      points: [],
      isTaken: false,
      timestamp: 1,
    };
  }

  /**
   * Collapse every macro level below the entry while keeping the PDL sweep
   * intact. `0` would fail S12's own `price.gt(0)` pre-filter and short-circuit
   * with "No valid macro levels" before the TP resolver ever runs.
   */
  function collapseMacro(patternData: any) {
    const low = new Decimal('0.5');
    patternData.macroContext = {
      ath: low,
      atl: low,
      htfFvgs: [],
      htfObs: [],
      weeklyLevels: { pwh: low, pwl: low, wo: low },
      dailyLevels: { pdh: low, pdl: new Decimal('100'), do: new Decimal('100') },
      liquidityPools: [],
    };
    return patternData;
  }

  it('preserves the exact fixed 3R target when dynamic TP is disabled', () => {
    const s = new Scenario12_SniperTouch(configWith({ enableDynamicTp: false }));
    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(true);

    const levels = s.getLevels();
    expect(levels.takeProfit.toString()).toBe(FIXED_3R.toString());
    expect(levels.entry.toString()).toBe('100.875');
    expect(levels.stopLoss.toString()).toBe('100.5');
  });

  it('is byte-identical to the legacy constant-R target when disabled', () => {
    // Regression guard: the pre-resolver code called
    // calculateLevels(..., new Decimal(3)) — TP must not drift by even 1e-8.
    const s = new Scenario12_SniperTouch(configWith({ enableDynamicTp: false }));
    s.evaluate(buildPatternData(buildCandles()));

    const levels = s.getLevels();
    const risk = levels.entry.minus(levels.stopLoss);
    expect(levels.takeProfit.minus(levels.entry).toString()).toBe(
      risk.mul(3).toString(),
    );
  });

  it('snaps to the nearest liquidity pool when dynamic TP is enabled', () => {
    const s = new Scenario12_SniperTouch(configWith({ enableDynamicTp: true }));
    const patternData = buildPatternData(buildCandles());
    patternData.liquidityPools = [poolAt('101.5')];

    expect(s.evaluate(patternData)).toBe(true);

    const levels = s.getLevels();
    // 101.5 is 0.625 / 0.375 = 1.667R away — above the 1.5R floor.
    expect(levels.takeProfit.toString()).toBe('101.5');
  });

  it('rejects when the nearest pool leaves less than minRr of room', () => {
    const s = new Scenario12_SniperTouch(configWith({ enableDynamicTp: true }));
    const patternData = buildPatternData(buildCandles());
    // 101.2 is 0.325 / 0.375 = 0.867R — the wall filter must reject, not clamp.
    patternData.liquidityPools = [poolAt('101.2')];

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toMatch(/Take-profit rejected: Insufficient room/);
    expect(s.getReason()).toMatch(/0\.87R/);
    expect(s.getReason()).toMatch(/1\.50R/);
  });

  it('clamps an over-extended target to dynamicTpMaxRr', () => {
    // Only the macro PDH (200) lies beyond entry: 264R, far past the 6R cap.
    const s = new Scenario12_SniperTouch(configWith({ enableDynamicTp: true }));
    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(true);

    const levels = s.getLevels();
    expect(levels.takeProfit.toString()).toBe('103.125'); // entry + 6 * 0.375
  });

  it('falls back to fixedRr when no structural target exists', () => {
    const s = new Scenario12_SniperTouch(
      configWith({ enableDynamicTp: true, dynamicTpRequireTarget: false }),
    );
    expect(s.evaluate(collapseMacro(buildPatternData(buildCandles())))).toBe(true);

    expect(s.getLevels().takeProfit.toString()).toBe(FIXED_3R.toString());
  });

  it('rejects when requireTarget is set and no structural target exists', () => {
    const s = new Scenario12_SniperTouch(
      configWith({ enableDynamicTp: true, dynamicTpRequireTarget: true }),
    );

    expect(s.evaluate(collapseMacro(buildPatternData(buildCandles())))).toBe(false);
    expect(s.getReason()).toMatch(/No opposing structural target/);
  });

  it('honours a custom fixedTpRr when dynamic TP is disabled', () => {
    const s = new Scenario12_SniperTouch(
      configWith({ enableDynamicTp: false, fixedTpRr: new Decimal(2) }),
    );
    s.evaluate(buildPatternData(buildCandles()));

    // entry + 2 * 0.375 = 101.625
    expect(s.getLevels().takeProfit.toString()).toBe('101.625');
  });

  it('keeps the long-side invariant (SL < entry < TP) in every mode', () => {
    for (const enableDynamicTp of [false, true]) {
      const s = new Scenario12_SniperTouch(configWith({ enableDynamicTp }));
      const patternData = buildPatternData(buildCandles());
      patternData.liquidityPools = [poolAt('101.5')];

      expect(s.evaluate(patternData)).toBe(true);

      const levels = s.getLevels();
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.entry.lt(levels.takeProfit)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — Orthodox SMC filters (V1, V3, V5, V7, V8, V9, V10)
// ---------------------------------------------------------------------------

describe('Scenario12: Orthodox hardening', () => {
  function htfBreak(direction: 'BULLISH' | 'BEARISH') {
    return {
      type: 'BOS' as const,
      direction,
      price: new Decimal(direction === 'BULLISH' ? '99' : '102'),
      timestamp: BASE_TS + 5 * MINUTE,
      isValidated: true,
      timeframe: '240',
    };
  }

  function htfZone(direction: 'BULLISH' | 'BEARISH', top: string, bottom: string) {
    return {
      type: 'OB' as const,
      direction,
      top: new Decimal(top),
      bottom: new Decimal(bottom),
      timestamp: BASE_TS,
      mitigated: false,
      timeframe: '240' as const,
    };
  }

  // --- V1: HTF bias -------------------------------------------------------

  it('rejects a long reversing against a bearish 4H structure', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.structures = [htfBreak('BEARISH')];

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toBe('HTF trend contradicts reversal direction');
  });

  it('allows a long whose 4H structure is aligned', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.structures = [htfBreak('BULLISH')];

    expect(s.evaluate(patternData)).toBe(true);
  });

  it('allows a counter-HTF long at an unmitigated 4H demand zone', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.structures = [htfBreak('BEARISH')];
    // Last 1m close is 100.6 — inside this 4H demand zone.
    patternData.zones = [htfZone('BULLISH', '101', '100')];

    expect(s.evaluate(patternData)).toBe(true);
  });

  it('rejects a counter-HTF long when the 4H zone is mitigated', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.structures = [htfBreak('BEARISH')];
    patternData.zones = [{ ...htfZone('BULLISH', '101', '100'), mitigated: true }];

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toBe('HTF trend contradicts reversal direction');
  });

  it('treats an empty 4H structure set as neutral', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(true);
  });

  // --- V3: Premium / Discount --------------------------------------------

  it('rejects a long entered in premium', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    // Equilibrium 99.25 sits below the 100.875 entry -> premium.
    patternData.tradingRange = {
      high: new Decimal('100.5'),
      low: new Decimal('98'),
      equilibrium: new Decimal('99.25'),
      isDeviated: false,
    };

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toBe('Entry violates Premium/Discount equilibrium');
  });

  it('allows a long entered in discount', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.tradingRange = {
      high: new Decimal('103'),
      low: new Decimal('100'),
      equilibrium: new Decimal('101.5'),
      isDeviated: false,
    };

    expect(s.evaluate(patternData)).toBe(true);
  });

  // --- V5/V6: no synthetic order block ------------------------------------

  it('rejects when no real order block exists at the CHoCH origin', () => {
    const candles = buildCandles();
    // Make the only bearish candle before the CHoCH bullish: no OB remains.
    candles[OB_INDEX] = candle(OB_INDEX, {
      open: '100.7',
      high: '101.05',
      low: '100.65',
      close: '100.9',
    });

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(candles))).toBe(false);
    expect(s.getReason()).toBe('No valid Order Block at CHoCH origin');
  });

  // --- V7: strict displacement multiplier --------------------------------

  it('rejects a CHoCH whose body is below 1.5 ATR', () => {
    const candles = buildCandles();
    // Body 0.5 < 1.5 * ATR(0.4) = 0.6. The removed 0.5 fallback would accept it.
    candles[CHOCH_INDEX] = candle(CHOCH_INDEX, {
      open: '100.9',
      high: '101.45',
      low: '100.85',
      close: '101.4',
    });

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(candles))).toBe(false);
    expect(s.getReason()).toMatch(/No fresh CHoCH/);
  });

  // --- V10: sweep rejection quality --------------------------------------

  it('rejects a macro sweep with an insufficient rejection wick', () => {
    const candles = buildCandles();
    // Pierces PDL by 5 bps and closes back above, but the lower wick is only
    // 0.10 of a 0.85 range (11.8%) — consumption, not absorption.
    candles[SWEEP_INDEX] = candle(SWEEP_INDEX, {
      open: '100.7',
      high: '100.8',
      low: '99.95',
      close: '100.05',
    });

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(candles))).toBe(false);
    expect(s.getReason()).toMatch(/Sweep rejected: insufficient rejection wick/);
    expect(s.getReason()).toMatch(/PDL wick 11\.8% < 25%/);
  });

  it('accepts a rejection wick between 25% and 30% under the default threshold', () => {
    const candles = buildCandles();
    // Lower wick 0.28 of a 0.95 range = 29.5%: rejected by the old 30% gate,
    // admitted at the calibrated 25% default.
    candles[SWEEP_INDEX] = candle(SWEEP_INDEX, {
      open: '100.6',
      high: '100.85',
      low: '99.9',
      close: '100.18',
    });

    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(candles))).toBe(true);
  });

  it('reads the wick threshold from config instead of a constant', () => {
    // A permissive config must admit the 11.8% wick that the default rejects.
    const candles = buildCandles();
    candles[SWEEP_INDEX] = candle(SWEEP_INDEX, {
      open: '100.7',
      high: '100.8',
      low: '99.95',
      close: '100.05',
    });

    const permissive = new Scenario12_SniperTouch({
      ...mockConfig,
      smcSweepMinWickRatio: new Decimal('0.05'),
    });
    expect(permissive.evaluate(buildPatternData(candles))).toBe(true);

    // A stricter config must reject the 29.5% wick the default admits.
    const strictCandles = buildCandles();
    strictCandles[SWEEP_INDEX] = candle(SWEEP_INDEX, {
      open: '100.6',
      high: '100.85',
      low: '99.9',
      close: '100.18',
    });
    const strict = new Scenario12_SniperTouch({
      ...mockConfig,
      smcSweepMinWickRatio: new Decimal('0.4'),
    });
    expect(strict.evaluate(buildPatternData(strictCandles))).toBe(false);
    expect(strict.getReason()).toMatch(/PDL wick 29\.5% < 40%/);
  });

  it('accepts a sweep whose rejection wick clears 25% of the range', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    // Default fixture: lower wick 0.7 of a 1.0 range (70%).
    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejection funnel counters (backtest diagnostics / threshold calibration)
// ---------------------------------------------------------------------------

describe('Scenario12: rejection funnel counters', () => {
  // The counters are static, so each test starts from a clean funnel.
  beforeEach(() => {
    Scenario12_SniperTouch.resetStats();
  });

  it('counts exactly one rejection bucket per failed evaluation', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const candles = buildCandles();
    candles[SWEEP_INDEX] = candle(SWEEP_INDEX, {
      open: '100.7',
      high: '100.8',
      low: '99.95',
      close: '100.05',
    });

    expect(s.evaluate(buildPatternData(candles))).toBe(false);

    const stats = Scenario12_SniperTouch.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.weakWick).toBe(1);
    expect(stats.triggered).toBe(0);
    expect(stats.sweepFound).toBe(0);
    // The touch was recorded but never became a sweep.
    expect(stats.levelTouched).toBe(1);
  });

  it('records a hit as triggered, not as any rejection', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(true);

    const stats = Scenario12_SniperTouch.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.triggered).toBe(1);
    expect(stats.sweepFound).toBe(1);

    const rejectionBuckets = [
      stats.weakWick,
      stats.noSweep,
      stats.htfContradiction,
      stats.noChoch,
      stats.bodyClose,
      stats.noOb,
      stats.proximity,
      stats.premiumDiscount,
      stats.insufficientRoom,
      stats.tpInvalid,
      stats.geometry,
      stats.invalidAtr,
      stats.killzone,
      stats.noMacroLevels,
      stats.disabled,
      stats.insufficientCandles,
    ];
    expect(rejectionBuckets.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('separates each post-sweep gate into its own bucket', () => {
    // HTF contradiction
    const htf = new Scenario12_SniperTouch(mockConfig);
    const htfData = buildPatternData(buildCandles());
    htfData.structures = [
      {
        type: 'BOS',
        direction: 'BEARISH',
        price: new Decimal('99'),
        timestamp: BASE_TS + 5 * MINUTE,
        isValidated: true,
        timeframe: '240',
      } as any,
    ];
    expect(htf.evaluate(htfData)).toBe(false);
    expect(Scenario12_SniperTouch.getRejectionStats().htfContradiction).toBe(1);

    Scenario12_SniperTouch.resetStats();

    // Premium/discount violation
    const premium = new Scenario12_SniperTouch(mockConfig);
    const premiumData = buildPatternData(buildCandles());
    premiumData.tradingRange = {
      high: new Decimal('100.5'),
      low: new Decimal('98'),
      equilibrium: new Decimal('99.25'),
      isDeviated: false,
    };
    expect(premium.evaluate(premiumData)).toBe(false);
    expect(Scenario12_SniperTouch.getRejectionStats().premiumDiscount).toBe(1);

    Scenario12_SniperTouch.resetStats();

    // Missing real order block
    const noObCandles = buildCandles();
    noObCandles[OB_INDEX] = candle(OB_INDEX, {
      open: '100.7',
      high: '101.05',
      low: '100.65',
      close: '100.9',
    });
    const noOb = new Scenario12_SniperTouch(mockConfig);
    expect(noOb.evaluate(buildPatternData(noObCandles))).toBe(false);
    expect(Scenario12_SniperTouch.getRejectionStats().noOb).toBe(1);
  });

  it('isolates the dynamic-TP wall filter as InsufficientRoom', () => {
    const s = new Scenario12_SniperTouch({ ...mockConfig, enableDynamicTp: true });
    const patternData = buildPatternData(buildCandles());
    // 0.87R away: beyond entry, closer than the 1.5R wall.
    patternData.liquidityPools = [
      {
        type: 'EQH',
        priceLevel: new Decimal('101.2'),
        points: [],
        isTaken: false,
        timestamp: 1,
      } as any,
    ];

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toMatch(/Insufficient room/);

    const stats = Scenario12_SniperTouch.getRejectionStats();
    expect(stats.insufficientRoom).toBe(1);
    expect(stats.tpInvalid).toBe(0);
  });

  it('resetStats clears the whole funnel', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const candles = buildCandles();
    candles[SWEEP_INDEX] = candle(SWEEP_INDEX, {
      open: '100.7',
      high: '100.8',
      low: '99.95',
      close: '100.05',
    });
    expect(s.evaluate(buildPatternData(candles))).toBe(false);
    expect(Scenario12_SniperTouch.getRejectionStats().totalEvals).toBe(1);

    Scenario12_SniperTouch.resetStats();

    const stats = Scenario12_SniperTouch.getRejectionStats();
    expect(stats.totalEvals).toBe(0);
    expect(stats.weakWick).toBe(0);
    expect(stats.levelTouched).toBe(0);
    expect(stats.sweepFound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Persistent 4H trend gate + fee-aware target floor (v2026-10-23)
// ---------------------------------------------------------------------------

describe('Scenario12: persistent 4H trend gate', () => {
  it('fails closed when fewer than 20 closed 4H candles are available', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.candles4h = buildHtfCandles('up', 19);

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toBe('HTF trend contradicts reversal direction');
  });

  it('rejects a long when the 4H close is below SMA50 (persistent downtrend)', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.candles4h = buildHtfCandles('down');

    expect(s.evaluate(patternData)).toBe(false);
    expect(s.getReason()).toBe('HTF trend contradicts reversal direction');
  });

  it('allows a counter-trend long at an unmitigated 4H demand POI', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    patternData.candles4h = buildHtfCandles('down');
    // Last 1m close is 100.6 — inside this 4H demand zone.
    patternData.zones = [
      {
        type: 'OB',
        direction: 'BULLISH',
        top: new Decimal('101'),
        bottom: new Decimal('100'),
        timestamp: BASE_TS,
        mitigated: false,
        timeframe: '240',
      } as any,
    ];

    expect(s.evaluate(patternData)).toBe(true);
  });

  it('keeps a long aligned with the 4H SMA50 even when the structure set is empty', () => {
    // The old structure-only gate treated an empty set as neutral; the SMA gate
    // must still confirm the trend instead of silently admitting everything.
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    expect(patternData.structures).toEqual([]);

    expect(s.evaluate(patternData)).toBe(true);
  });

  it('treats a 4H close exactly at SMA50 as neutral within the 0.2% tolerance', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    const patternData = buildPatternData(buildCandles());
    // Flat closes: last close equals SMA50 exactly -> no trend, pass.
    patternData.candles4h = buildHtfCandles('up').map((c) => ({
      ...c,
      close: '100.0000',
    }));

    expect(s.evaluate(patternData)).toBe(true);
  });
});

describe('Scenario12: fee-aware target distance floor', () => {
  it('rejects a resolved target closer than minTpDistancePct', () => {
    // The default fixed 3R target is 1.125 from 100.875 (1.115%). A 5% floor
    // makes it fee-dominated by definition.
    const s = new Scenario12_SniperTouch({
      ...mockConfig,
      minTpDistancePct: new Decimal('0.05'),
    });

    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(false);
    expect(s.getReason()).toMatch(/Target distance 1\.115% < fee threshold 5\.00%/);
  });

  it('accepts a target that clears the default 0.35% floor', () => {
    const s = new Scenario12_SniperTouch(mockConfig);
    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(true);
  });

  it('counts a fee-floor rejection as insufficientRoom, not tpInvalid', () => {
    Scenario12_SniperTouch.resetStats();
    const s = new Scenario12_SniperTouch({
      ...mockConfig,
      minTpDistancePct: new Decimal('0.05'),
    });

    expect(s.evaluate(buildPatternData(buildCandles()))).toBe(false);

    const stats = Scenario12_SniperTouch.getRejectionStats();
    expect(stats.insufficientRoom).toBe(1);
    expect(stats.tpInvalid).toBe(0);
  });
});
