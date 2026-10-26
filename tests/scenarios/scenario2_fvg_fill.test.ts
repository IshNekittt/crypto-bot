import { Scenario2_FVGFill } from '../../src/engine/scenarios/Scenario2_FVGFill';
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
  activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
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
    preflightBufferPct: "0.05",
    enableHealthcheckServer: false,
    allowedDaysOfWeek: [1, 2, 3, 4, 5],
    enforceKillzones: true,
    enableTradeNotifications: true,
};

/** 15m entry series. */
const LTF_MS = 15 * 60 * 1000;
/** 100 15m candles ≈ 25h of history — several 4H windows. */
const CANDLE_COUNT = 100;
const T0 = 1_788_652_800_000;
/** Index of the candle whose timestamp carries the 4H FVG stamp. */
const FVG_INDEX = 10;
/** Index of the fill bar — inside the last 16 candles (one 4H window). */
const FILL_INDEX = 90;
/** Index of the confirming 15m CHoCH. */
const CHOCH_INDEX = 95;

/**
 * A 4H zone is stamped with a 4H candle timestamp, which is NOT on the 15m grid.
 * Deliberately offsetting it by 5 minutes is what exercises the anchor fix in
 * `hasLiquidityContext()` (the legacy code used `findIndex(timestamp === …)` and
 * therefore could never match a single 4H stamp).
 */
const OFF_GRID_OFFSET = 5 * 60 * 1000;

const indexTimestamp = (index: number): number => T0 + index * LTF_MS;

