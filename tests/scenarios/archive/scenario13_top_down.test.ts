import { Decimal } from 'decimal.js';
import { Scenario13_TopDownOrderFlow } from '../../../src/engine/scenarios/archive/Scenario13_TopDownOrderFlow';
import type { BotConfig } from '../../../src/config/env';
import type { Candle } from '../../../src/types';
import type { PatternData, Structure, Zone } from '../../../src/smc/patternRecognizer';

// ---------------------------------------------------------------------------
// Shared fixture constants
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const M15 = 15 * MINUTE;
const H4 = 4 * 60 * MINUTE;

const BASE_4H = 1_788_675_600_000;
const BASE_15M = BASE_4H + 8 * H4;
const TEST_15M_INDEX = 23;
const TEST_15M_TS = BASE_15M + TEST_15M_INDEX * M15;

/** 1m trigger candidate: a 0.65 body BOS/CHoCH inside the reaction window. */
const TRIGGER_1M_INDEX = 12;

const BULL_ENTRY = new Decimal('103.5');
const BULL_TRIGGER_CLOSE = new Decimal('104.05');
const BULL_MICRO_LOW = '103.0';
const BULL_ZONE_TOP = '104.2';
const BULL_ZONE_BOTTOM = '102.8';
const BULL_PDH = '106.5175';

const BEAR_TRIGGER_CLOSE = new Decimal('106.75');
const BEAR_MICRO_HIGH = '107.8';
const BEAR_ZONE_TOP = '108.2';
const BEAR_ZONE_BOTTOM = '106.4';
const BEAR_PDL = '104.2635';

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
  activeScenarios: [13],
  enableFundingMonitor: false,
  fundingMonitorSymbols: [],
  fundingAlertThresholdPct: '0.0',
  fundingRestoreThresholdPct: '0.0001',
  symbolScenarios: new Map(),
  backtestCsvPath: null,
  cooldownCandles: 16,
  // '0' isolates the mandatory 0.1% stop-offset floor: the expected SL is then
  // deterministic (micro extreme - 0.1% of entry) and independent of 1m ATR.
  smcSlAtrOffset: '0',
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

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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

function make4hBullish(): Candle[] {
  return [
    candle(BASE_4H, '104', '112', '100', '106'),
    candle(BASE_4H + H4, '106', '108', '102', '103'),
    // Fallback dealing range: 100..112 (equilibrium 106) -> close is DISCOUNT.
    candle(BASE_4H + 2 * H4, '103', '106.2', '102', '105.6'),
  ];
}

function make4hBearish(): Candle[] {
  return [
    candle(BASE_4H, '106', '112', '98', '105'),
    candle(BASE_4H + H4, '105', '110', '101', '108'),
    // Fallback dealing range: 98..112 (equilibrium 105) -> close stays out of DISCOUNT.
    candle(BASE_4H + 2 * H4, '108', '110', '104.8', '105.2'),
  ];
}

function bullish4hStructures(): Structure[] {
  return [
    {
      type: 'BOS',
      direction: 'BULLISH',
      timestamp: BASE_4H,
      price: new Decimal('106'),
      isValidated: true,
      timeframe: '240',
    },
    {
      type: 'BOS',
      direction: 'BULLISH',
      timestamp: BASE_4H + H4,
      price: new Decimal('108'),
      isValidated: true,
      timeframe: '240',
    },
  ];
}

function bearish4hStructures(): Structure[] {
  return [
    {
      type: 'BOS',
      direction: 'BEARISH',
      timestamp: BASE_4H,
      price: new Decimal('105'),
      isValidated: true,
      timeframe: '240',
    },
    {
      type: 'BOS',
      direction: 'BEARISH',
      timestamp: BASE_4H + H4,
      price: new Decimal('101'),
      isValidated: true,
      timeframe: '240',
    },
  ];
}

/**
 * 24 x 15m candles:
 *   0..19  impulse (vol 100)
 *   19     confirmed swing high (119.5) = pullback origin
 *   20..22 corrective decay (vol 40/50/60) that stays inside the POI
 *   23     reaction candle touches [102.8, 104.2] on vol 150 and closes 105.6
 */
function makeBullish15m(correctiveVolumes: [string, string, string] = ['40', '50', '60']): Candle[] {
  const candles: Candle[] = [];

  for (let i = 0; i < 20; i += 1) {
    const close = 100 + i;
    candles.push(
      candle(
        BASE_15M + i * M15,
        String(close - 0.5),
        String(close + 0.5),
        String(close - 1),
        String(close),
        '100',
      ),
    );
  }

  candles.push(candle(BASE_15M + 20 * M15, '112.5', '113', '111.5', '112', correctiveVolumes[0]));
  candles.push(candle(BASE_15M + 21 * M15, '108.5', '109', '107', '108', correctiveVolumes[1]));
  candles.push(candle(BASE_15M + 22 * M15, '105.4', '105.6', '104.4', '105.0', correctiveVolumes[2]));
  candles.push(candle(TEST_15M_TS, '104.8', '105.8', '103.0', '105.6', '150'));

  return candles;
}

