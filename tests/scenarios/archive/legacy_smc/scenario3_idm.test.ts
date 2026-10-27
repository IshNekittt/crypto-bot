import { Scenario3_IDM } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario3_IDM';
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

const LTF_MS = 15 * 60 * 1000;
const CANDLE_COUNT = 50;
const LAST_INDEX = CANDLE_COUNT - 1;
const T0 = 1_788_652_800_000;

const indexTimestamp = (index: number): number => T0 + index * LTF_MS;

/** Index of the OB that absorbs the move ("the real POI beyond the inducement"). */
const OB_INDEX = 30;
/** Index of the structural break whose consumed swing becomes the inducement. */
const STRUCTURE_INDEX = 40;

interface IdmFixtureOptions {
  readonly structureDirection?: 'BULLISH' | 'BEARISH';
  readonly sweptLevel?: string;
  readonly structureIndex?: number;
  readonly structureTimeframe?: string;
  readonly obDirection?: 'BULLISH' | 'BEARISH';
  readonly obTop?: string;
  readonly obBottom?: string;
  readonly obIndex?: number;
  readonly obTimeframe?: string;
  readonly withStructure?: boolean;
  readonly extraStructure?: Record<string, unknown>;
  readonly last?: { open?: string; high: string; low: string; close: string };
}

/**
 * Scenario 3 fixture.
 *
 * The traded story: a bearish break left a low at `sweptLevel` behind. The
 * trigger candle wicks through that low (taking the stops resting there) and
 * closes back above it, while the same wick reaches the demand block sitting
 * just below — the "real" POI the inducement was guarding.
 *
 * A bullish structure is the exact mirror: the break left a high, the wick
 * takes it and closes back below, and the block above absorbs the move.
 */
const createIdmPattern = (options: IdmFixtureOptions = {}) => {
  const structureDirection = options.structureDirection ?? 'BEARISH';
  const obDirection =
    options.obDirection ?? (structureDirection === 'BEARISH' ? 'BULLISH' : 'BEARISH');

  const candles15m: any[] = [];
  for (let i = 0; i < CANDLE_COUNT; i++) {
    candles15m.push({
      timestamp: indexTimestamp(i),
      open: '96',
      high: '96.5',
      low: '95.5',
      close: '96',
      volume: '1000',
    });
  }

  const lastShape = options.last ?? {
    open: '95.5',
    high: '96.5',
    low: '91.5',
    close: '96',
  };
  candles15m[LAST_INDEX] = {
    timestamp: indexTimestamp(LAST_INDEX),
    open: lastShape.open ?? lastShape.close,
    high: lastShape.high,
    low: lastShape.low,
    close: lastShape.close,
    volume: '1000',
  };

  const ob = {
    type: 'OB' as const,
    direction: obDirection,
    top: new Decimal(options.obTop ?? '94.2'),
    bottom: new Decimal(options.obBottom ?? '92.2'),
    timestamp: indexTimestamp(options.obIndex ?? OB_INDEX),
    mitigated: false,
    timeframe: options.obTimeframe ?? '15',
  };

  const structures: any[] = [];
  if (options.withStructure !== false) {
    structures.push({
      type: 'BOS' as const,
      direction: structureDirection,
      price: new Decimal(options.sweptLevel ?? '95'),
      timestamp: indexTimestamp(options.structureIndex ?? STRUCTURE_INDEX),
      timeframe: options.structureTimeframe ?? '15',
      isValidated: true,
      impulseFactor: new Decimal('2.0'),
    });
  }
  if (options.extraStructure) {
    structures.push(options.extraStructure);
  }

  return {
    currentKillzone: 'LONDON' as const,
    currentSession: 'LONDON' as const,
    candles15m,
    zones: [ob],
    structures,
    liquidityPools: [],
    atr15m: new Decimal('0.5'),
  };
};

