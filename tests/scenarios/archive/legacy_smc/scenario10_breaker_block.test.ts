import { Scenario10_BreakerBlock } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario10_BreakerBlock';
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

// Uniform 15m spacing on purpose: `resolveCandleMs()` returns the FIRST positive
// delta it finds from the tail of the series, so a single 30m hole would double
// every candle-count window (including the FVG completion window).
const T_OB = FIXED_NOW;
const T_GRAB = T_OB + TF_MS;
const T_BREAK = T_OB + 2 * TF_MS;
const T_RETEST = T_BREAK + TF_MS;

interface CandleOverrides {
  timestamp?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

const makeCandle = (overrides: CandleOverrides = {}): any => ({
  timestamp: overrides.timestamp ?? T_RETEST,
  open: overrides.open ?? '5018',
  high: overrides.high ?? '5020',
  low: overrides.low ?? '5005',
  close: overrides.close ?? '5015',
  volume: '1000',
});

const makeOb = (overrides: Record<string, any> = {}): any => ({
  type: 'OB',
  // Supply block above: broken by the bullish BOS, traded back as support.
  direction: 'BEARISH',
  top: new Decimal('5010'),
  bottom: new Decimal('5000'),
  timestamp: T_OB,
  mitigated: false,
  timeframe: '15',
  ...overrides,
});

const makeBos = (overrides: Record<string, any> = {}): any => ({
  type: 'BOS',
  direction: 'BULLISH',
  price: new Decimal('5030'),
  timestamp: T_BREAK,
  isValidated: true,
  impulseFactor: new Decimal(2),
  timeframe: '15',
  ...overrides,
});

const makeFvg = (overrides: Record<string, any> = {}): any => ({
  type: 'FVG',
  direction: 'BULLISH',
  top: new Decimal('5020'),
  bottom: new Decimal('5014'),
  // `detectFVGs()` stamps `c1`; the gap completes 2 candles later (= T_BREAK).
  timestamp: T_BREAK - 2 * TF_MS,
  mitigated: false,
  timeframe: '15',
  ...overrides,
});

/**
 * Default fixture: bullish breaker.
 *   OB      : BEARISH 15m 5000..5010 at T_OB
 *   grab    : wick 5012 above the block top, close 5005 back below it
 *   BOS     : BULLISH 15m at T_BREAK (close 5030, impulse 2 ATR)
 *   FVG     : BULLISH, completing on the break candle
 *   retest  : T_RETEST (low 5005 into the block, close 5015 above it)
 */
const makePatternData = (overrides: Record<string, any> = {}): any => ({
  currentKillzone: 'LONDON',
  currentSession: 'LONDON',
  candles15m: [
    makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
    makeCandle({ timestamp: T_GRAB, open: '5008', high: '5012', low: '5001', close: '5005' }),
    makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
    makeCandle({ timestamp: T_RETEST, open: '5018', high: '5020', low: '5005', close: '5015' }),
  ],
  structures: [makeBos()],
  zones: [makeOb(), makeFvg()],
  liquidityPools: [],
  sessionRanges: [],
  tradingRange: null,
  atr15m: new Decimal('0.5'),
  ...overrides,
});

describe('Scenario10: Breaker Block Entry', () => {
  let scenario: Scenario10_BreakerBlock;

  beforeEach(() => {
    Scenario10_BreakerBlock.resetStats();
    scenario = new Scenario10_BreakerBlock(mockConfig);
  });

  describe('valid breaker', () => {
    it('triggers on a swept block broken by a 15m BOS and retested', () => {
      expect(scenario.evaluate(makePatternData())).toBe(true);

      const levels = scenario.getLevels();
      // Entry = breaker equilibrium.
      expect(levels.entry.eq(new Decimal('5005'))).toBe(true);
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
      expect(scenario.getReason()).toContain('Breaker Block');
    });

    it('burns the original block and the BOS that broke it', () => {
      expect(scenario.evaluate(makePatternData())).toBe(true);

      const zone = scenario.getZoneDetails();
      expect(zone?.type).toBe('OB');
      expect(zone?.timeframe).toBe('15');
      expect(zone?.direction).toBe('BEARISH');
      expect(zone?.timestamp).toBe(T_OB);

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('BOS');
      expect(structure?.timestamp).toBe(T_BREAK);
      expect(structure?.direction).toBe('BULLISH');
    });

    it('widens the stop with the retest wick', () => {
      // Retest low 5005 is inside the block (bottom 5000), so the block edge wins.
      expect(scenario.evaluate(makePatternData())).toBe(true);

      const offset = Decimal.max(
        new Decimal('0.5').mul(new Decimal('0.5')),
        new Decimal('5005').mul(new Decimal('0.001')),
      );
      expect(scenario.getLevels().stopLoss.eq(new Decimal('5000').minus(offset))).toBe(true);
    });

    it('mirrors the breaker for a bearish break of a demand block', () => {
      const patternData = makePatternData({
        structures: [makeBos({ direction: 'BEARISH', price: new Decimal('4970') })],
        zones: [
          makeOb({ direction: 'BULLISH', top: new Decimal('5000'), bottom: new Decimal('4990') }),
          makeFvg({ direction: 'BEARISH' }),
        ],
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '4998', high: '5000', low: '4990', close: '4992' }),
          makeCandle({ timestamp: T_GRAB, open: '4992', high: '4993', low: '4988', close: '4992' }),
          makeCandle({ timestamp: T_BREAK, open: '4990', high: '4992', low: '4968', close: '4970' }),
          makeCandle({ timestamp: T_RETEST, open: '4980', high: '4992', low: '4978', close: '4985' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.entry.eq(new Decimal('4995'))).toBe(true);
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
      expect(scenario.getStructureDetails()?.direction).toBe('BEARISH');
    });
  });

  describe('15m timeframe isolation', () => {
    it('rejects a 4H BOS as the break event', () => {
      const patternData = makePatternData({ structures: [makeBos({ timeframe: '240' })] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noBreak).toBe(1);
    });

    it('rejects a 4H block as the broken OB', () => {
      const patternData = makePatternData({ zones: [makeOb({ timeframe: '240' }), makeFvg()] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noBrokenOb).toBe(1);
    });

    it('rejects a 4H FVG as displacement confirmation', () => {
      const patternData = makePatternData({
        zones: [makeOb(), makeFvg({ timeframe: '240' })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noFvg).toBe(1);
    });
  });

  describe('causality', () => {
    it('rejects a block that formed after the break', () => {
      const patternData = makePatternData({
        zones: [makeOb({ timestamp: T_BREAK + TF_MS }), makeFvg()],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noBrokenOb).toBe(1);
      expect(scenario.getReason()).toContain('formed strictly before the break');
    });

    it('rejects a break that only cleared the block near edge', () => {
      // Close 5008 is inside 5000..5010: the block was mitigated, not broken.
      const patternData = makePatternData({
        structures: [makeBos({ price: new Decimal('5008') })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noBrokenOb).toBe(1);
    });

    it('rejects a block older than 24h before the break', () => {
      const patternData = makePatternData({
        zones: [makeOb({ timestamp: T_BREAK - 25 * HOUR_MS }), makeFvg()],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().obNotFresh).toBe(1);
    });
  });

  describe('break validation', () => {
    it('rejects a wick-only break without a body close', () => {
      const patternData = makePatternData({
        structures: [makeBos({ isValidated: false })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().bodyClose).toBe(1);
    });

    it('rejects a break below 1.5 ATR displacement', () => {
      const patternData = makePatternData({
        structures: [makeBos({ impulseFactor: new Decimal('1.0') })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().displacement).toBe(1);
    });
  });

  describe('liquidity grab', () => {
    it('rejects a block whose extreme was never swept and rejected', () => {
      const patternData = makePatternData({
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
          // No wick above 5010 before the break.
          makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
          makeCandle({ timestamp: T_RETEST, open: '5018', high: '5020', low: '5005', close: '5015' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noLiquiditySweep).toBe(1);
    });

    it('rejects a grab that closed beyond the extreme (acceptance, not a sweep)', () => {
      const patternData = makePatternData({
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
          // Wick above 5010 but the body HOLDS above it -> breakout, not a grab.
          makeCandle({ timestamp: T_GRAB, open: '5011', high: '5016', low: '5009', close: '5014' }),
          makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
          makeCandle({ timestamp: T_RETEST, open: '5018', high: '5020', low: '5005', close: '5015' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noLiquiditySweep).toBe(1);
    });
  });

  describe('displacement FVG', () => {
    it('rejects when no displacement gap printed at the break', () => {
      const patternData = makePatternData({ zones: [makeOb()] });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noFvg).toBe(1);
    });

    it('rejects a gap whose completion bar is outside the break window', () => {
      const patternData = makePatternData({
        zones: [makeOb(), makeFvg({ timestamp: T_BREAK - 4 * TF_MS })],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noFvg).toBe(1);
    });

    it('accepts a gap that completes one candle after the break', () => {
      const patternData = makePatternData({
        zones: [makeOb(), makeFvg({ timestamp: T_BREAK - TF_MS })],
      });

      expect(scenario.evaluate(patternData)).toBe(true);
    });
  });

  describe('retest', () => {
    it('rejects an entry attempt on the break candle itself', () => {
      const patternData = makePatternData({
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
          makeCandle({ timestamp: T_GRAB, open: '5008', high: '5012', low: '5001', close: '5005' }),
          makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noRetest).toBe(1);
      expect(scenario.getReason()).toContain('AFTER the break');
    });

    it('rejects a retest later than 4h after the break', () => {
      const late = T_BREAK + 5 * HOUR_MS;
      const patternData = makePatternData({
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
          makeCandle({ timestamp: T_GRAB, open: '5008', high: '5012', low: '5001', close: '5005' }),
          makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
          makeCandle({ timestamp: late, open: '5018', high: '5020', low: '5005', close: '5015' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noRetest).toBe(1);
      expect(scenario.getReason()).toContain('expired');
    });

    it('rejects a candle that never traded into the mirrored breaker zone', () => {
      // Low 5012 stays above the block top 5010: nothing was retested.
      const patternData = makePatternData({
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
          makeCandle({ timestamp: T_GRAB, open: '5008', high: '5012', low: '5001', close: '5005' }),
          makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
          makeCandle({ timestamp: T_RETEST, open: '5018', high: '5020', low: '5012', close: '5015' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noRetest).toBe(1);
    });

    it('rejects a retest that closes back through the block', () => {
      // Close 4998 is below the block bottom 5000: the break failed.
      const patternData = makePatternData({
        candles15m: [
          makeCandle({ timestamp: T_OB, open: '5002', high: '5010', low: '5000', close: '5008' }),
          makeCandle({ timestamp: T_GRAB, open: '5008', high: '5012', low: '5001', close: '5005' }),
          makeCandle({ timestamp: T_BREAK, open: '5010', high: '5032', low: '5008', close: '5030' }),
          makeCandle({ timestamp: T_RETEST, open: '5010', high: '5012', low: '4996', close: '4998' }),
        ],
      });

      expect(scenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().noRetest).toBe(1);
    });
  });

  describe('dynamic take-profit', () => {
    it('rejects when the nearest opposing zone leaves less than the R floor', () => {
      const dynamicScenario = new Scenario10_BreakerBlock(dynamicTpConfig);
      const patternData = makePatternData({
        zones: [
          makeOb(),
          makeFvg(),
          // Supply just above entry: the nearest obstacle for a long.
          makeOb({ top: new Decimal('5015'), bottom: new Decimal('5010'), timestamp: T_RETEST }),
        ],
      });

      expect(dynamicScenario.evaluate(patternData)).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().tpInvalid).toBe(1);
      expect(dynamicScenario.getReason()).toContain('Take-profit rejected');
    });

    it('targets the nearest structural obstacle that clears the R floor', () => {
      const dynamicScenario = new Scenario10_BreakerBlock(dynamicTpConfig);
      const patternData = makePatternData({
        zones: [
          makeOb(),
          makeFvg(),
          makeOb({ top: new Decimal('5040'), bottom: new Decimal('5035'), timestamp: T_RETEST }),
        ],
      });

      expect(dynamicScenario.evaluate(patternData)).toBe(true);
      expect(dynamicScenario.getLevels().takeProfit.eq(new Decimal('5035'))).toBe(true);
      expect(dynamicScenario.getReason()).toContain('LTF_ZONE');
    });
  });

  describe('killzone', () => {
    it('rejects outside the killzone when enforcement is enabled', () => {
      expect(scenario.evaluate(makePatternData({ currentKillzone: 'NONE' }))).toBe(false);
      expect(Scenario10_BreakerBlock.getRejectionStats().killzone).toBe(1);
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypassScenario = new Scenario10_BreakerBlock({
        ...mockConfig,
        enforceKillzones: false,
      });

      expect(bypassScenario.evaluate(makePatternData({ currentKillzone: 'NONE' }))).toBe(true);
    });
  });

  describe('getLevels() geometry checks', () => {
    it('should return SL < Entry < TP for BULLISH (Long) setup', () => {
      const entry = new Decimal(103.5);
      const zone = { top: new Decimal(107), bottom: new Decimal(105), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr, new Decimal(2));

      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('should return SL > Entry > TP for BEARISH (Short) setup', () => {
      const entry = new Decimal(96.5);
      const zone = { top: new Decimal(96), bottom: new Decimal(94), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr, new Decimal(2));

      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Long', () => {
      const entry = new Decimal(103.5);
      const zone = { top: new Decimal(105), bottom: new Decimal(107), direction: 'BULLISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BULLISH', atr, new Decimal(2));

      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('should handle inverted zone (top < bottom) correctly for Short', () => {
      const entry = new Decimal(96.5);
      const zone = { top: new Decimal(94), bottom: new Decimal(96), direction: 'BEARISH' as const };
      const atr = new Decimal('0.5');

      const levels = scenario.calculateLevels(entry, zone, 'BEARISH', atr, new Decimal(2));

      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});