/**
 * Bearish mirror: 20 x 15m impulse down, swing low origin at 99.5, three
 * corrective rallies into the supply POI, then a high-volume rejection candle.
 */
function makeBearish15m(correctiveVolumes: [string, string, string] = ['40', '50', '60']): Candle[] {
  const candles: Candle[] = [];

  for (let i = 0; i < 20; i += 1) {
    const close = 119 - i;
    candles.push(
      candle(
        BASE_15M + i * M15,
        String(close + 0.5),
        String(close + 1),
        String(close - 0.5),
        String(close),
        '100',
      ),
    );
  }

  candles.push(candle(BASE_15M + 20 * M15, '104.5', '106.0', '104.0', '105.5', correctiveVolumes[0]));
  candles.push(candle(BASE_15M + 21 * M15, '105.5', '107.5', '105.0', '107.0', correctiveVolumes[1]));
  candles.push(candle(BASE_15M + 22 * M15, '107.0', '108.1', '106.5', '107.8', correctiveVolumes[2]));
  candles.push(candle(TEST_15M_TS, '107.6', '107.8', '105.0', '105.2', '150'));

  return candles;
}

/**
 * 15 x 1m candles inside [TEST_15M_TS, +15m):
 *   index 5  reaction low 103.0
 *   index 8  confirmed swing high 103.45
 *   index 12 displacement body 0.65 closes 104.05 (>= 1.5 * ATR(14) = 0.536)
 */
function makeBullish1m(): Candle[] {
  const rows: Array<[string, string, string, string]> = [
    ['103.65', '103.75', '103.55', '103.70'],
    ['103.70', '103.75', '103.55', '103.60'],
    ['103.60', '103.65', '103.45', '103.50'],
    ['103.50', '103.55', '103.30', '103.35'],
    ['103.35', '103.40', '103.20', '103.25'],
    ['103.25', '103.30', '103.00', '103.05'],
    ['103.05', '103.25', '103.00', '103.15'],
    ['103.15', '103.35', '103.10', '103.30'],
    ['103.30', '103.45', '103.25', '103.40'],
    ['103.40', '103.40', '103.30', '103.35'],
    ['103.35', '103.40', '103.20', '103.25'],
    ['103.25', '103.40', '103.20', '103.40'],
    ['103.40', '104.10', '103.35', '104.05'],
    ['104.05', '104.60', '104.00', '104.55'],
    ['104.55', '105.80', '104.50', '105.60'],
  ];

  return rows.map(([open, high, low, close], i) =>
    candle(TEST_15M_TS + i * MINUTE, open, high, low, close),
  );
}

/**
 * Bullish 1m series with a configurable trigger index. The first 12 candles
 * mirror `makeBullish1m()`; indices 12..triggerIndex-1 are quiet candles below
 * the swing high, then the displacement trigger and continuation print.
 *
 * This allows the same validated structure to be placed inside the 15-minute
 * legacy window (index 12), inside the 30-minute primed window (index 18), or
 * beyond it (index 30).
 */
function makeBullish1mAt(triggerIndex: number): Candle[] {
  const rows: Array<[string, string, string, string]> = [
    ['103.65', '103.75', '103.55', '103.70'],
    ['103.70', '103.75', '103.55', '103.60'],
    ['103.60', '103.65', '103.45', '103.50'],
    ['103.50', '103.55', '103.30', '103.35'],
    ['103.35', '103.40', '103.20', '103.25'],
    ['103.25', '103.30', '103.00', '103.05'],
    ['103.05', '103.25', '103.00', '103.15'],
    ['103.15', '103.35', '103.10', '103.30'],
    ['103.30', '103.45', '103.25', '103.40'],
    ['103.40', '103.40', '103.30', '103.35'],
    ['103.35', '103.40', '103.20', '103.25'],
    ['103.25', '103.40', '103.20', '103.40'],
  ];

  while (rows.length < triggerIndex) {
    rows.push(['103.40', '103.42', '103.30', '103.38']);
  }

  rows.push(['103.40', '104.10', '103.35', '104.05']);
  rows.push(['104.05', '104.60', '104.00', '104.55']);
  rows.push(['104.55', '105.80', '104.50', '105.60']);

  return rows.map(([open, high, low, close], i) =>
    candle(TEST_15M_TS + i * MINUTE, open, high, low, close),
  );
}

