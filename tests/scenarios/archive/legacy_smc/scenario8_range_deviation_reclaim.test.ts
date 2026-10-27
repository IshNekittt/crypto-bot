import { Scenario8_RangeDeviationReclaim } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario8_RangeDeviationReclaim';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../src/config/env';

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
  minNetRr: new Decimal(1),
  minVolatilityFeeRatio: new Decimal(1),
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

/** Dynamic-resolver variant: exercises structural TP selection instead of fixed 3R. */
const dynamicTpConfig: BotConfig = { ...mockConfig, enableDynamicTp: true };

const FIXED_NOW = 1788675600000;
const TF_MS = 15 * 60 * 1000;
const LENGTH = 12;

type Direction = 'BULLISH' | 'BEARISH';

const tsAt = (index: number): number => FIXED_NOW - (LENGTH - 1 - index) * TF_MS;

interface CandleOverrides {
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

/** Quiet candle well inside the 4940..5002 range. */
const baseCandle = (index: number, overrides: CandleOverrides = {}): any => ({
  timestamp: tsAt(index),
  open: overrides.open ?? '4960',
  high: overrides.high ?? '4965',
  low: overrides.low ?? '4955',
  close: overrides.close ?? '4958',
  volume: '1000',
});

const flatCandles = (): any[] => Array.from({ length: LENGTH }, (_, i) => baseCandle(i));

/**
 * Default long fixture (deviation below the range low, then reclaim).
 *
 *   Range      : high 5002 / low 4940 (equilibrium 4971), ATR15m 1
 *   Penetration: max(0.1 ATR, 0.05% of 4940) = 2.47
 *   idx 4      : low 4935 (5 below the low), close 4939 → armed breach
 *   idx 5      : close 4942 → reclaim (first body back inside), extreme = 4935
 *   idx 7      : BULLISH CHoCH, impulseFactor 2
 *   idx 9      : BULLISH FVG 4946 / 4941 → entry 4943.5
 *   idx 11     : last closed candle, low 4955
 *
 *   SL = min(4946, 4935, 4943.5) - max(0.5 ATR, 0.1% of 4943.5) = 4935 - 4.9435
 *      = 4930.0565
 *   3R = 4943.5 + 3 * 13.4435 = 4983.8305
 */
const longCandles = (): any[] => {
  const candles = flatCandles();
  candles[4] = baseCandle(4, { open: '4960', high: '4962', low: '4935', close: '4939' });
  candles[5] = baseCandle(5, { open: '4939', high: '4945', low: '4941', close: '4942' });
  return candles;
};

/**
 * Mirrored short fixture (deviation above the range high, then reclaim).
 *
 *   idx 4: high 5008 (6 above the high), close 5003 → armed breach
 *   idx 5: high 5003.5 (1.5 above → below the 2.501 gate), close 4998 → reclaim
 *   idx 7: BEARISH CHoCH
 *   idx 9: BEARISH FVG 5000 / 4995 → entry 4997.5
 *
 *   SL = max(5000, 5008, 4997.5) + max(0.5, 4.9975) = 5008 + 4.9975 = 5012.9975
 *   3R = 4997.5 - 3 * 15.4975 = 4951.0075
 */
const shortCandles = (): any[] => {
  const candles = flatCandles();
  candles[4] = baseCandle(4, { open: '4990', high: '5008', low: '4988', close: '5003' });
  candles[5] = baseCandle(5, { open: '5003', high: '5003.5', low: '4995', close: '4998' });
  return candles;
};

const makeChoch = (
  direction: Direction,
  index: number,
  price: string,
  impulseFactor = '2',
): any => ({
  type: 'CHOCH',
  direction,
  price: new Decimal(price),
  timestamp: tsAt(index),
  timeframe: '15',
  isValidated: true,
  impulseFactor: new Decimal(impulseFactor),
});

const makeFvg = (
  direction: Direction,
  index: number,
  top: string,
  bottom: string,
  timeframe = '15',
): any => ({
  type: 'FVG',
  direction,
  top: new Decimal(top),
  bottom: new Decimal(bottom),
  timestamp: tsAt(index),
  mitigated: false,
  timeframe,
});

const makeOb = (
  direction: Direction,
  index: number,
  top: string,
  bottom: string,
  timeframe = '15',
): any => ({
  type: 'OB',
  direction,
  top: new Decimal(top),
  bottom: new Decimal(bottom),
  timestamp: tsAt(index),
  mitigated: false,
  timeframe,
});

interface PatternOverrides {
  candles?: any[];
  zones?: any[];
  structures?: any[];
  tradingRange?: any;
  killzone?: string;
  atr?: Decimal;
  pools?: any[];
}

const makePatternData = (overrides: PatternOverrides = {}): any => ({
  currentKillzone: overrides.killzone ?? 'LONDON',
  currentSession: 'LONDON',
  candles15m: overrides.candles ?? longCandles(),
  tradingRange:
    overrides.tradingRange === undefined
      ? {
          high: new Decimal('5002'),
          low: new Decimal('4940'),
          equilibrium: new Decimal('4971'),
          isDeviated: true,
        }
      : overrides.tradingRange,
  zones: overrides.zones ?? [makeFvg('BULLISH', 9, '4946', '4941')],
  structures: overrides.structures ?? [makeChoch('BULLISH', 7, '4960')],
  liquidityPools: overrides.pools ?? [],
  sessionRanges: [],
  atr15m: overrides.atr ?? new Decimal(1),
});

describe('Scenario8: Range Deviation & Reclaim', () => {
  let scenario: Scenario8_RangeDeviationReclaim;

  beforeEach(() => {
    Scenario8_RangeDeviationReclaim.resetStats();
    scenario = new Scenario8_RangeDeviationReclaim(mockConfig);
  });

  describe('ideal long (range low deviation → reclaim)', () => {
    it('triggers on deviation below the range low followed by a reclaim', () => {
      const result = scenario.evaluate(makePatternData());

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Range Deviation');
      expect(scenario.getReason()).toContain('Range Low deviation');
      expect(scenario.getReason()).toContain('BULLISH CHoCH');
    });

    it('enters at the 15m FVG midpoint and stops beyond the excursion wick', () => {
      scenario.evaluate(makePatternData());
      const levels = scenario.getLevels();

      expect(levels.entry.toString()).toBe('4943.5');
      // min(fvgBottom 4941, excursion extreme 4935, lastLow 4955) - 4.9435
      expect(levels.stopLoss.toString()).toBe('4930.0565');
      // fixed 3R fallback: 4943.5 + 3 * 13.4435
      expect(levels.takeProfit.toString()).toBe('4983.8305');
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('tags the CHoCH as the burn anchor and the 15m FVG as the entry zone', () => {
      scenario.evaluate(makePatternData());

      const structure = scenario.getStructureDetails();
      expect(structure).not.toBeNull();
      expect(structure!.type).toBe('CHoCH');
      expect(structure!.direction).toBe('BULLISH');
      expect(structure!.timestamp).toBe(tsAt(7));
      expect(structure!.price!.toString()).toBe('4960');

      const zone = scenario.getZoneDetails();
      expect(zone).not.toBeNull();
      expect(zone!.type).toBe('FVG');
      expect(zone!.timeframe).toBe('15');
      expect(zone!.direction).toBe('BULLISH');
      expect(zone!.top.toString()).toBe('4946');
      expect(zone!.bottom.toString()).toBe('4941');
      expect(zone!.timestamp).toBe(tsAt(9));
    });
  });

  describe('ideal short (range high deviation → reclaim)', () => {
    const shortPattern = (overrides: PatternOverrides = {}): any =>
      makePatternData({
        candles: shortCandles(),
        zones: [makeFvg('BEARISH', 9, '5000', '4995')],
        structures: [makeChoch('BEARISH', 7, '4980')],
        ...overrides,
      });

    it('triggers the mirrored short', () => {
      const result = scenario.evaluate(shortPattern());

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Range High deviation');
      expect(scenario.getReason()).toContain('BEARISH CHoCH');
    });

    it('mirrors the stop and target geometry around the entry', () => {
      scenario.evaluate(shortPattern());
      const levels = scenario.getLevels();

      expect(levels.entry.toString()).toBe('4997.5');
      // max(fvgTop 5000, excursion extreme 5008, lastHigh 4965) + 4.9975
      expect(levels.stopLoss.toString()).toBe('5012.9975');
      // fixed 3R fallback: 4997.5 - 3 * 15.4975
      expect(levels.takeProfit.toString()).toBe('4951.0075');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('reports a BEARISH zone and structure', () => {
      scenario.evaluate(shortPattern());

      expect(scenario.getZoneDetails()!.direction).toBe('BEARISH');
      expect(scenario.getStructureDetails()!.direction).toBe('BEARISH');
    });
  });

  describe('killzone gate', () => {
    it('rejects outside London/NY', () => {
      const result = scenario.evaluate(makePatternData({ killzone: 'ASIAN' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().killzone).toBe(1);
    });

    it('accepts NY', () => {
      expect(scenario.evaluate(makePatternData({ killzone: 'NY' }))).toBe(true);
    });

    it('is bypassed by ENFORCE_KILLZONES=false', () => {
      const loose = new Scenario8_RangeDeviationReclaim({
        ...mockConfig,
        enforceKillzones: false,
      });

      expect(loose.evaluate(makePatternData({ killzone: 'NONE' }))).toBe(true);
    });
  });

  describe('trading range gate', () => {
    it('rejects without a trading range', () => {
      const result = scenario.evaluate(makePatternData({ tradingRange: null }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid trading range');
      expect(
        Scenario8_RangeDeviationReclaim.getRejectionStats().noTradingRange,
      ).toBe(1);
    });

    it('rejects an inverted range (high <= low)', () => {
      const result = scenario.evaluate(
        makePatternData({
          tradingRange: {
            high: new Decimal('4940'),
            low: new Decimal('5002'),
            equilibrium: new Decimal('4971'),
            isDeviated: true,
          },
        }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid trading range');
    });

    it('rejects a single-candle series', () => {
      const result = scenario.evaluate(makePatternData({ candles: [baseCandle(11)] }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid trading range');
    });
  });

  describe('deviation gate', () => {
    it('rejects when price never leaves the range', () => {
      const result = scenario.evaluate(makePatternData({ candles: flatCandles() }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No range deviation');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noDeviation).toBe(1);
    });

    it('rejects a boundary kiss below the penetration threshold', () => {
      // low 4939.5 penetrates 0.5 < max(0.1 ATR, 0.05% of 4940 = 2.47)
      const candles = flatCandles();
      candles[4] = baseCandle(4, { open: '4960', high: '4962', low: '4939.5', close: '4939' });

      const result = scenario.evaluate(makePatternData({ candles }));

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noDeviation).toBe(1);
    });

    it('rejects an excursion that never reclaims the range', () => {
      const candles = flatCandles();
      for (let i = 4; i < LENGTH; i++) {
        candles[i] = baseCandle(i, { open: '4942', high: '4944', low: '4935', close: '4936' });
      }

      const result = scenario.evaluate(makePatternData({ candles }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('has not reclaimed');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noReclaim).toBe(1);
    });

    it('voids the chain when price closes through the opposite boundary', () => {
      // The reclaiming body closes above the range high: the excursion became a
      // full range break, not a fake-out, so the range thesis is dead.
      const candles = flatCandles();
      candles[4] = baseCandle(4, { open: '4960', high: '4962', low: '4935', close: '4939' });
      candles[5] = baseCandle(5, { open: '4945', high: '5003', low: '4944', close: '5002.5' });

      const result = scenario.evaluate(makePatternData({ candles }));

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noReclaim).toBe(1);
    });

    it('anchors on the FRESHEST reclaimable excursion, not the deeper older one', () => {
      // Older chain (idx 1 → 2) pokes to 4920; fresher chain (idx 5 → 6) to 4935.
      // Anchoring on the older poke would put the stop at 4915.0565.
      const candles = flatCandles();
      candles[1] = baseCandle(1, { open: '4960', high: '4962', low: '4920', close: '4930' });
      candles[2] = baseCandle(2, { open: '4930', high: '4945', low: '4931', close: '4942' });
      candles[5] = baseCandle(5, { open: '4960', high: '4962', low: '4935', close: '4939' });
      candles[6] = baseCandle(6, { open: '4939', high: '4945', low: '4941', close: '4942' });

      const result = scenario.evaluate(makePatternData({ candles }));

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getLevels().stopLoss.toString()).toBe('4930.0565');
    });

    it('accepts the excursion candle itself as the reclaim', () => {
      // One bar pierces the low and closes back inside — a range SFP.
      const candles = flatCandles();
      candles[4] = baseCandle(4, { open: '4945', high: '4946', low: '4935', close: '4942' });

      const result = scenario.evaluate(makePatternData({ candles }));

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getLevels().stopLoss.toString()).toBe('4930.0565');
    });
  });

  describe('CHoCH causality gate', () => {
    it('rejects when there is no CHoCH', () => {
      const result = scenario.evaluate(makePatternData({ structures: [] }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH at or after the range reclaim');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects a CHoCH that printed before the reclaim', () => {
      const result = scenario.evaluate(
        makePatternData({ structures: [makeChoch('BULLISH', 4, '4960')] }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('at or after');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noChoch).toBe(1);
    });

    it('accepts a CHoCH on the reclaim candle itself', () => {
      const result = scenario.evaluate(
        makePatternData({ structures: [makeChoch('BULLISH', 5, '4960')] }),
      );

      expect(result).toBe(true);
      expect(scenario.getStructureDetails()!.timestamp).toBe(tsAt(5));
    });

    it('rejects the wrong-direction CHoCH', () => {
      const result = scenario.evaluate(
        makePatternData({ structures: [makeChoch('BEARISH', 7, '4960')] }),
      );

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects a 4H CHoCH (strict 15m anchor)', () => {
      const choch = makeChoch('BULLISH', 7, '4960');
      choch.timeframe = '240';

      expect(scenario.evaluate(makePatternData({ structures: [choch] }))).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects a CHoCH with displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(
        makePatternData({ structures: [makeChoch('BULLISH', 7, '4960', '1')] }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('displacement < 1.5 ATR');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().displacement).toBe(1);
    });

    it('takes the newest qualifying CHoCH', () => {
      const result = scenario.evaluate(
        makePatternData({
          structures: [
            makeChoch('BULLISH', 7, '4960'),
            makeChoch('BULLISH', 8, '4965'),
          ],
        }),
      );

      expect(result).toBe(true);
      expect(scenario.getStructureDetails()!.timestamp).toBe(tsAt(8));
      expect(scenario.getStructureDetails()!.price!.toString()).toBe('4965');
    });
  });

  describe('entry POI gate', () => {
    it('rejects when no zone is available', () => {
      const result = scenario.evaluate(makePatternData({ zones: [] }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('FVG/OB inside the range');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noPoi).toBe(1);
    });

    it('rejects a 4H FVG (15m entry POI only)', () => {
      const result = scenario.evaluate(
        makePatternData({ zones: [makeFvg('BULLISH', 9, '4946', '4941', '240')] }),
      );

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noPoi).toBe(1);
    });

    it('rejects a POI whose midpoint sits outside the range', () => {
      const result = scenario.evaluate(
        makePatternData({ zones: [makeFvg('BULLISH', 9, '5010', '5005')] }),
      );

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noPoi).toBe(1);
    });

    it('rejects a POI older than the reclaim impulse', () => {
      // The reclaim is idx 5; the POI floor is idx 3, so an idx 2 gap is stale.
      const result = scenario.evaluate(
        makePatternData({ zones: [makeFvg('BULLISH', 2, '4946', '4941')] }),
      );

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noPoi).toBe(1);
    });

    it('rejects an opposing-direction FVG', () => {
      const result = scenario.evaluate(
        makePatternData({ zones: [makeFvg('BEARISH', 9, '4946', '4941')] }),
      );

      expect(result).toBe(false);
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().noPoi).toBe(1);
    });

    it('falls back to a 15m OB when no FVG exists', () => {
      const result = scenario.evaluate(
        makePatternData({ zones: [makeOb('BULLISH', 9, '4946', '4941')] }),
      );

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getZoneDetails()!.type).toBe('OB');
      expect(scenario.getLevels().entry.toString()).toBe('4943.5');
    });

    it('prefers the freshest FVG', () => {
      const result = scenario.evaluate(
        makePatternData({
          zones: [
            makeFvg('BULLISH', 9, '4946', '4941'),
            makeFvg('BULLISH', 10, '4944', '4942'),
          ],
        }),
      );

      expect(result).toBe(true);
      expect(scenario.getLevels().entry.toString()).toBe('4943');
      expect(scenario.getZoneDetails()!.timestamp).toBe(tsAt(10));
    });
  });

  describe('structural take-profit', () => {
    it('targets the range equilibrium on the long side', () => {
      const resolverScenario = new Scenario8_RangeDeviationReclaim(dynamicTpConfig);
      const result = resolverScenario.evaluate(makePatternData());

      if (!result) console.log('REJECTION:', resolverScenario.getReason());

      expect(result).toBe(true);
      // (4971 - 4943.5) / 13.4435 ≈ 2.05R >= minRr 1.5
      expect(resolverScenario.getLevels().takeProfit.toString()).toBe('4971');
      expect(resolverScenario.getReason()).toContain('RANGE_EQUILIBRIUM');
    });

    it('targets the range equilibrium on the short side', () => {
      const resolverScenario = new Scenario8_RangeDeviationReclaim(dynamicTpConfig);
      const result = resolverScenario.evaluate(
        makePatternData({
          candles: shortCandles(),
          zones: [makeFvg('BEARISH', 9, '5000', '4995')],
          structures: [makeChoch('BEARISH', 7, '4980')],
        }),
      );

      if (!result) console.log('REJECTION:', resolverScenario.getReason());

      expect(result).toBe(true);
      // (4997.5 - 4971) / 15.4975 ≈ 1.71R >= minRr 1.5
      expect(resolverScenario.getLevels().takeProfit.toString()).toBe('4971');
      expect(resolverScenario.getReason()).toContain('RANGE_EQUILIBRIUM');
    });

    it('rejects instead of clamping when the nearest obstacle leaves less than minRr', () => {
      const resolverScenario = new Scenario8_RangeDeviationReclaim(dynamicTpConfig);
      // A bearish 15m block just above the entry is a hard wall: 2.5 points of
      // room against 13.4435 of risk is ~0.19R.
      const result = resolverScenario.evaluate(
        makePatternData({
          zones: [
            makeFvg('BULLISH', 9, '4946', '4941'),
            makeOb('BEARISH', 10, '4947', '4946'),
          ],
        }),
      );

      expect(result).toBe(false);
      expect(resolverScenario.getReason()).toContain('Take-profit rejected');
      expect(Scenario8_RangeDeviationReclaim.getRejectionStats().tpInvalid).toBe(1);
    });
  });

  describe('rejection stats', () => {
    it('counts every funnel stage independently', () => {
      Scenario8_RangeDeviationReclaim.resetStats();
      const resolverScenario = new Scenario8_RangeDeviationReclaim(dynamicTpConfig);

      scenario.evaluate(makePatternData({ killzone: 'ASIAN' }));
      scenario.evaluate(makePatternData({ tradingRange: null }));
      scenario.evaluate(makePatternData({ candles: flatCandles() }));

      const unreclaimed = flatCandles();
      for (let i = 4; i < LENGTH; i++) {
        unreclaimed[i] = baseCandle(i, { open: '4942', high: '4944', low: '4935', close: '4936' });
      }
      scenario.evaluate(makePatternData({ candles: unreclaimed }));

      scenario.evaluate(makePatternData({ structures: [] }));
      scenario.evaluate(
        makePatternData({ structures: [makeChoch('BULLISH', 7, '4960', '1')] }),
      );
      scenario.evaluate(makePatternData({ zones: [] }));
      resolverScenario.evaluate(
        makePatternData({
          zones: [
            makeFvg('BULLISH', 9, '4946', '4941'),
            makeOb('BEARISH', 10, '4947', '4946'),
          ],
        }),
      );

      const stats = Scenario8_RangeDeviationReclaim.getRejectionStats();
      expect(stats.totalEvals).toBe(8);
      expect(stats.killzone).toBe(1);
      expect(stats.noTradingRange).toBe(1);
      expect(stats.noDeviation).toBe(1);
      expect(stats.noReclaim).toBe(1);
      expect(stats.noChoch).toBe(1);
      expect(stats.displacement).toBe(1);
      expect(stats.noPoi).toBe(1);
      expect(stats.tpInvalid).toBe(1);
    });

    it('resets to zero', () => {
      scenario.evaluate(makePatternData());
      Scenario8_RangeDeviationReclaim.resetStats();

      const stats = Scenario8_RangeDeviationReclaim.getRejectionStats();
      expect(stats.totalEvals).toBe(0);
      expect(stats.killzone).toBe(0);
      expect(stats.noTradingRange).toBe(0);
      expect(stats.noDeviation).toBe(0);
      expect(stats.noReclaim).toBe(0);
      expect(stats.noChoch).toBe(0);
      expect(stats.displacement).toBe(0);
      expect(stats.noPoi).toBe(0);
      expect(stats.tpInvalid).toBe(0);
    });
  });

  describe('integration', () => {
    it('exposes the static rejection-stats API', () => {
      expect(typeof Scenario8_RangeDeviationReclaim.getRejectionStats).toBe('function');
      expect(typeof Scenario8_RangeDeviationReclaim.resetStats).toBe('function');
      expect(typeof Scenario8_RangeDeviationReclaim.prototype.evaluate).toBe('function');
    });

    it('clears stale levels between evaluations', () => {
      expect(scenario.evaluate(makePatternData())).toBe(true);
      expect(scenario.getLevels().entry.gt(0)).toBe(true);

      expect(scenario.evaluate(makePatternData({ zones: [] }))).toBe(false);
      expect(scenario.getLevels().entry.toString()).toBe('0');
      expect(scenario.getZoneDetails()).toBeNull();
      expect(scenario.getStructureDetails()).toBeNull();
    });
  });
});
