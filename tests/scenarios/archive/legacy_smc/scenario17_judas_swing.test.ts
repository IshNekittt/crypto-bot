import { Scenario17_JudasSwing } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario17_JudasSwing';
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
  activeScenarios: [17],
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
  sweepVolumeMultiplier: new Decimal('1.3'),
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
  allowedDaysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  enforceKillzones: true,
  enableTradeNotifications: true,
};

const LTF_MS = 15 * 60 * 1000;
const CANDLE_COUNT = 40;

/**
 * 2026-09-08 06:00 UTC = 02:00 America/New_York (EDT) — the London killzone.
 * The previous Asian session (2026-09-07 20:00–24:00 NY) ended at 03:45 UTC,
 * 2h15m before the trigger.
 */
const TRIGGER_TS = Date.UTC(2026, 8, 8, 6, 0, 0);
const SWEEP_INDEX = CANDLE_COUNT - 1;
const BASE_VOLUME = '1000';

const ASIAN_START = Date.UTC(2026, 8, 8, 0, 0, 0); // 20:00 EDT 2026-09-07
const ASIAN_END = Date.UTC(2026, 8, 8, 3, 45, 0); // 23:45 EDT 2026-09-07

/**
 * 2026-09-09 00:15 UTC = 20:15 EDT 2026-09-08 — inside the still-forming Asian
 * window, used to prove a partial session is never treated as completed context.
 */
const FORMING_TRIGGER_TS = Date.UTC(2026, 8, 9, 0, 15, 0);
const FORMING_START = Date.UTC(2026, 8, 9, 0, 0, 0); // 20:00 EDT 2026-09-08

function candle(
  index: number,
  lastIndex: number,
  triggerTs: number,
  overrides: Record<string, string> = {},
) {
  return {
    timestamp: triggerTs - (lastIndex - index) * LTF_MS,
    open: '102.6',
    high: '103.2',
    low: '102.4',
    close: '103',
    volume: BASE_VOLUME,
    ...overrides,
  };
}

function asianRange(overrides: Partial<{
  high: Decimal;
  low: Decimal;
  start: number;
  end: number;
  name: string;
}> = {}) {
  return {
    name: 'ASIAN',
    high: new Decimal('105'),
    low: new Decimal('95'),
    start: ASIAN_START,
    end: ASIAN_END,
    ...overrides,
  };
}

interface FixtureOptions {
  readonly direction?: 'BULLISH' | 'BEARISH';
  readonly sweepIndex?: number;
  readonly sweepVolume?: string;
  readonly killzone?: string;
  readonly candleCount?: number;
  readonly ranges?: any[];
  readonly dynamicTp?: boolean;
  readonly extraPools?: Array<{ type: string; price: string }>;
  readonly triggerTs?: number;
}

/**
 * Builds a 40-candle 15m series ending at the London killzone.
 *
 *  - Bearish: Asian high 105 → wick 106, close 104.
 *  - Bullish: Asian low  95 → wick  94, close 95.8.
 *
 * Every preceding candle is neutral (high 103.2 / low 102.4) so it can neither
 * sweep the Asian high nor the Asian low.
 */
function buildPatternData(options: FixtureOptions = {}) {
  const direction = options.direction ?? 'BEARISH';
  const candleCount = options.candleCount ?? CANDLE_COUNT;
  const sweepIndex = options.sweepIndex ?? candleCount - 1;
  const triggerTs = options.triggerTs ?? TRIGGER_TS;
  const lastIndex = candleCount - 1;

  const candles = Array.from({ length: candleCount }, (_, i) =>
    candle(i, lastIndex, triggerTs),
  );

  if (direction === 'BEARISH') {
    candles[sweepIndex] = candle(sweepIndex, lastIndex, triggerTs, {
      open: '103',
      high: '106',
      low: '102.8',
      close: '104',
      volume: options.sweepVolume ?? '1500',
    });
  } else {
    candles[sweepIndex] = candle(sweepIndex, lastIndex, triggerTs, {
      open: '96',
      high: '96.2',
      low: '94',
      close: '95.8',
      volume: options.sweepVolume ?? '1500',
    });
  }

  const pools = (options.extraPools ?? []).map((p) => ({
    type: p.type,
    priceLevel: new Decimal(p.price),
    points: [],
    isTaken: false,
    timestamp: triggerTs - LTF_MS,
  }));

  return {
    currentKillzone: options.killzone ?? 'LONDON',
    currentSession: 'LONDON',
    candles15m: candles,
    structures: [],
    zones: [],
    liquidityPools: pools,
    sessionRanges: options.ranges ?? [asianRange()],
    tradingRange: null,
    macroContext: null,
    atr15m: new Decimal('0.5'),
  } as any;
}