/** Bearish mirror of `makeBullish1m()` around 105.4 (OHLC high/low swapped). */
function makeBearish1m(): Candle[] {
  const pivot2 = new Decimal('210.8');
  return makeBullish1m().map((entry) => ({
    ...entry,
    open: pivot2.minus(entry.open).toString(),
    high: pivot2.minus(entry.low).toString(),
    low: pivot2.minus(entry.high).toString(),
    close: pivot2.minus(entry.close).toString(),
  }));
}

function makeMacroContext(pdh: string, pdl: string): PatternData['macroContext'] {
  return {
    ath: new Decimal(0),
    atl: new Decimal(0),
    htfFvgs: [],
    htfObs: [],
    weeklyLevels: { pwh: new Decimal(0), pwl: new Decimal(0), wo: new Decimal(0) },
    dailyLevels: { pdh: new Decimal(pdh), pdl: new Decimal(pdl), do: new Decimal(0) },
    liquidityPools: [],
  };
}

interface BullishOverrides {
  zoneTop?: string;
  zoneBottom?: string;
  pdh?: string;
  correctiveVolumes?: [string, string, string];
  candles15m?: Candle[];
  candles1m?: Candle[];
  candles4h?: Candle[];
  structures4h?: Structure[];
  zones?: Zone[];
  atr15m?: Decimal;
}

function bullishPatternData(overrides: BullishOverrides = {}): any {
  const zoneTop = overrides.zoneTop ?? BULL_ZONE_TOP;
  const zoneBottom = overrides.zoneBottom ?? BULL_ZONE_BOTTOM;

  const zone: Zone = {
    type: 'OB',
    top: new Decimal(zoneTop),
    bottom: new Decimal(zoneBottom),
    timestamp: BASE_15M + 10 * M15,
    mitigated: false,
    timeframe: '15',
    direction: 'BULLISH',
  };

  return {
    candles15m: overrides.candles15m ?? makeBullish15m(overrides.correctiveVolumes),
    candles4h: overrides.candles4h ?? make4hBullish(),
    candles1m: overrides.candles1m ?? makeBullish1m(),
    macroContext: makeMacroContext(overrides.pdh ?? BULL_PDH, '98'),
    structures: overrides.structures4h ?? bullish4hStructures(),
    zones: overrides.zones ?? [zone],
    liquidityPools: [],
    sessionRanges: [],
    tradingRange: null,
    swingPoints: [],
    atr15m: overrides.atr15m ?? new Decimal('1'),
    atr4h: new Decimal('1'),
    currentSession: 'LONDON',
    currentKillzone: 'LONDON',
    patternRecognizer: 'PatternRecognizer',
    mitigatedZones: [],
    mitigatedStructures: [],
  } satisfies Partial<PatternData> & Record<string, unknown>;
}