interface CandleShape {
  readonly open?: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

const candle = (index: number, shape: CandleShape) => ({
  timestamp: indexTimestamp(index),
  open: shape.open ?? shape.close,
  high: shape.high,
  low: shape.low,
  close: shape.close,
  volume: '1000',
});

type Direction = 'BULLISH' | 'BEARISH';

interface FvgFixtureOptions {
  readonly direction?: Direction;
  /** Dealing-range equilibrium returned by the mocked recognizer. */
  readonly pdEquilibrium?: string;
  readonly fvgTop?: string;
  readonly fvgBottom?: string;
  readonly withLiquidityPool?: boolean;
  readonly withChoch?: boolean;
  readonly chochTimeframe?: string;
  readonly chochIndex?: number;
  readonly chochImpulse?: string;
  readonly currentLow?: string;
  readonly currentHigh?: string;
  readonly currentClose?: string;
}

/**
 * Scenario 2 fixture.
 *
 * Geometry: the 4H FVG is 98 → 100 (equilibrium 99). Its stamp sits at
 * `FVG_INDEX`, so it completes 2 × 4H later (`FVG_FORMATION_CANDLES` measured in
 * the GAP's own timeframe). Every bar before `FILL_INDEX` is parked above the gap
 * so the first touch inside the 4H causality window is unambiguous.
 */
const createFvgPattern = (options: FvgFixtureOptions = {}) => {
  const direction: Direction = options.direction ?? 'BULLISH';
  const currentLow = options.currentLow ?? '97.5';
  const currentHigh = options.currentHigh ?? '99.5';
  const currentClose = options.currentClose ?? '99';

  const candles15m: any[] = [];
  for (let i = 0; i < CANDLE_COUNT; i++) {
    // Parked above the gap: high 106 / low 102 can never touch 98 → 100.
    candles15m.push(candle(i, { high: '106', low: '102', close: '104' }));
  }

  // The fill bar: the first candle inside the window that trades into the gap.
  candles15m[FILL_INDEX] = candle(FILL_INDEX, {
    high: '101',
    low: '98.5',
    close: '100',
  });

  // The current candle sits at the gap's equilibrium on purpose: the entry is a
  // retest of the POI, not a chase.
  candles15m[CANDLE_COUNT - 1] = candle(CANDLE_COUNT - 1, {
    high: currentHigh,
    low: currentLow,
    close: currentClose,
  });

  const htfFvg = {
    type: 'FVG' as const,
    direction,
    top: new Decimal(options.fvgTop ?? '100'),
    bottom: new Decimal(options.fvgBottom ?? '98'),
    timestamp: indexTimestamp(FVG_INDEX) + OFF_GRID_OFFSET,
    mitigated: false,
    timeframe: '240',
  };

  const chochIndex = options.chochIndex ?? CHOCH_INDEX;
  const structures: any[] = [];
  if (options.withChoch !== false) {
    structures.push({
      type: 'CHOCH' as const,
      direction,
      price: new Decimal('99'),
      timestamp: indexTimestamp(chochIndex),
      timeframe: options.chochTimeframe ?? '15',
      isValidated: true,
      impulseFactor: new Decimal(options.chochImpulse ?? '2.0'),
    });
  }

  const liquidityPools =
    options.withLiquidityPool === false
      ? []
      : [
          {
            // `PatternRecognizer` always emits `isTaken: false`; the gate must not
            // depend on it (it used to, and was therefore permanently dead).
            type: 'SSL' as const,
            priceLevel: new Decimal('101'),
            timestamp: indexTimestamp(5),
            isTaken: false,
            points: [],
          },
        ];

  return {
    currentKillzone: 'LONDON' as const,
    currentSession: 'LONDON' as const,
    candles15m,
    candles4h: [
      { timestamp: T0, open: '104', high: '106', low: '102', close: '104', volume: '1' },
    ],
    zones: [htfFvg],
    structures,
    liquidityPools,
    atr15m: new Decimal('0.5'),
    patternRecognizer: {
      config: { wickRatioThreshold: new Decimal('0.4') },
      calculatePremiumDiscount: () => ({
        equilibrium: new Decimal(options.pdEquilibrium ?? '110'),
        rangeHigh: new Decimal('120'),
        rangeLow: new Decimal('100'),
        isPremium: false,
        isDiscount: true,
      }),
    } as any,
  };
};

describe('Scenario2: FVG Fill', () => {
  let scenario: Scenario2_FVGFill;

  beforeEach(() => {
    Scenario2_FVGFill.resetStats();
    scenario = new Scenario2_FVGFill(mockConfig);
  });

  describe('bidirectional execution', () => {
    it('triggers a LONG on a BULLISH HTF FVG filled in Discount', () => {
      const result = scenario.evaluate(createFvgPattern({ pdEquilibrium: '110' }));

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('BULLISH HTF FVG 0.5 touch');
      expect(scenario.getReason()).toContain('Premium/Discount');

      // entry = gap equilibrium (99); the stop sits beyond the retest wick
      // (97.5) with the 0.5 × ATR offset (0.25) subtracted, so the position is
      // not protected by a level its own trigger bar already violated.
      const levels = scenario.getLevels();
      expect(levels.entry.toFixed(2)).toBe('99.00');
      expect(levels.stopLoss.toFixed(2)).toBe('97.25');
      expect(levels.takeProfit.toFixed(2)).toBe('104.25');

      const zone = scenario.getZoneDetails();
      expect(zone?.type).toBe('FVG');
      expect(zone?.direction).toBe('BULLISH');
      expect(zone?.timeframe).toBe('240');

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('CHoCH');
      expect(structure?.timestamp).toBe(indexTimestamp(CHOCH_INDEX));
    });

    it('triggers a SHORT on a BEARISH HTF FVG filled in Premium', () => {
      const result = scenario.evaluate(
        createFvgPattern({
          direction: 'BEARISH',
          // Bearish mirror: the gap must sit ABOVE the dealing-range equilibrium.
          pdEquilibrium: '90',
          currentHigh: '100.5',
          currentLow: '98.5',
          currentClose: '99',
        }),
      );

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('BEARISH HTF FVG 0.5 touch');

      const levels = scenario.getLevels();
      expect(levels.entry.toFixed(2)).toBe('99.00');
      expect(levels.stopLoss.toFixed(2)).toBe('100.75');
      expect(levels.takeProfit.toFixed(2)).toBe('93.75');

      expect(scenario.getZoneDetails()?.direction).toBe('BEARISH');
      // The stop and the target are mirrored, not merely shifted.
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    });

    it('ignores the legacy `hasBullish4h` veto: a bearish 4H break does not block a long', () => {
      const data = createFvgPattern();
      data.structures.push({
        type: 'BOS' as const,
        direction: 'BEARISH' as const,
        price: new Decimal('102'),
        timestamp: indexTimestamp(50),
        timeframe: '240',
        isValidated: true,
        impulseFactor: new Decimal('2.0'),
      } as any);

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getZoneDetails()?.direction).toBe('BULLISH');
    });
  });

  describe('killzone', () => {
    it('rejects when the killzone is NONE', () => {
      const data = createFvgPattern();
      (data as any).currentKillzone = 'NONE';

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
      expect(Scenario2_FVGFill.getRejectionStats().killzone).toBe(1);
    });

    it('bypasses the killzone when ENFORCE_KILLZONES=false', () => {
      const bypass = new Scenario2_FVGFill({ ...mockConfig, enforceKillzones: false });
      const data = createFvgPattern();
      (data as any).currentKillzone = 'NONE';

      expect(bypass.evaluate(data)).toBe(true);
    });
  });

  describe('HTF FVG selection', () => {
    it('rejects when no HTF FVG is present', () => {
      const data = createFvgPattern();
      data.zones = [];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No HTF FVG found');
    });

    it('rejects a 15m FVG (the POI must be HTF)', () => {
      const data = createFvgPattern();
      data.zones[0].timeframe = '15';

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No HTF FVG found');
      expect(Scenario2_FVGFill.getRejectionStats().noHtfFvg).toBe(1);
    });

    it('rejects when no 15m candles are available', () => {
      const data = createFvgPattern();
      data.candles15m = [];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m candle available');
    });
  });

  describe('fill gate', () => {
    it('rejects when the current candle has left the gap equilibrium', () => {
      const data = createFvgPattern({
        currentHigh: '103',
        currentLow: '101',
        currentClose: '102',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('0.5 (Equilibrium) of HTF BULLISH FVG');
      expect(Scenario2_FVGFill.getRejectionStats().noFvgTouch).toBe(1);
    });

    it('anchors the CHoCH after the FIRST touch inside the 4H window, not on the gap stamp', () => {
      // A CHoCH printed before the gap was ever traded into belongs to the
      // previous leg. It must not be able to confirm this one.
      const data = createFvgPattern({ chochIndex: FILL_INDEX - 1 });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m BULLISH CHoCH after FVG touch');
      expect(Scenario2_FVGFill.getRejectionStats().noChoch).toBe(1);
    });

    it('accepts a CHoCH printed on the fill candle itself', () => {
      const data = createFvgPattern({ chochIndex: FILL_INDEX });

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getStructureDetails()?.timestamp).toBe(indexTimestamp(FILL_INDEX));
    });
  });

  describe('premium / discount', () => {
    it('rejects a BULLISH gap sitting in Premium', () => {
      const data = createFvgPattern({ pdEquilibrium: '95' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('BULLISH HTF FVG not in Discount zone');
      expect(Scenario2_FVGFill.getRejectionStats().premiumDiscount).toBe(1);
    });

    it('rejects a BEARISH gap sitting in Discount', () => {
      const data = createFvgPattern({
        direction: 'BEARISH',
        pdEquilibrium: '110',
        currentHigh: '100.5',
        currentClose: '99',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('BEARISH HTF FVG not in Premium zone');
    });

    it('skips the check when the recognizer is unavailable', () => {
      const data = createFvgPattern();
      delete (data as any).patternRecognizer;

      expect(scenario.evaluate(data)).toBe(true);
    });
  });

  describe('liquidity context', () => {
    it('rejects when nothing swept / broke before the gap formed', () => {
      const data = createFvgPattern({ withLiquidityPool: false });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('liquidity context');
      expect(Scenario2_FVGFill.getRejectionStats().noLiquidityContext).toBe(1);
    });

    it('accepts a pool emitted with `isTaken: false` (dead flag removed)', () => {
      const data = createFvgPattern();
      (data.liquidityPools[0] as any).isTaken = false;

      expect(scenario.evaluate(data)).toBe(true);
    });

    it('matches an off-grid 4H stamp against the 15m series (anchor fix)', () => {
      // The pool sits 5 candles before the gap stamp. The legacy exact-timestamp
      // lookup could never find the 4H stamp in the 15m series, so this setup
      // used to be rejected on every evaluation.
      const data = createFvgPattern();
      data.liquidityPools = [
        {
          type: 'BSL' as const,
          priceLevel: new Decimal('106'),
          timestamp: indexTimestamp(5),
          isTaken: false,
          points: [],
        } as any,
      ];

      expect(scenario.evaluate(data)).toBe(true);
    });
  });

  describe('CHoCH', () => {
    it('rejects when no CHoCH exists', () => {
      const data = createFvgPattern({ withChoch: false });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m BULLISH CHoCH after FVG touch');
    });

    it('rejects a 4H CHoCH (confirmation must be on the entry timeframe)', () => {
      const data = createFvgPattern({ chochTimeframe: '240' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m BULLISH CHoCH after FVG touch');
    });

    it('rejects a CHoCH in the opposite direction', () => {
      const data = createFvgPattern();
      data.structures[0].direction = 'BEARISH';

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m BULLISH CHoCH after FVG touch');
    });

    it('rejects a CHoCH with displacement < 1.5 ATR', () => {
      const data = createFvgPattern({ chochImpulse: '1.0' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('15m CHoCH displacement < 1.5 ATR');
      expect(Scenario2_FVGFill.getRejectionStats().displacement).toBe(1);
    });
  });

  describe('deepest-stage funnel', () => {
    it('reports the furthest stage reached, not the newest gap\'s first failure', () => {
      // Two gaps: the fresher one never reaches its equilibrium (gate 1) while
      // the older, actually-tested one gets all the way to the CHoCH gate. A
      // first-wins funnel would report `noFvgTouch` and hide that the chain is
      // broken on confirmation.
      const data = createFvgPattern({ withChoch: false });
      data.zones.push({
        type: 'FVG' as const,
        direction: 'BULLISH' as const,
        top: new Decimal('130'),
        bottom: new Decimal('128'),
        timestamp: indexTimestamp(FVG_INDEX + 1) + OFF_GRID_OFFSET,
        mitigated: false,
        timeframe: '240',
      } as any);

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m BULLISH CHoCH after FVG touch');
      expect(Scenario2_FVGFill.getRejectionStats().noChoch).toBe(1);
      expect(Scenario2_FVGFill.getRejectionStats().noFvgTouch).toBe(0);
    });

    it('falls through to an older gap when the fresher one cannot complete', () => {
      const data = createFvgPattern();
      // Fresher gap, far away from price → gate 1 fails, the older gap wins.
      data.zones.push({
        type: 'FVG' as const,
        direction: 'BULLISH' as const,
        top: new Decimal('130'),
        bottom: new Decimal('128'),
        timestamp: indexTimestamp(FVG_INDEX + 1) + OFF_GRID_OFFSET,
        mitigated: false,
        timeframe: '240',
      } as any);

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getZoneDetails()?.top.toFixed(2)).toBe('100.00');
    });
  });

  describe('stat isolation', () => {
    it('increments totalEvals on every evaluation and resets on demand', () => {
      scenario.evaluate(createFvgPattern());
      scenario.evaluate(createFvgPattern({ withChoch: false }));
      expect(Scenario2_FVGFill.getRejectionStats().totalEvals).toBe(2);

      Scenario2_FVGFill.resetStats();
      expect(Scenario2_FVGFill.getRejectionStats().totalEvals).toBe(0);
    });
  });
});
