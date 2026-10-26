import { Scenario11_MitigationBlock } from '../../src/engine/scenarios/Scenario11_MitigationBlock';
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
const HOUR_MS = 60 * 60 * 1000;

/** Failed-swing block, the SMS break, the confirming CHoCH, the retest. */
const T_OB = FIXED_NOW;
const T_SMS = T_OB + TF_MS;
const T_CHOCH = T_SMS + TF_MS;
const T_RETEST = T_CHOCH + TF_MS;

interface CandleOverrides {
  timestamp?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

const makeCandle = (overrides: CandleOverrides = {}): any => ({
  timestamp: overrides.timestamp ?? T_RETEST,
  open: overrides.open ?? '5003',
  high: overrides.high ?? '5006',
  low: overrides.low ?? '4996',
  close: overrides.close ?? '5000',
  volume: '1000',
});

const makeOb = (overrides: Record<string, any> = {}): any => ({
  type: 'OB',
  // Demand block of the failed up-leg (bearish SMS) — the mitigation short entry.
  direction: 'BULLISH',
  top: new Decimal('5005'),
  bottom: new Decimal('4995'),
  timestamp: T_OB,
  mitigated: false,
  timeframe: '15',
  ...overrides,
});

const makeSms = (overrides: Record<string, any> = {}): any => ({
  type: 'SMS',
  direction: 'BEARISH',
  price: new Decimal('5020'),
  timestamp: T_SMS,
  isValidated: true,
  impulseFactor: new Decimal(2),
  timeframe: '15',
  ...overrides,
});

const makeChoch = (overrides: Record<string, any> = {}): any => ({
  type: 'CHOCH',
  direction: 'BEARISH',
  price: new Decimal('4960'),
  timestamp: T_CHOCH,
  isValidated: true,
  impulseFactor: new Decimal(2),
  timeframe: '15',
  ...overrides,
});

/**
 * Candle series ending at `retestTimestamp`.
 *
 * Candles at or after the retest timestamp are dropped so `retestTimestamp ===
 * T_CHOCH` produces a series whose LAST candle is the CHoCH candle — the
 * "entry on the confirmation candle itself" case.
 */
const makeCandles = (
  retestTimestamp: number = T_RETEST,
  retest: CandleOverrides = {},
): any[] => {
  const earlier = [
    makeCandle({ timestamp: T_OB, open: '5010', high: '5015', low: '4995', close: '5000' }),
    makeCandle({ timestamp: T_SMS, open: '5010', high: '5020', low: '5005', close: '5012' }),
    makeCandle({ timestamp: T_CHOCH, open: '5000', high: '5003', low: '4958', close: '4960' }),
  ].filter((candle) => candle.timestamp < retestTimestamp);

  return [...earlier, makeCandle({ timestamp: retestTimestamp, ...retest })];
};

/**
 * Default fixture: bearish failure swing mitigated at a demand block.
 *   MB      : BULLISH 15m 4995..5005 at T_OB
 *   SMS     : BEARISH at T_SMS (failed higher high @ 5020)
 *   CHoCH   : BEARISH 15m at T_CHOCH (close/price 4960, impulse 2 ATR)
 *   retest  : T_RETEST — open 5003, high 5006, low 4996, close 5000
 *   impulse : 4960..5020 -> equilibrium 4990; entry 5000 is PREMIUM (short ok)
 */
const makePatternData = (overrides: Record<string, any> = {}): any => ({
  currentKillzone: 'LONDON',
  currentSession: 'LONDON',
  candles15m: makeCandles(),
  structures: [makeSms(), makeChoch()],
  zones: [makeOb()],
  liquidityPools: [],
  sessionRanges: [],
  tradingRange: null,
  atr15m: new Decimal('0.5'),
  ...overrides,
});

describe('Scenario11: Mitigation Block', () => {
  let scenario: Scenario11_MitigationBlock;

  beforeEach(() => {
    Scenario11_MitigationBlock.resetStats();
    scenario = new Scenario11_MitigationBlock(mockConfig);
  });

  describe('valid chain', () => {
    it('triggers on MB -> SMS -> CHoCH with a 15m retest', () => {
      expect(scenario.evaluate(makePatternData())).toBe(true);

      const levels = scenario.getLevels();
      // Entry is the retest close (documented S11 behaviour), never the block mid.
      expect(levels.entry.eq(new Decimal('5000'))).toBe(true);
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Block');
    });

    it('burns the mitigation block and the confirming CHoCH', () => {
      expect(scenario.evaluate(makePatternData())).toBe(true);

      const zone = scenario.getZoneDetails();
      expect(zone).not.toBeNull();
      expect(zone?.type).toBe('OB');
      expect(zone?.timeframe).toBe('15');
      expect(zone?.direction).toBe('BULLISH');
      expect(zone?.timestamp).toBe(T_OB);
      expect((zone?.top as Decimal).eq(new Decimal('5005'))).toBe(true);
      expect((zone?.bottom as Decimal).eq(new Decimal('4995'))).toBe(true);

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('CHoCH');
      expect(structure?.timestamp).toBe(T_CHOCH);
      expect(structure?.direction).toBe('BEARISH');
    });

    it('selects by timestamp, not by array order (SMS entries are appended last)', () => {
      // `detectStructureBreaks()` appends SMS after the chronological pass, so a
      // naive `reverse().find()` would see the SMS before the CHoCH.
      const patternData = makePatternData({ structures: [makeChoch(), makeSms()] });

      expect(scenario.evaluate(patternData)).toBe(true);
      expect(scenario.getStructureDetails()?.timestamp).toBe(T_CHOCH);
    });

    it('mirrors the chain for a bullish failure swing', () => {
      // Bullish SMS = failed lower low at 4960, CHoCH up to 5020, equilibrium 4990.
      // The supply block of the failed down-leg sits at 4970..4980 (discount).
      const patternData = makePatternData({
        structures: [
          makeSms({ direction: 'BULLISH', price: new Decimal('4960') }),
          makeChoch({ direction: 'BULLISH', price: new Decimal('5020') }),
        ],
        zones: [
          makeOb({
            direction: 'BEARISH',
            top: new Decimal('4980'),
            bottom: new Decimal('4970'),
          }),
        ],
        candles15m: makeCandles(T_RETEST, {
          open: '4972',
          high: '4978',
          low: '4968',
          close: '4976',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.entry.eq(new Decimal('4976'))).toBe(true);
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
      expect(scenario.getStructureDetails()?.direction).toBe('BULLISH');
    });

    it('walks past a fresher SMS that has no valid chain', () => {
      // Newest SMS is BEARISH but prints on the retest candle, so no CHoCH can
      // confirm it. The older chain must still be found.
      const patternData = makePatternData({
        structures: [
          makeSms(),
          makeChoch(),
          makeSms({ direction: 'BEARISH', timestamp: T_RETEST }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(true);
      expect(scenario.getStructureDetails()?.timestamp).toBe(T_CHOCH);
    });
  });

  describe('15m timeframe isolation', () => {
    it('rejects a 4H SMS', () => {
      const patternData = makePatternData({
        structures: [makeSms({ timeframe: '240' }), makeChoch()],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noSms).toBe(1);
    });

    it('rejects a 4H CHoCH', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ timeframe: '240' })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noChoch).toBe(1);
      expect(scenario.getReason()).toContain('No 15m BEARISH CHoCH');
    });

    it('rejects a 4H mitigation block', () => {
      const patternData = makePatternData({ zones: [makeOb({ timeframe: '240' })] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noMitigationBlock).toBe(1);
    });
  });

  describe('causality', () => {
    it('rejects a mitigation block that formed after the SMS', () => {
      const patternData = makePatternData({ zones: [makeOb({ timestamp: T_SMS + TF_MS })] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noMitigationBlock).toBe(1);
      expect(scenario.getReason()).toContain('OB of the failed leg');
    });

    it('rejects a CHoCH that printed before the SMS', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ timestamp: T_SMS - TF_MS })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noChoch).toBe(1);
    });

    it('accepts a CHoCH on the same candle as the SMS break', () => {
      // `detectSMS()` stamps the SMS with the break candle, so equality is the
      // normal same-bar case, not a causality violation.
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ timestamp: T_SMS })],
      });

      expect(scenario.evaluate(patternData)).toBe(true);
    });

    it('rejects a CHoCH in the wrong direction', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ direction: 'BULLISH' })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects a CHoCH that arrives later than 8h after the SMS', () => {
      const lateChoch = T_SMS + 9 * HOUR_MS;
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ timestamp: lateChoch })],
        candles15m: makeCandles(lateChoch + TF_MS),
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noChoch).toBe(1);
      expect(scenario.getReason()).toContain('within 8h');
    });

    it('rejects a chain whose block is older than the 72h looking window', () => {
      const patternData = makePatternData({
        zones: [makeOb({ timestamp: T_SMS - 73 * HOUR_MS })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noMitigationBlock).toBe(1);
    });
  });

  describe('displacement', () => {
    it('rejects a confirming CHoCH below 1.5 ATR', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ impulseFactor: new Decimal('1.0') })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().displacement).toBe(1);
    });
  });

  describe('retest', () => {
    it('rejects an entry attempt on the CHoCH candle itself', () => {
      const patternData = makePatternData({ candles15m: makeCandles(T_CHOCH) });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noRetest).toBe(1);
      expect(scenario.getReason()).toContain('AFTER the CHoCH');
    });

    it('rejects a mitigation that arrives later than 12h after the CHoCH', () => {
      const late = T_CHOCH + 13 * HOUR_MS;
      const patternData = makePatternData({ candles15m: makeCandles(late) });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noRetest).toBe(1);
      expect(scenario.getReason()).toContain('later than 12h');
    });

    it('rejects a candle that never traded into the mitigation block', () => {
      const patternData = makePatternData({
        zones: [makeOb({ top: new Decimal('4990'), bottom: new Decimal('4980') })],
        candles15m: makeCandles(T_RETEST, {
          open: '5003',
          high: '5006',
          low: '4995',
          close: '5000',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noRetest).toBe(1);
      expect(scenario.getReason()).toContain('mitigation block');
    });

    it('rejects a retest candle that closes outside the mitigation block', () => {
      const patternData = makePatternData({
        candles15m: makeCandles(T_RETEST, {
          open: '5010',
          high: '5012',
          low: '4996',
          close: '5008',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noRetest).toBe(1);
    });

    it('rejects a retest candle that closes against the trade direction', () => {
      // Bullish body for a short — mitigation must reject, not absorb.
      const patternData = makePatternData({
        candles15m: makeCandles(T_RETEST, {
          open: '4996',
          high: '5006',
          low: '4994',
          close: '5002',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().noRetest).toBe(1);
    });
  });

  describe('premium / discount', () => {
    it('rejects a short entry below the SMS->CHoCH equilibrium', () => {
      // Impulse 4960..5020 -> equilibrium 4990. Entry 4988 is DISCOUNT.
      const patternData = makePatternData({
        zones: [makeOb({ top: new Decimal('4995'), bottom: new Decimal('4985') })],
        candles15m: makeCandles(T_RETEST, {
          open: '4990',
          high: '4992',
          low: '4986',
          close: '4988',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().premiumDiscount).toBe(1);
      expect(scenario.getReason()).toContain('Premium');
    });

    it('rejects a long entry above the SMS->CHoCH equilibrium', () => {
      // Impulse 4960..5020 -> equilibrium 4990. Entry 4996 is PREMIUM.
      const patternData = makePatternData({
        structures: [
          makeSms({ direction: 'BULLISH', price: new Decimal('4960') }),
          makeChoch({ direction: 'BULLISH', price: new Decimal('5020') }),
        ],
        zones: [
          makeOb({
            direction: 'BEARISH',
            top: new Decimal('5000'),
            bottom: new Decimal('4992'),
          }),
        ],
        candles15m: makeCandles(T_RETEST, {
          open: '4992',
          high: '4998',
          low: '4990',
          close: '4996',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().premiumDiscount).toBe(1);
      expect(scenario.getReason()).toContain('Discount');
    });
  });

  describe('stop geometry', () => {
    it('widens the stop zone with the retest wick', () => {
      // Retest high 5006 > block top 5005 -> the stop must sit above that wick.
      expect(scenario.evaluate(makePatternData())).toBe(true);

      const offset = Decimal.max(
        new Decimal('0.5').mul(new Decimal('0.5')),
        new Decimal('5000').mul(new Decimal('0.001')),
      );
      expect(scenario.getLevels().stopLoss.eq(new Decimal('5006').plus(offset))).toBe(true);
    });

    it('keeps the block edge when the retest wick stays inside it', () => {
      const patternData = makePatternData({
        candles15m: makeCandles(T_RETEST, {
          open: '5003',
          high: '5004',
          low: '4996',
          close: '5000',
        }),
      });

      expect(scenario.evaluate(patternData)).toBe(true);

      const offset = Decimal.max(
        new Decimal('0.5').mul(new Decimal('0.5')),
        new Decimal('5000').mul(new Decimal('0.001')),
      );
      expect(scenario.getLevels().stopLoss.eq(new Decimal('5005').plus(offset))).toBe(true);
    });
  });

  describe('dynamic take-profit', () => {
    it('rejects when the nearest opposing zone leaves less than the R floor', () => {
      const dynamicScenario = new Scenario11_MitigationBlock(dynamicTpConfig);
      const patternData = makePatternData({
        zones: [
          makeOb(),
          // Demand just below entry: the nearest obstacle for a short.
          makeOb({ top: new Decimal('4993'), bottom: new Decimal('4988'), timestamp: T_RETEST }),
        ],
      });

      expect(dynamicScenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().tpInvalid).toBe(1);
      expect(dynamicScenario.getReason()).toContain('Take-profit rejected');
    });

    it('targets the nearest structural obstacle that clears the R floor', () => {
      const dynamicScenario = new Scenario11_MitigationBlock(dynamicTpConfig);
      const patternData = makePatternData({
        zones: [
          makeOb(),
          makeOb({ top: new Decimal('4950'), bottom: new Decimal('4940'), timestamp: T_RETEST }),
        ],
      });

      expect(dynamicScenario.evaluate(patternData)).toBe(true);
      expect(dynamicScenario.getLevels().takeProfit.eq(new Decimal('4950'))).toBe(true);
      expect(dynamicScenario.getReason()).toContain('LTF_ZONE');
    });
  });

  describe('killzone', () => {
    it('rejects outside the killzone when enforcement is enabled', () => {
      const patternData = makePatternData({ currentKillzone: 'NONE' });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario11_MitigationBlock.getRejectionStats().killzone).toBe(1);
      expect(scenario.getReason()).toContain('killzone');
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypassScenario = new Scenario11_MitigationBlock({
        ...mockConfig,
        enforceKillzones: false,
      });

      expect(bypassScenario.evaluate(makePatternData({ currentKillzone: 'NONE' }))).toBe(true);
    });

    it('reaches the data gate outside the killzone when the bypass is on', () => {
      const bypassScenario = new Scenario11_MitigationBlock({
        ...mockConfig,
        enforceKillzones: false,
      });
      const result = bypassScenario.evaluate({
        currentKillzone: 'NONE',
        candles15m: [],
        structures: [],
        zones: [],
      });

      expect(result).toBe(false);
      expect(bypassScenario.getReason()).not.toContain('killzone');
      expect(bypassScenario.getReason()).toContain('Missing 15m');
    });
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(97);
      const zone = { top: new Decimal(99), bottom: new Decimal(97), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);

      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(102.5);
      const zone = { top: new Decimal(103), bottom: new Decimal(102), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);

      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(97);
      const zone = { top: new Decimal(97), bottom: new Decimal(99), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr);

      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(102.5);
      const zone = { top: new Decimal(101), bottom: new Decimal(103), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr);

      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});