function bearishPatternData(): any {
  const zone: Zone = {
    type: 'OB',
    top: new Decimal(BEAR_ZONE_TOP),
    bottom: new Decimal(BEAR_ZONE_BOTTOM),
    timestamp: BASE_15M + 10 * M15,
    mitigated: false,
    timeframe: '15',
    direction: 'BEARISH',
  };

  return {
    candles15m: makeBearish15m(),
    candles4h: make4hBearish(),
    candles1m: makeBearish1m(),
    macroContext: makeMacroContext('112', BEAR_PDL),
    structures: bearish4hStructures(),
    zones: [zone],
    liquidityPools: [],
    sessionRanges: [],
    tradingRange: null,
    swingPoints: [],
    atr15m: new Decimal('1'),
    atr4h: new Decimal('1'),
    currentSession: 'LONDON',
    currentKillzone: 'LONDON',
    patternRecognizer: 'PatternRecognizer',
    mitigatedZones: [],
    mitigatedStructures: [],
  } satisfies Partial<PatternData> & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scenario 13 — Top-Down Order Flow', () => {
  beforeEach(() => {
    Scenario13_TopDownOrderFlow.resetStats();
  });

  it('triggers the textbook bullish setup: 4H roadmap -> discount 15m POI -> volume decay -> 1m trigger anchored entry', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(scenario.evaluate(bullishPatternData())).toBe(true);

    const levels = scenario.getLevels();

    // R4: entry = the 1m trigger candle close (104.05), NOT the stale 15m POI
    // midpoint (103.5), so Hybrid Smart Entry executes at the active reaction.
    expect(levels.entry.toString()).toBe(BULL_TRIGGER_CLOSE.toString());
    expect(levels.entry.toString()).not.toBe(BULL_ENTRY.toString());
    // Micro low minus the mandatory 0.1% floor: 103.0 - (104.05 * 0.001).
    expect(levels.stopLoss.toString()).toBe(
      new Decimal(BULL_MICRO_LOW).minus(BULL_TRIGGER_CLOSE.mul('0.001')).toString(),
    );
    expect(levels.stopLoss.toString()).toBe('102.89595');
    expect(levels.takeProfit.toString()).toBe(BULL_PDH);

    // Structural asymmetry to the macro draw: (106.5175 - 104.05) / 1.15405.
    const rr = levels.takeProfit.minus(levels.entry).div(levels.entry.minus(levels.stopLoss));
    expect(rr.toFixed(2)).toBe('2.14');
    expect(rr.gte('1.5')).toBe(true);

    // 15m POI and 1m trigger are both tagged for mitigation.
    const zone = scenario.getZoneDetails();
    expect(zone).not.toBeNull();
    expect(zone?.type).toBe('OB');
    expect(zone?.timeframe).toBe('15');
    expect(zone?.direction).toBe('BULLISH');
    expect(zone?.top.toString()).toBe(BULL_ZONE_TOP);
    expect(zone?.bottom.toString()).toBe(BULL_ZONE_BOTTOM);

    const structure = scenario.getStructureDetails();
    expect(structure).not.toBeNull();
    expect(structure?.type).toBe('CHoCH');
    expect(structure?.direction).toBe('BULLISH');
    expect(structure?.timestamp).toBe(TEST_15M_TS + TRIGGER_1M_INDEX * MINUTE);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.triggered).toBe(1);
    expect(stats.noHtfRoadmap).toBe(0);
    expect(stats.htfNeutral).toBe(0);
    expect(stats.noPoi).toBe(0);
    expect(stats.noPullbackOrigin).toBe(0);
    expect(stats.insufficientPullbackCandles).toBe(0);
    expect(stats.pullbackVolumeHeavy).toBe(0);
    expect(stats.poiViolated).toBe(0);
    expect(stats.noPoiTouch).toBe(0);
    expect(stats.volumeInvalid).toBe(0);
    expect(stats.noReaction).toBe(0);
    expect(stats.insufficientAsymmetry).toBe(0);
    expect(stats.tpInvalid).toBe(0);
  });

  it('mirrors the setup on the bearish side: premium supply POI -> 1m breakdown -> structural PDL target', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(scenario.evaluate(bearishPatternData())).toBe(true);

    const levels = scenario.getLevels();

    expect(levels.entry.toString()).toBe(BEAR_TRIGGER_CLOSE.toString());
    // Micro high plus the mandatory 0.1% floor: 107.8 + (106.75 * 0.001).
    expect(levels.stopLoss.toString()).toBe(
      new Decimal(BEAR_MICRO_HIGH).plus(BEAR_TRIGGER_CLOSE.mul('0.001')).toString(),
    );
    expect(levels.stopLoss.toString()).toBe('107.90675');
    expect(levels.takeProfit.toString()).toBe(BEAR_PDL);

    const rr = levels.entry.minus(levels.takeProfit).div(levels.stopLoss.minus(levels.entry));
    expect(rr.toFixed(2)).toBe('2.15');

    const zone = scenario.getZoneDetails();
    expect(zone?.direction).toBe('BEARISH');
    expect(zone?.timeframe).toBe('15');
    expect(zone?.top.toString()).toBe(BEAR_ZONE_TOP);
    expect(zone?.bottom.toString()).toBe(BEAR_ZONE_BOTTOM);

    const structure = scenario.getStructureDetails();
    expect(structure?.type).toBe('CHoCH');
    expect(structure?.direction).toBe('BEARISH');
    expect(structure?.timestamp).toBe(TEST_15M_TS + TRIGGER_1M_INDEX * MINUTE);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.triggered).toBe(1);
  });

  it('rejects when no confirmed 4H structure exists before evaluating the POI', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(scenario.evaluate(bullishPatternData({ structures4h: [] }))).toBe(false);

    expect(scenario.getReason()).toMatch(/neutral/i);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.htfNeutral).toBe(1);
    expect(stats.noHtfRoadmap).toBe(0);
    expect(stats.noPoi).toBe(0);
    expect(stats.triggered).toBe(0);
  });

  it('rejects a heavy pullback (panic volume) as exhaustion failure', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(
      scenario.evaluate(
        bullishPatternData({ correctiveVolumes: ['140', '170', '200'] }),
      ),
    ).toBe(false);

    expect(scenario.getReason()).toMatch(/Heavy pullback volume/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.pullbackVolumeHeavy).toBe(1);
    expect(stats.noPullbackOrigin).toBe(0);
    expect(stats.insufficientPullbackCandles).toBe(0);
    expect(stats.triggered).toBe(0);
  });

  it('keeps a touched POI primed for 30 minutes and accepts an 18-minute 1m trigger', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(
      scenario.evaluate(
        bullishPatternData({ candles1m: makeBullish1mAt(18) }),
      ),
    ).toBe(true);

    const structure = scenario.getStructureDetails();
    expect(structure?.timestamp).toBe(TEST_15M_TS + 18 * MINUTE);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.triggered).toBe(1);
    expect(stats.noReaction).toBe(0);
  });

  it('uses the previous closed 15m touch while its 30-minute window is still open', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const touchCandle = makeBullish15m();
    const candles15m = [
      ...touchCandle,
      // Latest closed candle has moved away from the POI; the touch at index 23
      // remains the primed candidate.
      candle(BASE_15M + 24 * M15, '105.6', '106', '105', '105.8'),
    ];

    expect(
      scenario.evaluate(
        bullishPatternData({
          candles15m,
          candles1m: makeBullish1mAt(28),
        }),
      ),
    ).toBe(true);

    const structure = scenario.getStructureDetails();
    expect(structure?.timestamp).toBe(TEST_15M_TS + 28 * MINUTE);
    expect(Scenario13_TopDownOrderFlow.getRejectionStats().triggered).toBe(1);
  });

  it('clears an older primed touch after the newest candle breaks the POI', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const touchCandle = makeBullish15m();
    const candles15m = [
      ...touchCandle,
      // Decisive close below the demand POI (beyond the 50%/ATR buffer) while
      // still inside the 3-ATR proximity band, so the POI is evaluated and
      // rejected as violated rather than silently filtered out.
      candle(BASE_15M + 24 * M15, '105', '105.2', '101.0', '101.5'),
    ];

    expect(
      scenario.evaluate(
        bullishPatternData({
          candles15m,
          candles1m: makeBullish1mAt(28),
        }),
      ),
    ).toBe(false);

    expect(scenario.getReason()).toMatch(/structurally violated/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.poiViolated).toBe(1);
    expect(stats.triggered).toBe(0);
  });

  it('uses the trigger close as the entry even when a tighter micro-OB anchor is in the Smart Entry band', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // The last down candle before the trigger tops at 104.00 — only 0.048% below
    // the 104.05 trigger close, so the old "micro-origin anchor" rule would have
    // set entry=104.00. Smart Entry then fills at MARKET (the premium is inside
    // the 0.15% band) at 104.05, silently shrinking the validated R:R. The entry
    // must be the price that is actually paid.
    const rows: Array<[string, string, string, string]> = [
      ['103.55', '103.65', '103.45', '103.60'],
      ['103.60', '103.70', '103.50', '103.55'],
      ['103.55', '103.60', '103.40', '103.45'],
      ['103.45', '103.50', '103.35', '103.40'],
      ['103.40', '103.80', '103.35', '103.75'],
      ['103.75', '103.75', '103.55', '103.60'],
      ['103.60', '103.65', '103.50', '103.55'],
      ['103.55', '103.60', '103.45', '103.50'],
      ['103.50', '103.60', '103.40', '103.45'],
      ['103.45', '103.55', '103.35', '103.40'],
      ['103.40', '103.50', '103.30', '103.35'],
      ['103.95', '104.00', '103.55', '103.60'],
      ['103.40', '104.10', '103.35', '104.05'],
      ['104.05', '104.60', '104.00', '104.55'],
      ['104.55', '105.80', '104.50', '105.60'],
    ];
    const candles1m = rows.map(([open, high, low, close], i) =>
      candle(TEST_15M_TS + i * MINUTE, open, high, low, close),
    );

    expect(
      scenario.evaluate(bullishPatternData({ candles1m })),
    ).toBe(true);

    const levels = scenario.getLevels();
    expect(levels.entry.toString()).toBe('104.05');

    // The realized R:R (the one the exchange will actually deliver) must clear
    // the 1.5R floor. Validating at 104.00 instead would report a higher number
    // than the fill can achieve.
    const realizedRr = levels.takeProfit
      .minus(levels.entry)
      .div(levels.entry.minus(levels.stopLoss));
    expect(realizedRr.gte('1.5')).toBe(true);
  });

  it('ignores a 1m trigger already burned in mitigatedStructures', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const patternData = bullishPatternData();
    patternData.mitigatedStructures = [
      {
        type: 'CHoCH',
        timestamp: TEST_15M_TS + TRIGGER_1M_INDEX * MINUTE,
        price: '103.4',
        direction: 'BULLISH',
      },
    ];

    expect(scenario.evaluate(patternData)).toBe(false);
    expect(scenario.getReason()).toMatch(/No validated 1m BULLISH/i);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.triggered).toBe(0);
  });

  it('includes the POI touch candle sweep wick in the stop reference (D5 revert)', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const candles1m = makeBullish1m();
    // The touch minute (index 0) prints a deep sweep wick to 102.20 — far below
    // the reaction low at 103.00. D5 excluded it and the stop sat INSIDE the
    // invalidation, where a normal mitigation wick could clip it. The stop must
    // clear the full reaction window, including the touch wick.
    candles1m[0] = candle(TEST_15M_TS, '103.65', '103.75', '102.20', '103.70');

    // The wider stop lowers the R:R, so the macro target must sit farther away
    // for the setup to clear the 1.5R floor.
    expect(
      scenario.evaluate(bullishPatternData({ candles1m, pdh: '107.0' })),
    ).toBe(true);

    const levels = scenario.getLevels();
    // 102.20 (touch sweep wick) - 0.1% floor, NOT 103.00 - floor.
    expect(levels.stopLoss.toString()).toBe('102.09595');
    expect(levels.stopLoss.toString()).not.toBe('102.89595');
  });

  it('mirrors the D5 revert on the bearish side: a touch-candle high spike widens the stop', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const candles1m = makeBearish1m();
    // Mirror of the bullish case: the touch minute spikes to 108.60, above the
    // reaction high at 107.80. The stop must sit beyond it, not inside it.
    candles1m[0] = { ...candles1m[0], high: '108.60' };

    const patternData = bearishPatternData();
    patternData.candles1m = candles1m;
    // The wider stop lowers the R:R, so pull the macro target farther away.
    patternData.macroContext.dailyLevels.pdl = new Decimal('103.8');
    expect(scenario.evaluate(patternData)).toBe(true);

    const levels = scenario.getLevels();
    // 108.60 (touch sweep high) + 0.1% floor, NOT 107.80 + floor.
    expect(levels.stopLoss.toString()).toBe('108.70675');
    expect(levels.stopLoss.toString()).not.toBe('107.90675');
  });

  it('iterates proximity-ranked POIs instead of shadowing the tested zone with the newest one', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // A brand-new supply POI sits 0.3 from price but is never touched. The older
    // demand POI 2.1 away IS the zone price is testing. The legacy "take the
    // newest zone" rule selected the untouched one and rejected the setup.
    const untouchedZone: Zone = {
      type: 'OB',
      top: new Decimal('105.95'),
      bottom: new Decimal('105.85'),
      timestamp: BASE_15M + 22 * M15,
      mitigated: false,
      timeframe: '15',
      direction: 'BULLISH',
    };
    const testedZone: Zone = {
      type: 'OB',
      top: new Decimal(BULL_ZONE_TOP),
      bottom: new Decimal(BULL_ZONE_BOTTOM),
      timestamp: BASE_15M + 10 * M15,
      mitigated: false,
      timeframe: '15',
      direction: 'BULLISH',
    };

    expect(
      scenario.evaluate(
        bullishPatternData({ zones: [testedZone, untouchedZone] }),
      ),
    ).toBe(true);

    const zone = scenario.getZoneDetails();
    expect(zone?.top.toString()).toBe(BULL_ZONE_TOP);
    expect(zone?.bottom.toString()).toBe(BULL_ZONE_BOTTOM);
    expect(scenario.getLevels().entry.toString()).toBe(
      BULL_TRIGGER_CLOSE.toString(),
    );
  });

  it('rejects a 1m CHoCH that printed BEFORE the POI touch minute (causality)', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // Price sits above the POI, prints a bullish displacement at minute 8, then
    // trades down into the demand zone at minute 12 and never reacts again.
    // Anchoring the window at the 15m candle open would accept that pre-touch
    // CHoCH; anchoring at the touch minute must reject it.
    const rows: Array<[string, string, string, string]> = [
      ['105.00', '105.20', '104.90', '105.10'],
      ['105.10', '105.20', '104.95', '105.00'],
      ['105.00', '105.15', '104.95', '105.05'],
      ['105.05', '105.10', '104.95', '105.00'],
      ['105.00', '105.30', '104.95', '105.25'],
      ['105.25', '105.25', '105.05', '105.10'],
      ['105.10', '105.15', '105.00', '105.05'],
      ['105.05', '105.15', '105.00', '105.10'],
      ['105.10', '105.90', '105.05', '105.85'],
      ['105.85', '105.90', '105.60', '105.70'],
      ['105.70', '105.75', '105.40', '105.45'],
      ['105.45', '105.50', '104.80', '104.90'],
      ['104.90', '104.95', '103.00', '103.10'],
    ];
    while (rows.length < 33) {
      rows.push(['103.10', '103.20', '103.00', '103.10']);
    }
    const candles1m = rows.map(([open, high, low, close], i) =>
      candle(TEST_15M_TS + i * MINUTE, open, high, low, close),
    );

    expect(
      scenario.evaluate(bullishPatternData({ candles1m })),
    ).toBe(false);

    expect(scenario.getReason()).toMatch(/No validated 1m BULLISH/i);
    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.noReaction).toBe(1);
    expect(stats.triggered).toBe(0);
  });

  it('rejects a 1m trigger that falls outside the 30-minute reaction window', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(
      scenario.evaluate(
        bullishPatternData({ candles1m: makeBullish1mAt(30) }),
      ),
    ).toBe(false);

    expect(scenario.getReason()).toMatch(/No validated 1m BULLISH/i);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.noReaction).toBe(1);
    expect(stats.triggered).toBe(0);
  });

  it('routes a missing structural origin to its own funnel bucket', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const flat: Candle[] = [];
    for (let i = 0; i < 24; i += 1) {
      flat.push(
        candle(BASE_15M + i * M15, '103.4', '103.8', '103.2', '103.5'),
      );
    }

    expect(scenario.evaluate(bullishPatternData({ candles15m: flat }))).toBe(false);
    expect(scenario.getReason()).toMatch(/No valid pullback origin/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.noPullbackOrigin).toBe(1);
    expect(stats.volumeInvalid).toBe(0);
  });

  it('routes a one-candle pullback to its own funnel bucket', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const candles15m = makeBullish15m();
    // Make index 21 the highest high, leaving only index 22 as a corrective
    // candle before the reaction candle.
    candles15m[21] = candle(
      BASE_15M + 21 * M15,
      '118.5',
      '120',
      '117',
      '118',
      '60',
    );

    expect(scenario.evaluate(bullishPatternData({ candles15m }))).toBe(false);
    expect(scenario.getReason()).toMatch(/Insufficient corrective candles/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.insufficientPullbackCandles).toBe(1);
    expect(stats.noPullbackOrigin).toBe(0);
  });

  it('keeps a decisive POI break in the dedicated poiViolated bucket', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const candles15m = makeBullish15m();
    candles15m[22] = candle(
      BASE_15M + 22 * M15,
      '105.4',
      '105.6',
      '101.8',
      '102.0',
      '60',
    );

    expect(scenario.evaluate(bullishPatternData({ candles15m }))).toBe(false);
    expect(scenario.getReason()).toMatch(/structurally violated/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.poiViolated).toBe(1);
    expect(stats.volumeInvalid).toBe(0);
  });

  it('reports no POI touch separately from volume exhaustion failures', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
    const candles15m = makeBullish15m();
    candles15m[23] = candle(TEST_15M_TS, '105.0', '105.8', '104.4', '105.6', '150');

    expect(scenario.evaluate(bullishPatternData({ candles15m }))).toBe(false);
    expect(scenario.getReason()).toMatch(/did not touch the POI/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.noPoiTouch).toBe(1);
    expect(stats.pullbackVolumeHeavy).toBe(0);
  });

  it('keeps malformed volume diagnostics in the volumeInvalid bucket', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    expect(
      scenario.evaluate(bullishPatternData({ atr15m: new Decimal(0) })),
    ).toBe(false);
    expect(scenario.getReason()).toMatch(/Invalid 15m ATR/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.volumeInvalid).toBe(1);
    expect(stats.noPullbackOrigin).toBe(0);
  });

  it('allows a 1.6R continuation when config permits 1.5R', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // Entry 104.05, risk 1.15405; 1.6R target = 104.05 + 1.84648 = 105.89648.
    const patternData = bullishPatternData({ pdh: '105.89648' });

    expect(scenario.evaluate(patternData)).toBe(true);

    const levels = scenario.getLevels();
    expect(levels.entry.toString()).toBe('104.05');
    expect(levels.takeProfit.toString()).toBe('105.89648');

    const rr = levels.takeProfit.minus(levels.entry).div(levels.entry.minus(levels.stopLoss));
    expect(rr.toString()).toBe('1.6');

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.triggered).toBe(1);
    expect(stats.insufficientAsymmetry).toBe(0);
  });

  it('allows a 2.5R continuation that the old 3.5R floor rejected', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // Entry 104.05, risk 1.15405; 2.5R target = 104.05 + 2.885125 = 106.935125.
    const patternData = bullishPatternData({ pdh: '106.935125' });

    expect(scenario.evaluate(patternData)).toBe(true);

    const levels = scenario.getLevels();
    expect(levels.entry.toString()).toBe('104.05');
    expect(levels.stopLoss.toString()).toBe('102.89595');
    expect(levels.takeProfit.toString()).toBe('106.935125');

    const rr = levels.takeProfit.minus(levels.entry).div(levels.entry.minus(levels.stopLoss));
    expect(rr.toString()).toBe('2.5');

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.triggered).toBe(1);
    expect(stats.insufficientAsymmetry).toBe(0);
  });

  it('rejects when the macro asymmetry is below the configured 1.5R floor', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // PDH 105.7 is only (105.7 - 104.05) / 1.15405 = 1.43R away. It must stay
    // above the 4H close (105.6) or the roadmap would reject before the wall
    // filter ever runs.
    const patternData = bullishPatternData({ pdh: '105.7' });

    expect(scenario.evaluate(patternData)).toBe(false);

    expect(scenario.getReason()).toMatch(/Insufficient room|Asymmetry/);

    const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
    expect(stats.totalEvals).toBe(1);
    expect(stats.insufficientAsymmetry).toBe(1);
    expect(stats.triggered).toBe(0);
  });

  it('skips a minor swing wall and targets the macro pool beyond it', () => {
    const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

    // A 4H swing BSL sits at 104.9 (~0.74R) — under the legacy nearest-wins rule
    // it would reject the setup outright. It is internal noise: the PDH macro
    // draw at 2.14R is the real destination.
    const minorSwing: any = {
      type: 'BSL',
      priceLevel: new Decimal('104.9'),
      points: [],
      isTaken: false,
      timestamp: 1,
    };
    const patternData = bullishPatternData();
    patternData.liquidityPools = [minorSwing];

    expect(scenario.evaluate(patternData)).toBe(true);

    const levels = scenario.getLevels();
    expect(levels.takeProfit.toString()).toBe(BULL_PDH);
  });

  // -------------------------------------------------------------------------
  // Strict Sniper Mode requirement (no blind 15m fallback)
  // -------------------------------------------------------------------------

  describe('strict Sniper Mode requirement', () => {
    it('fails closed when ENABLE_SNIPER_MODE is false', () => {
      const scenario = new Scenario13_TopDownOrderFlow({
        ...mockConfig,
        enableSniperMode: false,
      });

      expect(
        scenario.evaluate(bullishPatternData({ candles1m: [] })),
      ).toBe(false);

      expect(scenario.getLevels().entry.isZero()).toBe(true);
      expect(scenario.getZoneDetails()).toBeNull();
      expect(scenario.getStructureDetails()).toBeNull();
      expect(scenario.getReason()).toBe(
        'Scenario 13 strictly requires Sniper Mode (1m feed)',
      );

      const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
      expect(stats.totalEvals).toBe(1);
      expect(stats.disabled).toBe(1);
      expect(stats.triggered).toBe(0);
    });

    it('fails closed when the 1m feed has fewer than 15 candles', () => {
      const scenario = new Scenario13_TopDownOrderFlow(mockConfig);

      expect(
        scenario.evaluate(
          bullishPatternData({ candles1m: makeBullish1m().slice(0, 5) }),
        ),
      ).toBe(false);

      expect(scenario.getReason()).toBe(
        'Scenario 13 strictly requires Sniper Mode (1m feed)',
      );

      const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
      expect(stats.disabled).toBe(1);
      expect(stats.noReaction).toBe(0);
      expect(stats.triggered).toBe(0);
    });

    it('requires a 1m micro-CHoCH even when the 15m POI reaction is valid', () => {
      const scenario = new Scenario13_TopDownOrderFlow(mockConfig);
      // Valid 15m POI touch + volume exhaustion, but the 1m window prints no
      // displacement structure in the trade direction.
      const flat1m = makeBullish1m().map((entry) => ({
        ...entry,
        open: '103.70',
        high: '103.75',
        low: '103.65',
        close: '103.70',
      }));

      expect(
        scenario.evaluate(bullishPatternData({ candles1m: flat1m })),
      ).toBe(false);

      expect(scenario.getReason()).toMatch(/1m BULLISH displacement structure/);

      const stats = Scenario13_TopDownOrderFlow.getRejectionStats();
      expect(stats.noReaction).toBe(1);
      expect(stats.disabled).toBe(0);
      expect(stats.triggered).toBe(0);
    });
  });
});
