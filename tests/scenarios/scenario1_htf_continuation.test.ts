import { Scenario1_HTFContinuation } from '../../src/engine/scenarios/Scenario1_HTFContinuation';
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
  activeScenarios: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  enableFundingMonitor: false,
  fundingMonitorSymbols: [],
  fundingAlertThresholdPct: '0.0',
  fundingRestoreThresholdPct: '0.0001',
  symbolScenarios: new Map(),
  backtestCsvPath: null,
  cooldownCandles: 16,
  smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6,
  sniperLimitExpirationCandles: 15,
  smcSweepMinWickRatio: new Decimal('0.25'),
  smartEntryThresholdPct: '0.0015',
  enableSniperMode: false,
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
const LTF_MS = 15 * 60 * 1000;
const CANDLE_COUNT = 30;
const TOUCH_INDEX = 16;
const CHOCH_INDEX = 20;
const FVG_INDEX = 24;

function candle(index: number, overrides: Record<string, string> = {}) {
  return {
    timestamp: BASE_TS + index * LTF_MS,
    open: '102',
    high: '102.4',
    low: '101.6',
    close: '102',
    volume: '1000',
    ...overrides,
  };
}

interface FixtureOptions {
  readonly direction?: 'BULLISH' | 'BEARISH';
  readonly touchIndex?: number;
  readonly chochIndex?: number;
  readonly fvgIndex?: number;
  readonly displacement?: string;
  readonly withFvg?: boolean;
  readonly obDirection?: 'BULLISH' | 'BEARISH';
  readonly extraPools?: Array<{ type: string; price: string }>;
  readonly killzone?: string;
}

/**
 * Builds a 30-candle 15m series that contains the full HTF-continuation chain:
 * 4H OB touch → 15m CHoCH at/after the touch → 15m FVG at/after the CHoCH.
 *
 * Long:  bullish 4H demand 100-101 touched at index 16, CHoCH at 20, FVG 100.5-101.5.
 * Short: bearish 4H supply 103-104 touched at index 16, CHoCH at 20, FVG 102-103.
 */
function buildPatternData(options: FixtureOptions = {}) {
  const direction = options.direction ?? 'BULLISH';
  const touchIndex = options.touchIndex ?? TOUCH_INDEX;
  const chochIndex = options.chochIndex ?? CHOCH_INDEX;
  const fvgIndex = options.fvgIndex ?? FVG_INDEX;

  const candles = Array.from({ length: CANDLE_COUNT }, (_, i) => candle(i));

  candles[touchIndex] =
    direction === 'BULLISH'
      ? candle(touchIndex, { open: '101.8', high: '102', low: '100.5', close: '101.5' })
      : candle(touchIndex, { open: '102.2', high: '103.5', low: '102', close: '102.5' });

  const obDirection = options.obDirection ?? direction;
  const ob =
    obDirection === 'BULLISH'
      ? { type: 'OB', direction: 'BULLISH', top: new Decimal(101), bottom: new Decimal(100) }
      : { type: 'OB', direction: 'BEARISH', top: new Decimal(104), bottom: new Decimal(103) };

  const structures = [
    {
      type: 'CHOCH',
      direction,
      price: new Decimal(direction === 'BULLISH' ? 102.2 : 101.8),
      timestamp: candles[chochIndex].timestamp,
      isValidated: true,
      impulseFactor: new Decimal(options.displacement ?? '2.0'),
      timeframe: '15',
    },
  ];

  const zones: any[] = [
    {
      ...ob,
      timestamp: BASE_TS,
      mitigated: false,
      timeframe: '240',
    },
  ];

  if (options.withFvg !== false) {
    zones.push(
      direction === 'BULLISH'
        ? {
            type: 'FVG',
            direction: 'BULLISH',
            top: new Decimal('101.5'),
            bottom: new Decimal('100.5'),
            timestamp: candles[fvgIndex].timestamp,
            mitigated: false,
            timeframe: '15',
          }
        : {
            type: 'FVG',
            direction: 'BEARISH',
            top: new Decimal('103'),
            bottom: new Decimal('102'),
            timestamp: candles[fvgIndex].timestamp,
            mitigated: false,
            timeframe: '15',
          },
    );
  }

  const liquidityPools = (options.extraPools ?? []).map((p) => ({
    type: p.type,
    priceLevel: new Decimal(p.price),
    points: [],
    isTaken: false,
    timestamp: BASE_TS,
  }));

  return {
    currentKillzone: options.killzone ?? 'LONDON',
    currentSession: 'LONDON',
    candles15m: candles,
    structures,
    zones,
    liquidityPools,
    atr15m: new Decimal('0.5'),
  } as any;
}