describe('Scenario17: Killzone Session Sweep (Judas Swing)', () => {
  let scenario: Scenario17_JudasSwing;

  beforeEach(() => {
    Scenario17_JudasSwing.resetStats();
    scenario = new Scenario17_JudasSwing(mockConfig);
  });

  describe('mode guard', () => {
    it('fails closed when Sniper Mode drives 1m closes', () => {
      const sniper = new Scenario17_JudasSwing({
        ...mockConfig,
        enableSniperMode: true,
      });

      expect(sniper.evaluate(buildPatternData())).toBe(false);
      expect(sniper.getReason()).toMatch(/Classic 15m-only/);
      expect(Scenario17_JudasSwing.getRejectionStats().wrongMode).toBe(1);
    });

    it('fails closed on a non-15m execution timeframe', () => {
      const fiveMin = new Scenario17_JudasSwing({
        ...mockConfig,
        ltfTimeframe: '5',
      });

      expect(fiveMin.evaluate(buildPatternData())).toBe(false);
      expect(Scenario17_JudasSwing.getRejectionStats().wrongMode).toBe(1);
    });
  });

  describe('killzone', () => {
    it('rejects the ASIAN session even though it is a killzone', () => {
      expect(scenario.evaluate(buildPatternData({ killzone: 'ASIAN' }))).toBe(
        false,
      );
      expect(scenario.getReason()).toContain('London or NY');
      expect(Scenario17_JudasSwing.getRejectionStats().notInKillzone).toBe(1);
    });

    it('rejects outside every session', () => {
      expect(scenario.evaluate(buildPatternData({ killzone: 'NONE' }))).toBe(
        false,
      );
      expect(Scenario17_JudasSwing.getRejectionStats().notInKillzone).toBe(1);
    });

    it('accepts the NY killzone', () => {
      expect(scenario.evaluate(buildPatternData({ killzone: 'NY' }))).toBe(true);
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypass = new Scenario17_JudasSwing({
        ...mockConfig,
        enforceKillzones: false,
      });

      expect(bypass.evaluate(buildPatternData({ killzone: 'NONE' }))).toBe(true);
    });
  });

  describe('Asian range selection', () => {
    it('rejects when no session range exists', () => {
      expect(scenario.evaluate(buildPatternData({ ranges: [] }))).toBe(false);
      expect(scenario.getReason()).toContain('No COMPLETED Asian session');
      expect(Scenario17_JudasSwing.getRejectionStats().noAsianRange).toBe(1);
    });

    it('rejects a stale range (older than 24h)', () => {
      const stale = asianRange({
        start: ASIAN_START - 25 * 60 * 60 * 1000,
        end: ASIAN_END - 25 * 60 * 60 * 1000,
      });

      expect(scenario.evaluate(buildPatternData({ ranges: [stale] }))).toBe(
        false,
      );
      expect(Scenario17_JudasSwing.getRejectionStats().noAsianRange).toBe(1);
    });

    it('skips the still-forming session that shares the trigger NY date', () => {
      // Trigger at 20:15 NY — inside the Asian window. The only range starts at
      // 20:00 the same NY day, so it is partial context, not a finished range.
      const bypass = new Scenario17_JudasSwing({
        ...mockConfig,
        enforceKillzones: false,
      });
      const forming = asianRange({
        start: FORMING_START,
        end: FORMING_START,
      });

      expect(
        bypass.evaluate(
          buildPatternData({
            ranges: [forming],
            triggerTs: FORMING_TRIGGER_TS,
          }),
        ),
      ).toBe(false);
      expect(bypass.getReason()).toContain('No COMPLETED Asian session');
      expect(Scenario17_JudasSwing.getRejectionStats().noAsianRange).toBe(1);
    });

    it('falls back to the previous completed session when a newer one is forming', () => {
      const bypass = new Scenario17_JudasSwing({
        ...mockConfig,
        enforceKillzones: false,
      });
      const forming = asianRange({
        start: FORMING_START,
        end: FORMING_START,
      });

      // The completed range ended 20h30m before the trigger — still fresh.
      expect(
        bypass.evaluate(
          buildPatternData({
            ranges: [asianRange(), forming],
            triggerTs: FORMING_TRIGGER_TS,
          }),
        ),
      ).toBe(true);
    });
  });

  describe('session SFP', () => {
    it('triggers on a bearish Asian-high sweep', () => {
      const result = scenario.evaluate(buildPatternData());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Judas Swing');
      expect(scenario.getReason()).toContain('BEARISH');

      const levels = scenario.getLevels();
      // Entry is the sweep candle's close — never an invented better price.
      expect(levels.entry.toString()).toBe('104');
      // SL = pierced wick high (106) + 0.5 × atr15m (0.25).
      expect(levels.stopLoss.toString()).toBe('106.25');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
      // Fixed 3R fallback: 104 − 3 × 2.25.
      expect(levels.takeProfit.toString()).toBe('97.25');
    });

    it('triggers on a bullish Asian-low sweep', () => {
      expect(
        scenario.evaluate(buildPatternData({ direction: 'BULLISH' })),
      ).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.entry.toString()).toBe('95.8');
      // SL = wick low (94) − 0.5 × atr15m (0.25).
      expect(levels.stopLoss.toString()).toBe('93.75');
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('rejects a close back OUTSIDE the Asian high (breakout, not SFP)', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, SWEEP_INDEX, TRIGGER_TS, {
        open: '104',
        high: '106',
        low: '103.8',
        close: '105.5', // closed ABOVE 105 → breakout
        volume: '3000',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('did not sweep');
      expect(Scenario17_JudasSwing.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a candle that only touches the level without piercing it', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, SWEEP_INDEX, TRIGGER_TS, {
        high: '105', // equal, not greater
        low: '102.8',
        close: '104',
        volume: '3000',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(Scenario17_JudasSwing.getRejectionStats().noSweep).toBe(1);
    });

    it('ignores an older sweep: the entry must be the trigger candle itself', () => {
      const data = buildPatternData({ sweepIndex: SWEEP_INDEX - 4 });
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, SWEEP_INDEX, TRIGGER_TS);

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('did not sweep');
      expect(Scenario17_JudasSwing.getRejectionStats().noSweep).toBe(1);
    });

    it('resolves a two-sided sweep by the deeper penetration', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, SWEEP_INDEX, TRIGGER_TS, {
        open: '100',
        high: '106', // 1.0 above the Asian high
        low: '93', // 2.0 below the Asian low → deeper
        close: '100',
        volume: '3000',
      });

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getStructureDetails()?.direction).toBe('BULLISH');
      expect(scenario.getStructureDetails()?.price.toString()).toBe('93');
    });

    it('resolves an exact two-sided tie as BEARISH', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, SWEEP_INDEX, TRIGGER_TS, {
        open: '100',
        high: '106', // 1.0 above
        low: '94', // 1.0 below
        close: '100',
        volume: '3000',
      });

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getStructureDetails()?.direction).toBe('BEARISH');
    });
  });

  describe('volume admission (ratio 1.0)', () => {
    it('accepts exactly the 20-candle average', () => {
      expect(
        scenario.evaluate(buildPatternData({ sweepVolume: '1000' })),
      ).toBe(true);
    });

    it('rejects below the average', () => {
      expect(
        scenario.evaluate(buildPatternData({ sweepVolume: '999' })),
      ).toBe(false);
      expect(scenario.getReason()).toContain('Sweep volume');
      expect(Scenario17_JudasSwing.getRejectionStats().lowVolume).toBe(1);
    });

    it('excludes the sweep candle from its own baseline', () => {
      // Exclusive baseline = 1000.00. An inclusive average would print
      // (20×1000 + 900)/21 = 990.48 and lower the bar it is judging.
      expect(
        scenario.evaluate(buildPatternData({ sweepVolume: '900' })),
      ).toBe(false);
      expect(scenario.getReason()).toContain('1000.00');
      expect(scenario.getReason()).not.toContain('990.48');
    });

    it('fails closed when the sweep volume is missing', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = {
        ...data.candles15m[SWEEP_INDEX],
        volume: undefined,
      };

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('missing/unparseable');
      expect(Scenario17_JudasSwing.getRejectionStats().lowVolume).toBe(1);
    });

    it('fails closed when the baseline volume is zero', () => {
      const data = buildPatternData();
      data.candles15m = data.candles15m.map((c: any, i: number) =>
        i === SWEEP_INDEX ? c : { ...c, volume: '0' },
      );

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('unusable');
      expect(Scenario17_JudasSwing.getRejectionStats().lowVolume).toBe(1);
    });

    it('rejects when the volume baseline cannot be built', () => {
      expect(scenario.evaluate(buildPatternData({ candleCount: 20 }))).toBe(
        false,
      );
      expect(
        Scenario17_JudasSwing.getRejectionStats().insufficientCandles,
      ).toBe(1);
    });
  });

  describe('ghost signal protection', () => {
    it('burns the sweep candle as a SWEEP structure and never a zone', () => {
      expect(scenario.evaluate(buildPatternData())).toBe(true);

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('SWEEP');
      expect(structure?.timestamp).toBe(TRIGGER_TS);
      expect(structure?.direction).toBe('BEARISH');
      expect(structure?.price.toString()).toBe('106');

      // Invariant 21: session liquidity is never burned as a zone.
      expect(scenario.getZoneDetails()).toBeNull();
    });
  });

  describe('take-profit resolution', () => {
    it('uses a structural target when dynamic TP is enabled', () => {
      const dynamic = new Scenario17_JudasSwing({
        ...mockConfig,
        enableDynamicTp: true,
      });
      const data = buildPatternData({
        dynamicTp: true,
        extraPools: [{ type: 'EQL', price: '100' }],
      });

      expect(dynamic.evaluate(data)).toBe(true);
      // 4.0 / 2.25 = 1.78R — above the 1.5R floor.
      expect(dynamic.getLevels().takeProfit.toString()).toBe('100');
    });

    it('rejects when a MAJOR pool leaves less than minRr of room', () => {
      const dynamic = new Scenario17_JudasSwing({
        ...mockConfig,
        enableDynamicTp: true,
      });
      // EQL 103 = 1.0 / 2.25 = 0.44R — a real wall, not internal noise.
      const data = buildPatternData({
        extraPools: [{ type: 'EQL', price: '103' }],
      });

      expect(dynamic.evaluate(data)).toBe(false);
      expect(dynamic.getReason()).toContain('Take-profit rejected');
      expect(Scenario17_JudasSwing.getRejectionStats().tpInvalid).toBe(1);
    });
  });

  describe('stop geometry', () => {
    it('honours SMC_SL_ATR_OFFSET when sizing the volatility buffer', () => {
      // 106 + 3 × 0.5 = 107.5 — the buffer is configurable, not hardcoded.
      const wide = new Scenario17_JudasSwing({
        ...mockConfig,
        smcSlAtrOffset: '3',
      });

      expect(wide.evaluate(buildPatternData())).toBe(true);
      expect(wide.getLevels().stopLoss.toString()).toBe('107.5');
    });

    it('degrades to the 0.1% floor when atr15m is unusable', () => {
      const noAtr = buildPatternData();
      noAtr.atr15m = undefined;

      expect(scenario.evaluate(noAtr)).toBe(true);
      const levels = scenario.getLevels();
      expect(levels.stopLoss.toString()).toBe('106.104');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });
});
