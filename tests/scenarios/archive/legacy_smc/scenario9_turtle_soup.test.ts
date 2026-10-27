import { Scenario9_TurtleSoup } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario9_TurtleSoup';
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

interface CandleOverrides {
  timestamp?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

const makeCandle = (overrides: CandleOverrides = {}): any => ({
  timestamp: overrides.timestamp ?? FIXED_NOW,
  open: overrides.open ?? '5000',
  high: overrides.high ?? '5006',
  low: overrides.low ?? '4998',
  close: overrides.close ?? '4999',
  volume: '1000',
});

interface PoolOverride {
  type: 'EQH' | 'EQL' | string;
  priceLevel: Decimal;
  isTaken?: boolean;
}

interface PatternOverrides {
  rangeHigh?: string;
  rangeLow?: string;
  candles?: any[];
  pools?: PoolOverride[];
  zones?: any[];
  sessionRanges?: any[];
  killzone?: string;
  atr?: Decimal;
  tradingRange?: any;
}

/**
 * Default fixture (bearish turtle soup at EQH):
 *   Range      : high 5002 / low 4940 (equilibrium 4971), ATR15m 0.1
 *   Stop pools : EQH 5002, EQL 4940
 *   SFP candle : open 5000, high 5006, low 4998, close 4999
 *                upper wick = 5006 - 5000 = 6 of 8 range = 75% >= 25%
 *                close 4999 is strictly inside (4940, 5002)
 */
const makePatternData = (overrides: PatternOverrides = {}): any => {
  const rangeHigh = new Decimal(overrides.rangeHigh ?? '5002');
  const rangeLow = new Decimal(overrides.rangeLow ?? '4940');

  return {
    currentKillzone: overrides.killzone ?? 'LONDON',
    currentSession: 'LONDON',
    candles15m: overrides.candles ?? [makeCandle()],
    tradingRange:
      overrides.tradingRange === undefined
        ? {
            high: rangeHigh,
            low: rangeLow,
            equilibrium: rangeHigh.plus(rangeLow).dividedBy(2),
            isDeviated: false,
          }
        : overrides.tradingRange,
    liquidityPools:
      overrides.pools ?? [
        { type: 'EQH', priceLevel: rangeHigh },
        { type: 'EQL', priceLevel: rangeLow },
      ],
    zones: overrides.zones ?? [],
    sessionRanges: overrides.sessionRanges ?? [],
    structures: [],
    atr15m: overrides.atr ?? new Decimal('0.1'),
  };
};

describe('Scenario9: Turtle Soup (Range SFP)', () => {
  let scenario: Scenario9_TurtleSoup;

  beforeEach(() => {
    Scenario9_TurtleSoup.resetStats();
    scenario = new Scenario9_TurtleSoup(mockConfig);
  });

  describe('ideal bearish turtle soup at EQH', () => {
    it('triggers on a range-high SFP that closes back inside', () => {
      const result = scenario.evaluate(makePatternData());

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Turtle Soup');
      expect(scenario.getReason()).toContain('Range High SFP');
      expect(scenario.getReason()).toContain('EQH');
    });

    it('enters on the SFP close and stops beyond the SFP wick', () => {
      scenario.evaluate(makePatternData());
      const levels = scenario.getLevels();

      // entry = SFP close
      expect(levels.entry.toString()).toBe('4999');
      // SL = candle high + max(0.5 * ATR, 0.1% of entry) = 5006 + 4.999
      expect(levels.stopLoss.toString()).toBe('5010.999');
      // fixed 3R fallback: 4999 - 3 * 11.999
      expect(levels.takeProfit.toString()).toBe('4963.003');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('emits a SWEEP structure anchor (never a CHoCH) and no zone details', () => {
      scenario.evaluate(makePatternData());

      const structure = scenario.getStructureDetails();
      expect(structure).not.toBeNull();
      expect(structure!.type).toBe('SWEEP');
      expect(structure!.direction).toBe('BEARISH');
      expect(structure!.timestamp).toBe(FIXED_NOW);
      expect(structure!.price!.toString()).toBe('5002');

      // Turtle soup enters at market on the SFP close; there is no entry zone.
      expect(scenario.getZoneDetails()).toBeNull();
    });
  });

  describe('ideal bullish turtle soup at EQL', () => {
    const bullishCandle = () =>
      makeCandle({ open: '4940', high: '4944', low: '4934', close: '4941' });

    it('triggers on a range-low SFP that closes back inside', () => {
      const result = scenario.evaluate(
        makePatternData({
          candles: [bullishCandle()],
          pools: [{ type: 'EQL', priceLevel: new Decimal('4940') }],
        }),
      );

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Turtle Soup (Long)');
      expect(scenario.getReason()).toContain('Range Low SFP');
      expect(scenario.getReason()).toContain('EQL');
    });

    it('mirrors the stop and target geometry around the entry', () => {
      scenario.evaluate(
        makePatternData({
          candles: [bullishCandle()],
          pools: [{ type: 'EQL', priceLevel: new Decimal('4940') }],
        }),
      );
      const levels = scenario.getLevels();

      expect(levels.entry.toString()).toBe('4941');
      // SL = candle low - max(0.05, 4.941) = 4934 - 4.941
      expect(levels.stopLoss.toString()).toBe('4929.059');
      // fixed 3R fallback: 4941 + 3 * 11.941
      expect(levels.takeProfit.toString()).toBe('4976.823');
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('reports a BULLISH sweep anchor at the range low', () => {
      scenario.evaluate(
        makePatternData({
          candles: [bullishCandle()],
          pools: [{ type: 'EQL', priceLevel: new Decimal('4940') }],
        }),
      );

      const structure = scenario.getStructureDetails();
      expect(structure!.type).toBe('SWEEP');
      expect(structure!.direction).toBe('BULLISH');
      expect(structure!.price!.toString()).toBe('4940');
    });

    it('does not trigger a long when only EQH is armed', () => {
      const result = scenario.evaluate(
        makePatternData({
          candles: [bullishCandle()],
          pools: [{ type: 'EQH', priceLevel: new Decimal('5002') }],
        }),
      );

      expect(result).toBe(false);
      // Only the short side is armed, so the range low is not a tradeable sweep.
      expect(scenario.getReason()).toContain('EQH turtle soup');
      expect(Scenario9_TurtleSoup.getRejectionStats().noSweep).toBe(1);
    });
  });

  describe('killzone gate', () => {
    it('rejects outside London/NY', () => {
      const result = scenario.evaluate(makePatternData({ killzone: 'ASIAN' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
      expect(Scenario9_TurtleSoup.getRejectionStats().killzone).toBe(1);
    });

    it('accepts NY', () => {
      const result = scenario.evaluate(makePatternData({ killzone: 'NY' }));
      expect(result).toBe(true);
    });

    it('is bypassed by ENFORCE_KILLZONES=false', () => {
      const loose = new Scenario9_TurtleSoup({ ...mockConfig, enforceKillzones: false });
      const result = loose.evaluate(makePatternData({ killzone: 'NONE' }));

      expect(result).toBe(true);
    });
  });

  describe('trading range gate', () => {
    it('rejects without a trading range', () => {
      const result = scenario.evaluate(makePatternData({ tradingRange: null }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid trading range');
      expect(Scenario9_TurtleSoup.getRejectionStats().noTradingRange).toBe(1);
    });

    it('rejects an inverted range (high <= low)', () => {
      const result = scenario.evaluate(makePatternData({ rangeHigh: '4940', rangeLow: '5002' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No valid trading range');
    });
  });

  describe('EQH/EQL gate', () => {
    it('rejects when no pool sits at either boundary', () => {
      const result = scenario.evaluate(makePatternData({ pools: [] }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('EQH/EQL liquidity');
      expect(Scenario9_TurtleSoup.getRejectionStats().noEqhEql).toBe(1);
    });

    it('rejects a cluster that sits outside the 0.1%/0.5-ATR tolerance', () => {
      // tolerance = max(5002 * 0.1% = 5.002, 0.5 * ATR 0.1 = 0.05) -> 5.002
      const result = scenario.evaluate(
        makePatternData({ pools: [{ type: 'EQH', priceLevel: new Decimal('5010') }] }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('EQH/EQL liquidity');
    });

    it('ignores an already-taken cluster', () => {
      const result = scenario.evaluate(
        makePatternData({
          pools: [{ type: 'EQH', priceLevel: new Decimal('5002'), isTaken: true }],
        }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('EQH/EQL liquidity');
    });
  });

  describe('sweep gate', () => {
    it('rejects when the wick never reaches the boundary', () => {
      const result = scenario.evaluate(
        makePatternData({ candles: [makeCandle({ high: '5001', low: '4998' })] }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('not swept');
      expect(Scenario9_TurtleSoup.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a boundary TOUCH that does not pierce it', () => {
      const result = scenario.evaluate(
        makePatternData({ candles: [makeCandle({ high: '5002', low: '4998' })] }),
      );

      expect(result).toBe(false);
      expect(Scenario9_TurtleSoup.getRejectionStats().noSweep).toBe(1);
    });

    it('requires the deeper EQH cluster to be taken when it sits above the boundary', () => {
      // EQH 5004 is within tolerance of the 5002 range high, so 5004 is the level
      // that actually holds the stops.
      const data = makePatternData({
        pools: [{ type: 'EQH', priceLevel: new Decimal('5004') }],
      });

      const shallow = scenario.evaluate({
        ...data,
        candles15m: [makeCandle({ high: '5003', low: '4998' })],
      });
      expect(shallow).toBe(false);
      expect(Scenario9_TurtleSoup.getRejectionStats().noSweep).toBe(1);

      const deep = scenario.evaluate({
        ...data,
        candles15m: [makeCandle({ high: '5005', low: '4998' })],
      });
      expect(deep).toBe(true);
      expect(scenario.getStructureDetails()!.price!.toString()).toBe('5004');
    });

    it('takes the highest cluster when several sit at the boundary', () => {
      const data = makePatternData({
        pools: [
          { type: 'EQH', priceLevel: new Decimal('5000') },
          { type: 'EQH', priceLevel: new Decimal('5002') },
        ],
      });

      const shallow = scenario.evaluate({
        ...data,
        candles15m: [makeCandle({ high: '5001', low: '4998' })],
      });
      expect(shallow).toBe(false);

      const deep = scenario.evaluate({
        ...data,
        candles15m: [makeCandle({ high: '5003', low: '4998' })],
      });
      expect(deep).toBe(true);
      expect(scenario.getStructureDetails()!.price!.toString()).toBe('5002');
    });

    it('only evaluates the candle that just closed', () => {
      // The SFP is historical; the last closed candle is quiet.
      const result = scenario.evaluate(
        makePatternData({
          candles: [
            makeCandle({ timestamp: FIXED_NOW - TF_MS }),
            makeCandle({ high: '5001', low: '4998' }),
          ],
        }),
      );

      expect(result).toBe(false);
      expect(Scenario9_TurtleSoup.getRejectionStats().noSweep).toBe(1);
    });
  });

  describe('body-close gate', () => {
    it('rejects a sweep that closes outside the range (breakout accepted)', () => {
      const result = scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '5000', high: '5006', low: '4998', close: '5003' })],
        }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('closed outside the range');
      expect(Scenario9_TurtleSoup.getRejectionStats().bodyClose).toBe(1);
    });

    it('rejects a close exactly on the boundary', () => {
      const result = scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '5000', high: '5006', low: '4998', close: '5002' })],
        }),
      );

      expect(result).toBe(false);
      expect(Scenario9_TurtleSoup.getRejectionStats().bodyClose).toBe(1);
    });
  });

  describe('rejection-wick gate', () => {
    it('rejects a sweep whose rejection wick is too small', () => {
      // upper wick = 5006 - 5005 = 1 of a 16-point range = 6.25% < 25%
      const result = scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '5005', high: '5006', low: '4990', close: '4999' })],
        }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('rejection wick');
      expect(Scenario9_TurtleSoup.getRejectionStats().weakWick).toBe(1);
    });

    it('accepts a wick exactly at the configured floor', () => {
      // upper wick = 5006 - 5000 = 6 of a 24-point range = exactly 25%
      const result = scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '5000', high: '5006', low: '4982', close: '4999' })],
        }),
      );

      expect(result).toBe(true);
    });
  });

  describe('two-sided sweep resolution', () => {
    it('trades the deeper penetration when one bar clears both boundaries', () => {
      // high penetrates 4 (5006 - 5002), low penetrates 25 (4940 - 4915) -> long
      const result = scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '4940', high: '5006', low: '4915', close: '4941' })],
        }),
      );

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getStructureDetails()!.direction).toBe('BULLISH');
      expect(scenario.getStructureDetails()!.price!.toString()).toBe('4940');
    });

    it('falls back to the shallower side when the deeper side cannot complete', () => {
      // Deeper side = long (10 vs 4), but the long rejection wick is only
      // 4945 - 4930 = 15 of 76 = 19.7% (< 25%); the short side still qualifies.
      const result = scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '4945', high: '5006', low: '4930', close: '4945' })],
        }),
      );

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getStructureDetails()!.direction).toBe('BEARISH');
    });
  });

  describe('structural take-profit', () => {
    it('targets the range equilibrium when dynamic TP is enabled', () => {
      const resolverScenario = new Scenario9_TurtleSoup(dynamicTpConfig);
      const result = resolverScenario.evaluate(makePatternData());

      if (!result) console.log('REJECTION:', resolverScenario.getReason());

      expect(result).toBe(true);
      expect(resolverScenario.getLevels().takeProfit.toString()).toBe('4971');
      expect(resolverScenario.getReason()).toContain('RANGE_EQUILIBRIUM');
    });

    it('targets the equilibrium from the long side as well', () => {
      const resolverScenario = new Scenario9_TurtleSoup(dynamicTpConfig);
      const result = resolverScenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '4940', high: '4944', low: '4934', close: '4941' })],
          pools: [{ type: 'EQL', priceLevel: new Decimal('4940') }],
        }),
      );

      expect(result).toBe(true);
      expect(resolverScenario.getLevels().takeProfit.toString()).toBe('4971');
      expect(resolverScenario.getReason()).toContain('RANGE_EQUILIBRIUM');
    });

    it('rejects the setup when the nearest obstacle leaves less than minRr', () => {
      const resolverScenario = new Scenario9_TurtleSoup(dynamicTpConfig);
      // A bullish 15m block just under the entry is a hard wall: 0.5 points of
      // room against 11.999 of risk is ~0.04R.
      const result = resolverScenario.evaluate(
        makePatternData({
          zones: [
            {
              type: 'OB',
              direction: 'BULLISH',
              top: new Decimal('4998.5'),
              bottom: new Decimal('4996'),
              timestamp: FIXED_NOW - TF_MS,
              mitigated: false,
              timeframe: '15',
            },
          ],
        }),
      );

      expect(result).toBe(false);
      expect(resolverScenario.getReason()).toContain('Take-profit rejected');
      expect(Scenario9_TurtleSoup.getRejectionStats().tpInvalid).toBe(1);
    });
  });

  describe('rejection stats', () => {
    it('counts every funnel stage independently', () => {
      Scenario9_TurtleSoup.resetStats();

      scenario.evaluate(makePatternData({ killzone: 'ASIAN' }));
      scenario.evaluate(makePatternData({ pools: [] }));
      scenario.evaluate(makePatternData({ candles: [makeCandle({ high: '5001' })] }));
      scenario.evaluate(makePatternData({ candles: [makeCandle({ close: '5003' })] }));
      scenario.evaluate(
        makePatternData({
          candles: [makeCandle({ open: '5005', high: '5006', low: '4990', close: '4999' })],
        }),
      );

      const stats = Scenario9_TurtleSoup.getRejectionStats();
      expect(stats.totalEvals).toBe(5);
      expect(stats.killzone).toBe(1);
      expect(stats.noEqhEql).toBe(1);
      expect(stats.noSweep).toBe(1);
      expect(stats.bodyClose).toBe(1);
      expect(stats.weakWick).toBe(1);
      expect(stats.tpInvalid).toBe(0);
    });

    it('resets to zero', () => {
      scenario.evaluate(makePatternData());
      Scenario9_TurtleSoup.resetStats();

      const stats = Scenario9_TurtleSoup.getRejectionStats();
      expect(stats.totalEvals).toBe(0);
      expect(stats.killzone).toBe(0);
      expect(stats.noTradingRange).toBe(0);
      expect(stats.noEqhEql).toBe(0);
      expect(stats.noSweep).toBe(0);
      expect(stats.bodyClose).toBe(0);
      expect(stats.weakWick).toBe(0);
      expect(stats.tpInvalid).toBe(0);
    });
  });

  describe('integration', () => {
    it('exposes the static rejection-stats API', () => {
      expect(typeof Scenario9_TurtleSoup.getRejectionStats).toBe('function');
      expect(typeof Scenario9_TurtleSoup.resetStats).toBe('function');
      expect(typeof Scenario9_TurtleSoup.prototype.evaluate).toBe('function');
    });

    it('clears stale levels between evaluations', () => {
      const first = scenario.evaluate(makePatternData());
      expect(first).toBe(true);
      expect(scenario.getLevels().entry.gt(0)).toBe(true);

      const second = scenario.evaluate(makePatternData({ pools: [] }));
      expect(second).toBe(false);
      expect(scenario.getLevels().entry.toString()).toBe('0');
      expect(scenario.getStructureDetails()).toBeNull();
    });
  });
});