describe('Scenario1: HTF Continuation', () => {
  let scenario: Scenario1_HTFContinuation;

  beforeEach(() => {
    scenario = new Scenario1_HTFContinuation(mockConfig);
  });

  describe('bidirectional evaluation', () => {
    it('triggers a Long from a bullish 4H demand touch + BULLISH CHoCH + FVG', () => {
      const result = scenario.evaluate(buildPatternData({ direction: 'BULLISH' }));

      expect(result).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.entry.lt(levels.takeProfit)).toBe(true);
      // entry = FVG midpoint (101.5 + 100.5) / 2 = 101
      expect(levels.entry.toString()).toBe('101');
      // offset = max(0.5 * 0.5, 101 * 0.001) = 0.25 → SL = 100.5 - 0.25
      expect(levels.stopLoss.toString()).toBe('100.25');
      // fixed 3R (dynamic TP disabled): 101 + 0.75 * 3
      expect(levels.takeProfit.toString()).toBe('103.25');

      expect(scenario.getZoneDetails()?.type).toBe('FVG');
      expect(scenario.getZoneDetails()?.direction).toBe('BULLISH');
      expect(scenario.getStructureDetails()?.type).toBe('CHoCH');
      expect(scenario.getStructureDetails()?.direction).toBe('BULLISH');
      expect(scenario.getStructureDetails()?.timestamp).toBe(
        BASE_TS + CHOCH_INDEX * LTF_MS,
      );
    });

    it('triggers a Short from a bearish 4H supply touch + BEARISH CHoCH + FVG', () => {
      const result = scenario.evaluate(buildPatternData({ direction: 'BEARISH' }));

      expect(result).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.entry.gt(levels.takeProfit)).toBe(true);
      // entry = FVG midpoint (103 + 102) / 2 = 102.5
      expect(levels.entry.toString()).toBe('102.5');
      // offset = 0.25 → SL = 103 + 0.25
      expect(levels.stopLoss.toString()).toBe('103.25');
      // 3R: 102.5 - 0.75 * 3
      expect(levels.takeProfit.toString()).toBe('100.25');

      expect(scenario.getStructureDetails()?.direction).toBe('BEARISH');
    });

    it('takes the direction from the tested 4H OB, not from the CHoCH label', () => {
      // BULLISH CHoCH but only a BEARISH 4H OB: there is no matching touch.
      const result = scenario.evaluate(
        buildPatternData({ direction: 'BULLISH', obDirection: 'BEARISH' }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('has not touched a matching 4H OB');
    });
  });

  describe('causality and windows', () => {
    it('rejects a CHoCH that formed before the 4H OB touch', () => {
      const result = scenario.evaluate(
        buildPatternData({ chochIndex: TOUCH_INDEX - 6 }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('has not touched a matching 4H OB before the CHoCH');
    });

    it('rejects a touch older than the 16-candle (4H) window', () => {
      // Touch at index 0, CHoCH at index 20 → 20 candles > 16.
      const result = scenario.evaluate(
        buildPatternData({ touchIndex: 0, chochIndex: 20 }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('has not touched a matching 4H OB');
    });

    it('rejects an FVG that formed before the CHoCH', () => {
      const result = scenario.evaluate(buildPatternData({ fvgIndex: CHOCH_INDEX - 2 }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No 15m FVG found after CHoCH');
    });

    it('rejects an FVG that formed outside the 4H window opened by the touch', () => {
      // touch 4 → CHoCH 16 (12 candles, valid) → FVG 21 (17 candles, too late).
      const result = scenario.evaluate(
        buildPatternData({ touchIndex: 4, chochIndex: 16, fvgIndex: 21 }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No 15m FVG found after CHoCH');
    });

    it('rejects a CHoCH with displacement below 1.5 ATR', () => {
      const result = scenario.evaluate(buildPatternData({ displacement: '1.0' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('displacement < 1.5 ATR');
    });
  });

  describe('filters', () => {
    it('rejects outside an active killzone', () => {
      const result = scenario.evaluate(buildPatternData({ killzone: 'NONE' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('Not in active killzone');
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypass = new Scenario1_HTFContinuation({ ...mockConfig, enforceKillzones: false });
      const result = bypass.evaluate(buildPatternData({ killzone: 'NONE' }));

      expect(result).toBe(true);
    });

    it('ignores already mitigated 4H OBs', () => {
      const data = buildPatternData();
      data.zones[0].mitigated = true;

      const result = scenario.evaluate(data);

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid unmitigated 4H Order Block');
    });
  });

  describe('take-profit resolution', () => {
    it('snaps to the nearest structural pool when dynamic TP is enabled', () => {
      const dynamic = new Scenario1_HTFContinuation({ ...mockConfig, enableDynamicTp: true });
      const data = buildPatternData({
        direction: 'BULLISH',
        extraPools: [{ type: 'EQH', price: '102.5' }],
      });

      expect(dynamic.evaluate(data)).toBe(true);
      // 102.5 is 1.5 / 0.75 = 2R away — above the 1.5R floor.
      expect(dynamic.getLevels().takeProfit.toString()).toBe('102.5');
    });

    it('rejects when the nearest pool leaves less than minRr of room', () => {
      const dynamic = new Scenario1_HTFContinuation({ ...mockConfig, enableDynamicTp: true });
      // 101.5 is 0.5 / 0.75 = 0.667R away — the wall filter must reject, not clamp.
      const data = buildPatternData({
        direction: 'BULLISH',
        extraPools: [{ type: 'EQH', price: '101.5' }],
      });

      expect(dynamic.evaluate(data)).toBe(false);
      expect(dynamic.getReason()).toContain('Take-profit rejected');
    });

    it('clamps an over-extended structural target to DYNAMIC_TP_MAX_RR', () => {
      const dynamic = new Scenario1_HTFContinuation({ ...mockConfig, enableDynamicTp: true });
      // 110 is 9 / 0.75 = 12R away → clamped to 6R = 101 + 4.5
      const data = buildPatternData({
        direction: 'BULLISH',
        extraPools: [{ type: 'EQH', price: '110' }],
      });

      expect(dynamic.evaluate(data)).toBe(true);
      expect(dynamic.getLevels().takeProfit.toString()).toBe('105.5');
    });
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(101.5);
      const zone = { top: new Decimal(104), bottom: new Decimal(102), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);

      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(98.5);
      const zone = { top: new Decimal(98), bottom: new Decimal(96), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);

      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(101.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(102), bottom: new Decimal(104), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);

      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(98.5);
      // Inverted: top < bottom
      const zone = { top: new Decimal(96), bottom: new Decimal(98), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);

      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});
