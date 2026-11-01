import { Scenario6_SMS } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario6_SMS';
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
  sweepVolumeMultiplier: new Decimal('1.5'),
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

/** OB candle, the SMS break, the confirming CHoCH, the last closed candle. */
const T_OB = FIXED_NOW;
const T_SMS = T_OB + TF_MS;
const T_CHOCH = T_SMS + TF_MS;
const T_LAST = T_CHOCH + TF_MS;

interface CandleOverrides {
  timestamp?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

const makeCandle = (overrides: CandleOverrides = {}): any => ({
  timestamp: overrides.timestamp ?? T_LAST,
  open: overrides.open ?? '4980',
  high: overrides.high ?? '4982',
  low: overrides.low ?? '4970',
  close: overrides.close ?? '4975',
  volume: '1000',
});

const makeOb = (overrides: Record<string, any> = {}): any => ({
  type: 'OB',
  direction: 'BULLISH',
  top: new Decimal('5005'),
  bottom: new Decimal('4985'),
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
  price: new Decimal('4980'),
  timestamp: T_CHOCH,
  isValidated: true,
  impulseFactor: new Decimal(2),
  timeframe: '15',
  ...overrides,
});

/**
 * Default fixture: bearish failure swing.
 *   OB      : BULLISH 15m 4985..5005 at T_OB (equilibrium 4995)
 *   SMS     : BEARISH at T_SMS (failed higher high @ 5020)
 *   CHoCH   : BEARISH 15m at T_CHOCH (close 4980, impulse 2 ATR)
 *   last    : T_LAST (close 4975)
 */
const makePatternData = (overrides: Record<string, any> = {}): any => ({
  currentKillzone: 'LONDON',
  currentSession: 'LONDON',
  candles15m: [
    makeCandle({ timestamp: T_OB, open: '4990', high: '5005', low: '4985', close: '5000' }),
    makeCandle({ timestamp: T_SMS, open: '5000', high: '5020', low: '4998', close: '5010' }),
    makeCandle({ timestamp: T_CHOCH, open: '5010', high: '5012', low: '4978', close: '4980' }),
    makeCandle({ timestamp: T_LAST, open: '4980', high: '4982', low: '4970', close: '4975' }),
  ],
  structures: [makeSms(), makeChoch()],
  zones: [makeOb()],
  liquidityPools: [],
  sessionRanges: [],
  tradingRange: null,
  atr15m: new Decimal('0.5'),
  ...overrides,
});

describe('Scenario6: Failure Swing (SMS)', () => {
  let scenario: Scenario6_SMS;

  beforeEach(() => {
    Scenario6_SMS.resetStats();
    scenario = new Scenario6_SMS(mockConfig);
  });

  describe('valid chain', () => {
    it('triggers on OB -> SMS -> CHoCH with 15m causality', () => {
      const patternData = makePatternData();

      expect(scenario.evaluate(patternData)).toBe(true);

      const levels = scenario.getLevels();
      // Entry = OB equilibrium, never the signal close.
      expect(levels.entry.eq(new Decimal('4995'))).toBe(true);
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('burns the SMS-forming OB and the confirming CHoCH', () => {
      const patternData = makePatternData();

      expect(scenario.evaluate(patternData)).toBe(true);

      const zone = scenario.getZoneDetails();
      expect(zone).not.toBeNull();
      expect(zone?.type).toBe('OB');
      expect(zone?.timeframe).toBe('15');
      expect(zone?.direction).toBe('BULLISH');
      expect(zone?.timestamp).toBe(T_OB);
      expect((zone?.top as Decimal).eq(new Decimal('5005'))).toBe(true);
      expect((zone?.bottom as Decimal).eq(new Decimal('4985'))).toBe(true);

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('CHoCH');
      expect(structure?.timestamp).toBe(T_CHOCH);
      expect(structure?.direction).toBe('BEARISH');
      expect(scenario.getReason()).toContain('Failure Swing');
    });

    it('selects by timestamp, not by array order (SMS entries are appended last)', () => {
      // `detectStructureBreaks()` appends SMS after the chronological BOS/CHoCH
      // pass, so a naive `reverse().find()` would see the SMS first.
      const patternData = makePatternData({ structures: [makeChoch(), makeSms()] });

      expect(scenario.evaluate(patternData)).toBe(true);
      expect(scenario.getStructureDetails()?.timestamp).toBe(T_CHOCH);
    });

    it('mirrors the chain for a bullish failure swing', () => {
      const bullishOb = makeOb({
        direction: 'BEARISH',
        top: new Decimal('5015'),
        bottom: new Decimal('4995'),
      });
      const patternData = makePatternData({
        structures: [
          makeSms({ direction: 'BULLISH', price: new Decimal('4980') }),
          makeChoch({ direction: 'BULLISH', price: new Decimal('5018') }),
        ],
        zones: [bullishOb],
      });

      expect(scenario.evaluate(patternData)).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.entry.eq(new Decimal('5005'))).toBe(true);
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
      expect(scenario.getStructureDetails()?.direction).toBe('BULLISH');
    });

    it('walks past a fresher SMS that has no valid chain', () => {
      // Newest SMS is BULLISH (needs a BEARISH block, none exists) -> noChoch.
      // The older BEARISH chain must still be found.
      const patternData = makePatternData({
        structures: [
          makeSms(),
          makeChoch(),
          makeSms({ direction: 'BULLISH', timestamp: T_CHOCH + 2 * TF_MS }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(true);
      expect(scenario.getStructureDetails()?.timestamp).toBe(T_CHOCH);
    });
  });

  describe('15m timeframe isolation', () => {
    it('rejects a 4H CHoCH', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ timeframe: '240' })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noChoch).toBe(1);
      expect(scenario.getReason()).toContain('No 15m BEARISH CHoCH');
    });

    it('rejects a 4H SMS', () => {
      const patternData = makePatternData({ structures: [makeSms({ timeframe: '240' }), makeChoch()] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noSms).toBe(1);
    });

    it('rejects a 4H SMS-forming OB', () => {
      const patternData = makePatternData({ zones: [makeOb({ timeframe: '240' })] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noOb).toBe(1);
    });
  });

  describe('causality', () => {
    it('rejects an OB that formed after the SMS', () => {
      const patternData = makePatternData({ zones: [makeOb({ timestamp: T_SMS + TF_MS })] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noOb).toBe(1);
      expect(scenario.getReason()).toContain('OB of the failed leg');
    });

    it('rejects a CHoCH that printed before the SMS', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ timestamp: T_SMS - TF_MS })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noChoch).toBe(1);
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
      expect(Scenario6_SMS.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects an OB that is older than the 72h looking window before the CHoCH', () => {
      // 40h before the SMS (inside the window) but 79h before the CHoCH (outside).
      const patternData = makePatternData({
        zones: [makeOb({ timestamp: T_LAST - 80 * HOUR_MS })],
        structures: [
          makeSms({ timestamp: T_LAST - 40 * HOUR_MS }),
          makeChoch({ timestamp: T_LAST - 1 * HOUR_MS }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noOb).toBe(1);
    });

    it('rejects a chain whose trigger is older than the looking window', () => {
      const patternData = makePatternData({
        zones: [makeOb({ timestamp: T_LAST - 100 * HOUR_MS })],
        structures: [
          makeSms({ timestamp: T_LAST - 80 * HOUR_MS }),
          makeChoch({ timestamp: T_LAST - 76 * HOUR_MS }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().noChoch).toBe(1);
    });
  });

  describe('displacement', () => {
    it('rejects a confirming CHoCH below 1.5 ATR', () => {
      const patternData = makePatternData({
        structures: [makeSms(), makeChoch({ impulseFactor: new Decimal('1.0') })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().displacement).toBe(1);
    });
  });

  describe('stop geometry', () => {
    it('widens the stop zone with the trigger and last-closed wicks', () => {
      // CHoCH high 5012 > OB top 5005 -> the stop must sit above the CHoCH wick.
      const patternData = makePatternData();

      expect(scenario.evaluate(patternData)).toBe(true);

      const levels = scenario.getLevels();
      const offset = Decimal.max(
        new Decimal('0.5').mul(new Decimal('0.5')),
        new Decimal('4995').mul(new Decimal('0.001')),
      );
      expect(levels.stopLoss.eq(new Decimal('5012').plus(offset))).toBe(true);
    });
  });

  describe('dynamic take-profit', () => {
    it('rejects when the nearest opposing zone leaves less than the R floor', () => {
      const dynamicScenario = new Scenario6_SMS(dynamicTpConfig);
      const patternData = makePatternData({
        zones: [
          makeOb(),
          // BULLISH demand just below entry: the nearest obstacle for a short.
          makeOb({ top: new Decimal('4993'), bottom: new Decimal('4988'), timestamp: T_LAST }),
        ],
      });

      expect(dynamicScenario.evaluate(patternData)).toBe(false);
      expect(Scenario6_SMS.getRejectionStats().tpInvalid).toBe(1);
      expect(dynamicScenario.getReason()).toContain('Take-profit rejected');
    });

    it('targets the nearest structural obstacle that clears the R floor', () => {
      const dynamicScenario = new Scenario6_SMS(dynamicTpConfig);
      const patternData = makePatternData({
        zones: [
          makeOb(),
          makeOb({ top: new Decimal('4950'), bottom: new Decimal('4940'), timestamp: T_LAST }),
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
      expect(Scenario6_SMS.getRejectionStats().killzone).toBe(1);
      expect(scenario.getReason()).toContain('killzone');
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypassScenario = new Scenario6_SMS({ ...mockConfig, enforceKillzones: false });
      const patternData = makePatternData({ currentKillzone: 'NONE' });

      expect(bypassScenario.evaluate(patternData)).toBe(true);
    });

    it('reaches the data gate outside the killzone when the bypass is on', () => {
      const bypassScenario = new Scenario6_SMS({ ...mockConfig, enforceKillzones: false });
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
