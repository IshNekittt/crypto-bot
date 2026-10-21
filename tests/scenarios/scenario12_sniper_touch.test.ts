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
  sniperDisplacementMultiplier: '0.5',
  limitExpirationCandles: 6,
  smartEntryThresholdPct: '0.0015',
  enableSniperMode: true,
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
 * - index 20: PDL (100) sweep candle (low 99.8, close 100.5)
 * - index 29: bearish OB candle (top 101.05 / bottom 100.7), near the swept level
 * - index 30: bullish CHoCH closing at 101.4 (body 0.5 >= 0.5 * ATR)
 *
 * ATR(1m) of the trailing flat candles is 0.4, so the displacement threshold is 0.2.
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
      open: '100.9',
      high: '101.45',
      low: '100.85',
      close: '101.4',
    });
  }

  return candles;
}

function buildPatternData(candles: any[], options: { atr15m?: Decimal } = {}) {
  return {
    candles15m: candles,
    candles4h: [],
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
    tradingRange: null,
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
    expect(scenario.getReason()).toMatch(/No BULLISH CHoCH after latest PDL sweep/);
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
    expect(scenario.getReason()).toMatch(/No BULLISH CHoCH after latest PDL sweep/);
  });
});