describe('Scenario3: IDM (Inducement)', () => {
  let scenario: Scenario3_IDM;

  beforeEach(() => {
    Scenario3_IDM.resetStats();
    scenario = new Scenario3_IDM(mockConfig);
  });

  describe('bidirectional execution', () => {
    it('triggers a LONG on a swept low that reclaims into the demand block', () => {
      const result = scenario.evaluate(createIdmPattern());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('IDM: low at 95 swept and reclaimed');
      expect(scenario.getReason()).toContain('BULLISH OB 0.5 test');

      // entry = block equilibrium (93.2); the stop sits beyond the sweep wick
      // (91.5) with the 0.5 × ATR offset (0.25) subtracted, never at the block
      // bottom the trigger bar already pierced.
      const levels = scenario.getLevels();
      expect(levels.entry.toFixed(2)).toBe('93.20');
      expect(levels.stopLoss.toFixed(2)).toBe('91.25');
      expect(levels.takeProfit.toFixed(2)).toBe('99.05');

      // The burn anchor is the trigger candle, not the sweep level.
      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('SWEEP');
      expect(structure?.timestamp).toBe(indexTimestamp(LAST_INDEX));
      expect(structure?.price.toFixed(2)).toBe('95.00');
      expect(structure?.direction).toBe('BULLISH');

      const zone = scenario.getZoneDetails();
      expect(zone?.type).toBe('OB');
      expect(zone?.direction).toBe('BULLISH');
      expect(zone?.timestamp).toBe(indexTimestamp(OB_INDEX));
    });

    it('triggers a SHORT on a swept high that reclaims into the supply block', () => {
      const result = scenario.evaluate(
        createIdmPattern({
          structureDirection: 'BULLISH',
          sweptLevel: '105',
          obDirection: 'BEARISH',
          obTop: '107.8',
          obBottom: '105.8',
          last: { open: '105.5', high: '108.5', low: '103.5', close: '104' },
        }),
      );

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('IDM: high at 105 swept and reclaimed');

      const levels = scenario.getLevels();
      expect(levels.entry.toFixed(2)).toBe('106.80');
      expect(levels.stopLoss.toFixed(2)).toBe('108.75');
      expect(levels.takeProfit.toFixed(2)).toBe('100.95');
      expect(scenario.getStructureDetails()?.direction).toBe('BEARISH');
    });

    it('does not depend on the removed `brokenSwing` field', () => {
      // Production structures never carried `brokenSwing` (it belonged to the
      // deprecated `smc.ts` detector), so the legacy gate made every live setup
      // unreachable. An explicit `false` here proves the field is not consulted.
      const data = createIdmPattern();
      data.structures[0].brokenSwing = false;

      expect(scenario.evaluate(data)).toBe(true);
    });

    it('ignores a 4H structure/OB pair (the inducement is read on the entry timeframe)', () => {
      const data = createIdmPattern({
        structureTimeframe: '240',
        obTimeframe: '240',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m Order Block available');
    });
  });

  describe('killzone', () => {
    it('rejects when the killzone is NONE', () => {
      const data = createIdmPattern();
      (data as any).currentKillzone = 'NONE';

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
      expect(Scenario3_IDM.getRejectionStats().killzone).toBe(1);
    });
  });

  describe('preconditions', () => {
    it('rejects when no 15m candles are available', () => {
      const data = createIdmPattern();
      data.candles15m = [];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m candle available');
    });

    it('rejects when no 15m OB exists', () => {
      const data = createIdmPattern();
      data.zones = [];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m Order Block available');
      expect(Scenario3_IDM.getRejectionStats().noOb).toBe(1);
    });

    it('rejects when no 15m structure can define the inducement', () => {
      const data = createIdmPattern({ withStructure: false });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe(
        'No 15m structure available to define the inducement',
      );
      expect(Scenario3_IDM.getRejectionStats().noStructure).toBe(1);
    });

    it('rejects a structure printed by the trigger candle itself', () => {
      // A level created on this bar is not pre-existing liquidity, so it cannot
      // be the inducement the bar is sweeping.
      const data = createIdmPattern({ structureIndex: LAST_INDEX });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe(
        'No 15m structure available to define the inducement',
      );
    });
  });

  describe('sweep semantics: wick beyond + body back inside', () => {
    it('rejects when the level was never pierced', () => {
      const data = createIdmPattern({
        last: { open: '96', high: '96.5', low: '95.5', close: '96' },
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No IDM sweep of the low at 95');
      expect(Scenario3_IDM.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a break that keeps trading below the level (acceptance, not a sweep)', () => {
      // After a bearish break price LIVES below the level. Without the reclaim
      // the scenario would re-enter every bar of a downtrend.
      const data = createIdmPattern({
        last: { open: '95.5', high: '95.8', low: '91.5', close: '94' },
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('wick beyond + close back inside required');
      expect(Scenario3_IDM.getRejectionStats().noSweep).toBe(1);
    });
  });

  describe('real order block selection', () => {
    it('rejects when no same-direction block sits beyond the swept level', () => {
      const data = createIdmPattern({ obTop: '96', obBottom: '95.5' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No real BULLISH OB below the swept level');
      expect(Scenario3_IDM.getRejectionStats().noRealOb).toBe(1);
    });

    it('rejects a block printed by the trigger candle (must pre-exist)', () => {
      const data = createIdmPattern({ obIndex: LAST_INDEX });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No real BULLISH OB below the swept level');
    });

    it('rejects a block that is too far beyond the level', () => {
      const data = createIdmPattern({ obTop: '90', obBottom: '88' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('beyond the swept level');
      expect(Scenario3_IDM.getRejectionStats().proximity).toBe(1);
    });

    it('accepts a block at the edge of the tolerance band', () => {
      // tolerance = max(2 × ATR = 1.0, 0.5% of 95 = 0.475) = 1.0
      const data = createIdmPattern({ obTop: '94', obBottom: '92' });

      expect(scenario.evaluate(data)).toBe(true);
    });

    it('rejects when the sweep wick does not reach the block', () => {
      const data = createIdmPattern({
        last: { open: '95.5', high: '96.5', low: '94.5', close: '96' },
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('Price not testing real OB after IDM sweep');
      expect(Scenario3_IDM.getRejectionStats().noObTest).toBe(1);
    });
  });

  describe('deepest-stage funnel', () => {
    it('reports the furthest stage reached across all candidate structures', () => {
      // The freshest structure (level 90) is never swept → stage 1. The older one
      // (level 95) is swept but its block is far away → stage 3. A first-wins
      // funnel would report `noSweep` and hide the proximity failure.
      const data = createIdmPattern({
        obTop: '90',
        obBottom: '88',
        extraStructure: {
          type: 'BOS' as const,
          direction: 'BEARISH' as const,
          price: new Decimal('90'),
          timestamp: indexTimestamp(STRUCTURE_INDEX + 2),
          timeframe: '15',
          isValidated: true,
          impulseFactor: new Decimal('2.0'),
        },
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('beyond the swept level');
      expect(Scenario3_IDM.getRejectionStats().proximity).toBe(1);
      expect(Scenario3_IDM.getRejectionStats().noSweep).toBe(0);
    });
  });

  describe('stat isolation', () => {
    it('counts every evaluation and resets on demand', () => {
      scenario.evaluate(createIdmPattern());
      scenario.evaluate(createIdmPattern({ withStructure: false }));
      expect(Scenario3_IDM.getRejectionStats().totalEvals).toBe(2);

      Scenario3_IDM.resetStats();
      expect(Scenario3_IDM.getRejectionStats().totalEvals).toBe(0);
    });
  });
});
