import { Scenario7_AMD } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario7_AMD';
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
/** Asian coil finished well before the fixture candles. */
const ASIAN_END = FIXED_NOW - 12 * 60 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

const tsAt = (index: number, length: number): number => FIXED_NOW - (length - 1 - index) * TF_MS;

const baseCandles = (length: number): any[] => {
  const candles: any[] = [];
  for (let i = 0; i < length; i++) {
    candles.push({
      timestamp: tsAt(i, length),
      open: '100',
      high: '101',
      low: '100.5',
      close: '100',
      volume: '1000',
    });
  }
  return candles;
};

interface SweepOverride {
  index?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

interface FixtureOptions {
  direction?: Direction;
  length?: number;
  sweep?: SweepOverride;
  chochIndex?: number;
  fvgIndex?: number;
  choch?: any | null;
  zones?: any[] | null;
  sessionRanges?: any[] | null;
  killzone?: string;
  atr15m?: Decimal;
  atr4h?: Decimal;
  asianHigh?: string;
  asianLow?: string;
  asianEnd?: number;
  candles?: any[];
}

/**
 * Default fixtures.
 *
 * Bullish (Asian LOW swept → long):
 *   Asian range 99..105, ATR15m 0.5, ATR4H 10 (range height 6 < 3 * ATR4H)
 *   Sweep candle idx 1 : open 100, high 101, low 98.9, close 99.2
 *   CHoCH idx 4        : BULLISH, impulseFactor 2.0
 *   FVG idx 6          : 101 / 100  → entry 100.5
 *
 * Bearish (Asian HIGH swept → short):
 *   Sweep candle idx 1 : open 100, high 106.5, low 99.5, close 104.8
 *   CHoCH idx 4        : BEARISH, impulseFactor 2.0
 *   FVG idx 6          : 102 / 100.5 → entry 101.25
 */
const makePatternData = (options: FixtureOptions = {}): any => {
  const direction = options.direction ?? 'BULLISH';
  const length = options.length ?? 8;
  const sweepIndex = options.sweep?.index ?? 1;
  const chochIndex = options.chochIndex ?? 4;
  const fvgIndex = options.fvgIndex ?? 6;

  const candles = options.candles ?? baseCandles(length);
  candles[sweepIndex] = {
    ...candles[sweepIndex],
    open: options.sweep?.open ?? (direction === 'BULLISH' ? '100' : '100'),
    high: options.sweep?.high ?? (direction === 'BULLISH' ? '101' : '106.5'),
    low: options.sweep?.low ?? (direction === 'BULLISH' ? '98.9' : '99.5'),
    close: options.sweep?.close ?? (direction === 'BULLISH' ? '99.2' : '104.8'),
  };

  const defaultChoch = {
    type: 'CHOCH',
    direction,
    price: new Decimal(direction === 'BULLISH' ? 100 : 103),
    timestamp: tsAt(chochIndex, length),
    timeframe: '15',
    isValidated: true,
    impulseFactor: new Decimal(2),
  };

  const defaultFvg = {
    type: 'FVG',
    direction,
    top: new Decimal(direction === 'BULLISH' ? 101 : 102),
    bottom: new Decimal(direction === 'BULLISH' ? 100 : 100.5),
    timestamp: tsAt(fvgIndex, length),
    mitigated: false,
    timeframe: '15',
  };

  const defaultAsian = {
    name: 'ASIAN' as const,
    high: new Decimal(options.asianHigh ?? 105),
    low: new Decimal(options.asianLow ?? 99),
    start: ASIAN_END - 4 * 60 * 60 * 1000,
    end: options.asianEnd ?? ASIAN_END,
  };

  return {
    currentKillzone: options.killzone ?? 'LONDON',
    currentSession: 'LONDON',
    candles15m: candles,
    sessionRanges:
      options.sessionRanges === undefined ? [defaultAsian] : options.sessionRanges,
    structures:
      options.choch === undefined ? [defaultChoch] : options.choch === null ? [] : [options.choch],
    zones:
      options.zones === undefined ? [defaultFvg] : options.zones === null ? [] : options.zones,
    atr15m: options.atr15m ?? new Decimal('0.5'),
    atr4h: options.atr4h ?? new Decimal('10'),
  };
};

describe('Scenario7: AMD (Accumulation-Manipulation-Distribution)', () => {
  let scenario: Scenario7_AMD;

  beforeEach(() => {
    Scenario7_AMD.resetStats();
    scenario = new Scenario7_AMD(mockConfig);
  });

  describe('ideal bullish AMD (Asian low swept → long)', () => {
    it('triggers on sweep + 15m CHoCH + FVG equilibrium entry', () => {
      const result = scenario.evaluate(makePatternData());

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('AMD');
      expect(scenario.getReason()).toContain('Asian low swept');
      expect(scenario.getReason()).toContain('BULLISH CHoCH');
    });

    it('anchors the entry on the FVG midpoint and the stop beyond the manipulation wick', () => {
      scenario.evaluate(makePatternData());
      const levels = scenario.getLevels();

      // FVG 101 / 100 → entry 100.5
      expect(levels.entry.toString()).toBe('100.5');
      // min(fvgBottom 100, sweepLow 98.9, lastLow 100.5) - max(0.25, 0.1005)
      expect(levels.stopLoss.toString()).toBe('98.65');
      // fixed 3R fallback: 100.5 + 3 * 1.85
      expect(levels.takeProfit.toString()).toBe('106.05');
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('tags the CHoCH as the burn anchor and the FVG as the entry zone', () => {
      scenario.evaluate(makePatternData());

      const structure = scenario.getStructureDetails();
      expect(structure).not.toBeNull();
      expect(structure!.type).toBe('CHoCH');
      expect(structure!.direction).toBe('BULLISH');
      expect(structure!.timestamp).toBe(tsAt(4, 8));
      expect(structure!.price!.toString()).toBe('100');

      const zone = scenario.getZoneDetails();
      expect(zone).not.toBeNull();
      expect(zone!.type).toBe('FVG');
      expect(zone!.timeframe).toBe('15');
      expect(zone!.direction).toBe('BULLISH');
      expect(zone!.top.toString()).toBe('101');
      expect(zone!.bottom.toString()).toBe('100');
      expect(zone!.timestamp).toBe(tsAt(6, 8));
    });
  });

  describe('ideal bearish AMD (Asian high swept → short)', () => {
    it('triggers the mirrored short', () => {
      const result = scenario.evaluate(makePatternData({ direction: 'BEARISH' }));

      if (!result) console.log('REJECTION:', scenario.getReason());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Asian high swept');
      expect(scenario.getReason()).toContain('BEARISH CHoCH');
    });

    it('places the stop above the sweep wick and the target below the entry', () => {
      scenario.evaluate(makePatternData({ direction: 'BEARISH' }));
      const levels = scenario.getLevels();

      // FVG 102 / 100.5 → entry 101.25
      expect(levels.entry.toString()).toBe('101.25');
      // max(fvgTop 102, sweepHigh 106.5, lastHigh 101) + max(0.25, 0.10125)
      expect(levels.stopLoss.toString()).toBe('106.75');
      // fixed 3R fallback: 101.25 - 3 * 5.5
      expect(levels.takeProfit.toString()).toBe('84.75');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('tags a BEARISH CHoCH structure anchor', () => {
      scenario.evaluate(makePatternData({ direction: 'BEARISH' }));

      expect(scenario.getStructureDetails()!.type).toBe('CHoCH');
      expect(scenario.getStructureDetails()!.direction).toBe('BEARISH');
      expect(scenario.getStructureDetails()!.price!.toString()).toBe('103');
    });
  });

  describe('killzone gate', () => {
    it('rejects the Asian session', () => {
      const result = scenario.evaluate(makePatternData({ killzone: 'ASIAN' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
      expect(Scenario7_AMD.getRejectionStats().killzone).toBe(1);
    });

    it('rejects NONE', () => {
      const result = scenario.evaluate(makePatternData({ killzone: 'NONE' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });

    it('accepts NY', () => {
      expect(scenario.evaluate(makePatternData({ killzone: 'NY' }))).toBe(true);
    });

    it('is bypassed by ENFORCE_KILLZONES=false', () => {
      const loose = new Scenario7_AMD({ ...mockConfig, enforceKillzones: false });
      expect(loose.evaluate(makePatternData({ killzone: 'NONE' }))).toBe(true);
    });
  });

  describe('accumulation gate', () => {
    it('rejects without an Asian range', () => {
      const result = scenario.evaluate(makePatternData({ sessionRanges: null }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No Asian Range');
      expect(Scenario7_AMD.getRejectionStats().noAsianRange).toBe(1);
    });

    it('uses the freshest Asian range when several are supplied', () => {
      const stale = {
        name: 'ASIAN',
        high: new Decimal(105),
        low: new Decimal(99),
        start: ASIAN_END - 30 * 60 * 60 * 1000,
        end: ASIAN_END - 24 * 60 * 60 * 1000,
      };
      const fresh = {
        name: 'ASIAN',
        high: new Decimal(120),
        low: new Decimal(118),
        start: ASIAN_END - 4 * 60 * 60 * 1000,
        end: ASIAN_END,
      };

      const result = scenario.evaluate(makePatternData({ sessionRanges: [stale, fresh] }));

      // The fresh coil (118..120) was never swept, so the stale one must not be used.
      expect(result).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a range wider than 3 x ATR4H (trend, not accumulation)', () => {
      const result = scenario.evaluate(
        makePatternData({ asianHigh: '130', asianLow: '90', atr4h: new Decimal(10) }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('too wide');
      expect(Scenario7_AMD.getRejectionStats().asianRangeTooWide).toBe(1);
    });
  });

  describe('manipulation (SFP) gate', () => {
    it('rejects when no extreme was swept', () => {
      const result = scenario.evaluate(
        makePatternData({
          sweep: { open: '100', high: '101', low: '100.2', close: '100.5' },
        }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('not swept');
      expect(Scenario7_AMD.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a tap that never pierces the level', () => {
      const result = scenario.evaluate(
        makePatternData({ sweep: { open: '100', high: '101', low: '99', close: '100' } }),
      );

      expect(result).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a candle that pierces but closes beyond the level', () => {
      // low 98.9 takes the low, but the body closes at 98.5 — acceptance, not SFP.
      const result = scenario.evaluate(
        makePatternData({ sweep: { open: '100', high: '101', low: '98.9', close: '98.5' } }),
      );

      expect(result).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noSweep).toBe(1);
    });

    it('ignores a sweep printed at or before the Asian session end', () => {
      const result = scenario.evaluate(makePatternData({ asianEnd: tsAt(3, 8) }));

      expect(result).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noSweep).toBe(1);
    });

    it('ignores a sweep older than the 8-candle manipulation window', () => {
      // 12 candles: the window covers idx 4..11 and the sweep sits at idx 2.
      const result = scenario.evaluate(makePatternData({ length: 12, sweep: { index: 2 } }));

      expect(result).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noSweep).toBe(1);
    });

    it('anchors on the NEWEST sweep — an older CHoCH cannot validate a fresher sweep', () => {
      // The fixture CHoCH sits at idx 4; a fresher sweep prints at idx 5.
      const data = makePatternData({ sweep: { index: 5 } });
      data.candles15m[1] = {
        ...data.candles15m[1],
        low: '98.9',
        close: '99.2',
      };

      const result = scenario.evaluate(data);

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH at or after');
      expect(Scenario7_AMD.getRejectionStats().noChoch).toBe(1);
    });

    it('resolves an outside bar by deeper penetration (low wins)', () => {
      // low 97 → 2.0 below, high 106 → 1.0 above
      const result = scenario.evaluate(
        makePatternData({ sweep: { open: '100', high: '106', low: '97', close: '99.2' } }),
      );

      expect(result).toBe(true);
      expect(scenario.getStructureDetails()!.direction).toBe('BULLISH');
    });

    it('resolves an outside bar by deeper penetration (high wins)', () => {
      // low 98.5 → 0.5 below, high 107 → 2.0 above
      const result = scenario.evaluate(
        makePatternData({
          direction: 'BEARISH',
          sweep: { open: '100', high: '107', low: '98.5', close: '104.8' },
        }),
      );

      expect(result).toBe(true);
      expect(scenario.getStructureDetails()!.direction).toBe('BEARISH');
    });
  });

  describe('CHoCH causality gate', () => {
    it('rejects when there is no CHoCH', () => {
      const result = scenario.evaluate(makePatternData({ choch: null }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH');
      expect(Scenario7_AMD.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects a CHoCH that printed before the sweep', () => {
      const result = scenario.evaluate(makePatternData({ chochIndex: 0 }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('at or after');
    });

    it('rejects a CHoCH outside the 8h causality window', () => {
      // A feed gap (session break / resubscribe) separates the sweep from the
      // confirming break: the sweep sits at idx 33, inside the 8-candle
      // manipulation window, but 10.5h of wall clock away from the last candle —
      // beyond the 8h causality budget measured on the recent 15m spacing.
      const GAP_MS = 9 * 60 * 60 * 1000;
      const length = 40;
      const candles: any[] = baseCandles(length).map((candle, index) => ({
        ...candle,
        timestamp: index <= 33 ? candle.timestamp - GAP_MS : candle.timestamp,
      }));
      candles[33] = {
        ...candles[33],
        open: '100',
        high: '101',
        low: '98.9',
        close: '99.2',
      };

      const choch = {
        type: 'CHOCH',
        direction: 'BULLISH',
        price: new Decimal(100),
        timestamp: candles[39].timestamp,
        timeframe: '15',
        isValidated: true,
        impulseFactor: new Decimal(2),
      };
      const fvg = {
        type: 'FVG',
        direction: 'BULLISH',
        top: new Decimal(101),
        bottom: new Decimal(100),
        timestamp: candles[39].timestamp,
        mitigated: false,
        timeframe: '15',
      };

      const result = scenario.evaluate(
        makePatternData({ candles, choch, zones: [fvg] }),
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('at or after');
      expect(Scenario7_AMD.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects a CHoCH with displacement < 1.5 ATR', () => {
      const data = makePatternData();
      data.structures[0].impulseFactor = new Decimal(1);

      const result = scenario.evaluate(data);

      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH after Asian sweep displacement < 1.5 ATR');
      expect(Scenario7_AMD.getRejectionStats().displacement).toBe(1);
    });

    it('rejects a 4H CHoCH (strict 15m anchor)', () => {
      const data = makePatternData();
      data.structures[0].timeframe = '240';

      expect(scenario.evaluate(data)).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noChoch).toBe(1);
    });

    it('rejects the wrong-direction CHoCH', () => {
      const data = makePatternData();
      data.structures[0].direction = 'BEARISH';

      expect(scenario.evaluate(data)).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noChoch).toBe(1);
    });

    it('takes the newest qualifying CHoCH', () => {
      const data = makePatternData();
      data.structures.push({
        ...data.structures[0],
        timestamp: tsAt(5, 8),
        impulseFactor: new Decimal(2.5),
      });

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getStructureDetails()!.timestamp).toBe(tsAt(5, 8));
    });
  });

  describe('entry POI gate', () => {
    it('rejects when no FVG follows the CHoCH', () => {
      const result = scenario.evaluate(makePatternData({ zones: null }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('FVG after the CHoCH');
      expect(Scenario7_AMD.getRejectionStats().noFvg).toBe(1);
    });

    it('rejects an FVG that printed before the CHoCH', () => {
      const result = scenario.evaluate(makePatternData({ fvgIndex: 3 }));

      expect(result).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noFvg).toBe(1);
    });

    it('rejects a 4H FVG (15m entry POI only)', () => {
      const data = makePatternData();
      data.zones[0].timeframe = '240';

      expect(scenario.evaluate(data)).toBe(false);
      expect(Scenario7_AMD.getRejectionStats().noFvg).toBe(1);
    });

    it('rejects an FVG of the opposing direction', () => {
      const data = makePatternData();
      data.zones[0].direction = 'BEARISH';

      expect(scenario.evaluate(data)).toBe(false);
    });

    it('takes the freshest FVG at or after the CHoCH', () => {
      const data = makePatternData();
      data.zones.push({
        type: 'FVG',
        direction: 'BULLISH',
        top: new Decimal(102),
        bottom: new Decimal(101),
        timestamp: tsAt(5, 8),
        mitigated: false,
        timeframe: '15',
      });

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getLevels().entry.toString()).toBe('100.5');
      expect(scenario.getZoneDetails()!.timestamp).toBe(tsAt(6, 8));
      expect(scenario.getZoneDetails()!.top.toString()).toBe('101');
    });
  });

  describe('structural take-profit', () => {
    it('targets the Asian high with the distribution range when dynamic TP is enabled', () => {
      const resolverScenario = new Scenario7_AMD(dynamicTpConfig);
      const result = resolverScenario.evaluate(makePatternData());

      if (!result) console.log('REJECTION:', resolverScenario.getReason());

      expect(result).toBe(true);
      expect(resolverScenario.getLevels().takeProfit.toString()).toBe('105');
      expect(resolverScenario.getReason()).toContain('SESSION_RANGE');
    });

    it('targets the Asian low from the short side', () => {
      const resolverScenario = new Scenario7_AMD(dynamicTpConfig);
      // An FVG near the swept high keeps the risk off the manipulation wick
      // small enough that the distribution leg to the Asian low clears minRr.
      const result = resolverScenario.evaluate(
        makePatternData({
          direction: 'BEARISH',
          zones: [
            {
              type: 'FVG',
              direction: 'BEARISH',
              top: new Decimal('105.5'),
              bottom: new Decimal('104.5'),
              timestamp: tsAt(6, 8),
              mitigated: false,
              timeframe: '15',
            },
          ],
        }),
      );

      if (!result) console.log('REJECTION:', resolverScenario.getReason());

      expect(result).toBe(true);
      // entry 105, SL 106.75 (sweep high 106.5 + 0.25) → 1.75 risk, 6.0 reward
      expect(resolverScenario.getLevels().takeProfit.toString()).toBe('99');
      expect(resolverScenario.getReason()).toContain('SESSION_RANGE');
    });

    it('rejects instead of clamping when the range leaves less than minRr', () => {
      const resolverScenario = new Scenario7_AMD(dynamicTpConfig);
      // Deeper manipulation wick: risk 3.25, reward to the Asian high 4.5 → 1.38R
      const result = resolverScenario.evaluate(
        makePatternData({ sweep: { open: '100', high: '101', low: '97.5', close: '99.2' } }),
      );

      expect(result).toBe(false);
      expect(resolverScenario.getReason()).toContain('Take-profit rejected');
      expect(Scenario7_AMD.getRejectionStats().tpInvalid).toBe(1);
    });
  });

  describe('rejection stats', () => {
    it('counts each funnel stage', () => {
      Scenario7_AMD.resetStats();

      scenario.evaluate(makePatternData({ killzone: 'ASIAN' }));
      scenario.evaluate(makePatternData({ sessionRanges: null }));
      scenario.evaluate(makePatternData({ asianHigh: '130', asianLow: '90' }));
      scenario.evaluate(makePatternData({ sweep: { low: '100.2', close: '100.5' } }));
      scenario.evaluate(makePatternData({ choch: null }));
      scenario.evaluate(makePatternData({ zones: null }));

      const stats = Scenario7_AMD.getRejectionStats();
      expect(stats.totalEvals).toBe(6);
      expect(stats.killzone).toBe(1);
      expect(stats.noAsianRange).toBe(1);
      expect(stats.asianRangeTooWide).toBe(1);
      expect(stats.noSweep).toBe(1);
      expect(stats.noChoch).toBe(1);
      expect(stats.noFvg).toBe(1);
      expect(stats.tpInvalid).toBe(0);
    });

    it('resets to zero', () => {
      scenario.evaluate(makePatternData());
      Scenario7_AMD.resetStats();

      const stats = Scenario7_AMD.getRejectionStats();
      expect(stats.totalEvals).toBe(0);
      expect(stats.killzone).toBe(0);
      expect(stats.noAsianRange).toBe(0);
      expect(stats.asianRangeTooWide).toBe(0);
      expect(stats.noSweep).toBe(0);
      expect(stats.noChoch).toBe(0);
      expect(stats.displacement).toBe(0);
      expect(stats.noFvg).toBe(0);
      expect(stats.tpInvalid).toBe(0);
    });
  });

  describe('integration', () => {
    it('exposes the static rejection-stats API', () => {
      expect(typeof Scenario7_AMD.getRejectionStats).toBe('function');
      expect(typeof Scenario7_AMD.resetStats).toBe('function');
      expect(typeof Scenario7_AMD.prototype.evaluate).toBe('function');
    });

    it('clears stale levels between evaluations', () => {
      expect(scenario.evaluate(makePatternData())).toBe(true);
      expect(scenario.getLevels().entry.gt(0)).toBe(true);

      expect(scenario.evaluate(makePatternData({ zones: null }))).toBe(false);
      expect(scenario.getLevels().entry.toString()).toBe('0');
      expect(scenario.getZoneDetails()).toBeNull();
      expect(scenario.getStructureDetails()).toBeNull();
    });
  });
});
