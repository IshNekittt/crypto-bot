import { Scenario5_HTFLiquiditySweep } from '../../src/engine/scenarios/Scenario5_HTFLiquiditySweep';
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
  activeScenarios: [5],
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

const BASE_TS = 1788675600000; // London killzone
const LTF_MS = 15 * 60 * 1000;
const CANDLE_COUNT = 30;
/** The sweep must be the LAST closed candle — there is no lookback window. */
const SWEEP_INDEX = CANDLE_COUNT - 1;
const BASE_VOLUME = '1000';

function candle(index: number, overrides: Record<string, string> = {}) {
  return {
    timestamp: BASE_TS + index * LTF_MS,
    open: '102.6',
    high: '103.2',
    low: '102.4',
    close: '103',
    volume: BASE_VOLUME,
    ...overrides,
  };
}

function pool(type: string, price: string) {
  return {
    type,
    priceLevel: new Decimal(price),
    points: [],
    isTaken: false,
    timestamp: BASE_TS - LTF_MS,
  };
}

interface FixtureOptions {
  readonly direction?: 'BULLISH' | 'BEARISH';
  readonly sweepIndex?: number;
  /** Volume of the sweep candle (baseline is a flat 1000). */
  readonly sweepVolume?: string;
  readonly extraPools?: Array<{ type: string; price: string }>;
  readonly killzone?: string;
  readonly candleCount?: number;
}

/**
 * Builds a 30-candle 15m series whose LAST candle is the SFP:
 *
 *  - Short: PDH 105 → wick to 106, close 104 (volume must expand).
 *  - Long : PDL  95 → wick to  94, close 95.8.
 *
 * Every preceding candle is deliberately neutral (high 103.2 / low 102.4) so it
 * can neither sweep PDH nor PDL.
 */
function buildPatternData(options: FixtureOptions = {}) {
  const direction = options.direction ?? 'BEARISH';
  const candleCount = options.candleCount ?? CANDLE_COUNT;
  // Default the sweep to the LAST candle of whatever series is requested. Using
  // the fixed SWEEP_INDEX with a shorter `candleCount` would assign past the end
  // of the array, producing a SPARSE series whose holes the volume baseline must
  // never silently average over.
  const sweepIndex = options.sweepIndex ?? candleCount - 1;

  const candles = Array.from({ length: candleCount }, (_, i) => candle(i));

  if (direction === 'BEARISH') {
    candles[sweepIndex] = candle(sweepIndex, {
      open: '103',
      high: '106',
      low: '102.8',
      close: '104',
      volume: options.sweepVolume ?? '2000',
    });
  } else {
    candles[sweepIndex] = candle(sweepIndex, {
      open: '96',
      high: '96.2',
      low: '94',
      close: '95.8',
      volume: options.sweepVolume ?? '2000',
    });
  }

  const levelType = direction === 'BEARISH' ? 'PDH' : 'PDL';
  const levelPrice = direction === 'BEARISH' ? '105' : '95';

  const pools = [pool(levelType, levelPrice)];
  for (const extra of options.extraPools ?? []) {
    pools.push(pool(extra.type, extra.price));
  }

  return {
    currentKillzone: options.killzone ?? 'LONDON',
    currentSession: 'LONDON',
    candles15m: candles,
    // Structure/FVG arrays are intentionally populated: the volume-confirmed SFP
    // path must never consult them again.
    structures: [],
    zones: [],
    liquidityPools: pools,
    atr15m: new Decimal('0.5'),
    currentSession_: undefined,
  } as any;
}

describe('Scenario5: HTF Liquidity Sweep (volume-confirmed SFP)', () => {
  let scenario: Scenario5_HTFLiquiditySweep;

  beforeEach(() => {
    Scenario5_HTFLiquiditySweep.resetStats();
    scenario = new Scenario5_HTFLiquiditySweep(mockConfig);
  });

  describe('mode guard (audit F-03)', () => {
    it('fails closed when Sniper Mode drives 1m closes', () => {
      const sniper = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        enableSniperMode: true,
      });

      expect(sniper.evaluate(buildPatternData())).toBe(false);
      expect(sniper.getReason()).toMatch(/requires Classic mode/);
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().wrongMode).toBe(1);
    });

    it('fails closed below the 5-minute Classic minimum', () => {
      const oneMin = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        ltfTimeframe: '1',
      });

      expect(oneMin.evaluate(buildPatternData())).toBe(false);
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().wrongMode).toBe(1);
    });

    it('matches tagged consumed sweeps to the configured LTF, preserving untagged records', () => {
      const hourly = new Scenario5_HTFLiquiditySweep({ ...mockConfig, ltfTimeframe: '60' });
      const data = buildPatternData();
      const timestamp = data.candles15m.at(-1)!.timestamp;
      const consumed = { type: 'SWEEP', timestamp, direction: 'BULLISH', price: '100' };
      data.mitigatedStructures = [{ ...consumed, timeframe: '15' }];
      expect(hourly.evaluate(data)).toBe(true);
      data.mitigatedStructures = [{ ...consumed, timeframe: '60' }];
      expect(hourly.evaluate(data)).toBe(false);
      data.mitigatedStructures = [consumed];
      expect(hourly.evaluate(data)).toBe(false);
    });
  });

  describe('killzone', () => {
    it('rejects outside London/NY', () => {
      expect(scenario.evaluate(buildPatternData({ killzone: 'ASIAN' }))).toBe(
        false,
      );
      expect(scenario.getReason()).toContain('London or NY killzone');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().killzone).toBe(1);
    });

    it('accepts the NY killzone', () => {
      expect(scenario.evaluate(buildPatternData({ killzone: 'NY' }))).toBe(true);
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypass = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        enforceKillzones: false,
      });

      expect(bypass.evaluate(buildPatternData({ killzone: 'NONE' }))).toBe(true);
    });
  });

  describe('volume-confirmed SFP — positive cases', () => {
    it('triggers on a bearish PDH sweep confirmed by volume', () => {
      const data = buildPatternData();
      const result = scenario.evaluate(data);

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('HTF Liquidity Sweep');
      expect(scenario.getReason()).toContain('PDH');
      expect(scenario.getReason()).toContain('BEARISH SFP');

      const levels = scenario.getLevels();
      // Entry is the sweep candle's close — never an invented better price.
      expect(levels.entry.toString()).toBe('104');
      // SL = pierced wick high (106) + 0.5 × atr15m (0.5 × 0.5 = 0.25).
      expect(levels.stopLoss.toString()).toBe('106.25');
      expect(levels.stopLoss.gt(new Decimal('106'))).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);
      // Fixed 3R fallback: 104 − 3 × 2.25.
      expect(levels.takeProfit.toString()).toBe('97.25');
    });

    it('triggers on a bullish PDL sweep confirmed by volume', () => {
      const result = scenario.evaluate(buildPatternData({ direction: 'BULLISH' }));

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('PDL');
      expect(scenario.getReason()).toContain('BULLISH SFP');

      const levels = scenario.getLevels();
      expect(levels.entry.toString()).toBe('95.8');
      // SL = wick low (94) − 0.5 × atr15m (0.25).
      expect(levels.stopLoss.toString()).toBe('93.75');
      expect(levels.stopLoss.lt(new Decimal('94'))).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('reports the sweep timestamp in the reason', () => {
      expect(scenario.evaluate(buildPatternData())).toBe(true);

      expect(scenario.getReason()).toContain(
        `swept at ${BASE_TS + SWEEP_INDEX * LTF_MS}`,
      );
    });

    it('burns the sweep candle as a SWEEP structure (macro pools stay tradable)', () => {
      expect(scenario.evaluate(buildPatternData())).toBe(true);

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('SWEEP');
      expect(structure?.timestamp).toBe(BASE_TS + SWEEP_INDEX * LTF_MS);
      expect(structure?.direction).toBe('BEARISH');
      // 106 — the pierced extreme is the invalidation reference.
      expect(structure?.price.toString()).toBe('106');

      // Invariant 21: PDH/PDL/PWH/PWL are never burned as zones.
      expect(scenario.getZoneDetails()).toBeNull();
    });

    it('does not require any CHoCH or FVG to be present', () => {
      const data = buildPatternData();
      expect(data.structures).toEqual([]);
      expect(data.zones).toEqual([]);

      expect(scenario.evaluate(data)).toBe(true);
    });

    it('increments the triggered counter', () => {
      expect(scenario.evaluate(buildPatternData())).toBe(true);
      const stats = Scenario5_HTFLiquiditySweep.getRejectionStats();
      expect(stats.triggered).toBe(1);
      expect(stats.totalEvals).toBe(1);
    });
  });

  describe('volume confirmation (Zvezdin rule)', () => {
    it('accepts exactly 1.3x the baseline', () => {
      expect(
        scenario.evaluate(buildPatternData({ sweepVolume: '1300' })),
      ).toBe(true);
    });

    it('rejects a sweep below 1.3x the baseline', () => {
      expect(
        scenario.evaluate(buildPatternData({ sweepVolume: '1299' })),
      ).toBe(false);

      expect(scenario.getReason()).toContain('institutional volume expansion');
      expect(
        Scenario5_HTFLiquiditySweep.getRejectionStats().lowVolumeSweep,
      ).toBe(1);
    });

    it('measures the baseline against the 20 candles BEFORE the sweep candle', () => {
      // Baseline = flat 1000, so the hurdle is exactly 1300.00. An inclusive
      // average would print 1.3 × (20×1000 + 1250)/21 = 1315.48 and quietly
      // raise the bar with the very expansion it is judging.
      expect(
        scenario.evaluate(buildPatternData({ sweepVolume: '1250' })),
      ).toBe(false);

      expect(scenario.getReason()).toContain('1300.00');
      expect(scenario.getReason()).not.toContain('1315');
    });

    it('honours a stricter SMC_SWEEP_VOLUME_MULTIPLIER', () => {
      const strict = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        sweepVolumeMultiplier: new Decimal('2.5'),
      });

      expect(strict.evaluate(buildPatternData({ sweepVolume: '2000' }))).toBe(
        false,
      );
      expect(strict.getReason()).toContain('2.5x baseline');

      expect(strict.evaluate(buildPatternData({ sweepVolume: '2500' }))).toBe(
        true,
      );
    });

    it('honours a looser SMC_SWEEP_VOLUME_MULTIPLIER', () => {
      const loose = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        sweepVolumeMultiplier: new Decimal('1.1'),
      });

      expect(loose.evaluate(buildPatternData({ sweepVolume: '1150' }))).toBe(
        true,
      );
    });

    it('falls back to 1.3x when the multiplier is not configured', () => {
      const unset = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        sweepVolumeMultiplier: undefined as unknown as Decimal,
      });

      // 1200 < 1.3 × 1000 → rejected by the default gate.
      expect(unset.evaluate(buildPatternData({ sweepVolume: '1200' }))).toBe(
        false,
      );
      expect(unset.getReason()).toContain('1.3x baseline');
    });

    it('fails closed when the sweep candle volume is missing', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = {
        ...data.candles15m[SWEEP_INDEX],
        volume: undefined,
      };

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('missing/unparseable');
    });

    it('fails closed when the baseline volume is zero', () => {
      const data = buildPatternData();
      data.candles15m = data.candles15m.map((c: any, i: number) =>
        i === SWEEP_INDEX ? c : { ...c, volume: '0' },
      );

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('unusable');
    });
  });

  describe('negative cases — sweep detection', () => {
    it('rejects when the candle closes back OUTSIDE the level (breakout, not SFP)', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        open: '104',
        high: '106',
        low: '103.8',
        close: '105.5', // closed ABOVE PDH 105 → breakout
        volume: '3000',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No SFP');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects a candle that only touches the level without piercing it', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        high: '105', // equal, not greater
        low: '102.8',
        close: '104',
        volume: '3000',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No SFP');
    });

    it('ignores an older sweep: the entry must be the sweep candle itself', () => {
      const data = buildPatternData({ sweepIndex: SWEEP_INDEX - 4 });
      // The last candle is neutral again, so the SFP is four bars stale.
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX);

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No SFP');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().noSweep).toBe(1);
    });

    it('rejects when no HTF pool exists', () => {
      const data = buildPatternData();
      data.liquidityPools = [pool('EQH', '105')];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No HTF liquidity pools');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().noPools).toBe(1);
    });

    it('rejects when the volume baseline cannot be built', () => {
      const result = scenario.evaluate(
        buildPatternData({ candleCount: 20 }), // 20 candles → 19 of baseline
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('volume baseline');
      expect(
        Scenario5_HTFLiquiditySweep.getRejectionStats().insufficientCandles,
      ).toBe(1);
    });
  });

  describe('deterministic pool ranking', () => {
    it('picks PDH over PDL when one candle sweeps both', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        open: '100',
        high: '106',
        low: '94',
        close: '100',
        volume: '3000',
      });
      data.liquidityPools = [pool('PDL', '95'), pool('PDH', '105')];

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getReason()).toContain('PDH');
      expect(scenario.getReason()).not.toContain('PDL');
      expect(scenario.getStructureDetails()?.direction).toBe('BEARISH');
    });

    it('picks PWH over PWL when one candle sweeps both', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        open: '100',
        high: '116',
        low: '84',
        close: '100',
        volume: '3000',
      });
      data.liquidityPools = [pool('PWL', '85'), pool('PWH', '115')];

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getReason()).toContain('PWH');
      expect(scenario.getReason()).toContain('BEARISH SFP');
    });

    it('trades the low-side pool when only the low is swept', () => {
      const data = buildPatternData();
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        open: '96',
        high: '96.4',
        low: '94',
        close: '95.6',
        volume: '3000',
      });
      data.liquidityPools = [pool('PDL', '95'), pool('PDH', '105')];

      expect(scenario.evaluate(data)).toBe(true);
      expect(scenario.getReason()).toContain('PDL');
      expect(scenario.getStructureDetails()?.direction).toBe('BULLISH');
    });
  });

  describe('stop geometry', () => {
    it('keeps the stop strictly beyond the sweep wick — short', () => {
      expect(scenario.evaluate(buildPatternData())).toBe(true);

      const levels = scenario.getLevels();
      const wickHigh = new Decimal('106');
      expect(levels.stopLoss.gt(wickHigh)).toBe(true);
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });

    it('keeps the stop strictly beyond the sweep wick — long', () => {
      expect(scenario.evaluate(buildPatternData({ direction: 'BULLISH' }))).toBe(
        true,
      );

      const levels = scenario.getLevels();
      const wickLow = new Decimal('94');
      expect(levels.stopLoss.lt(wickLow)).toBe(true);
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('pushes the stop 0.5 × atr15m beyond the pierced wick', () => {
      // atr15m = 0.5 → buffer 0.25, so the short stop sits at 106 + 0.25.
      expect(scenario.evaluate(buildPatternData())).toBe(true);
      expect(scenario.getLevels().stopLoss.toString()).toBe('106.25');

      expect(
        scenario.evaluate(buildPatternData({ direction: 'BULLISH' })),
      ).toBe(true);
      expect(scenario.getLevels().stopLoss.toString()).toBe('93.75');
    });

    it('honours SMC_SL_ATR_OFFSET when sizing the volatility buffer', () => {
      // 106 + 3 × 0.5 = 107.5 — the buffer is configurable, not hardcoded.
      const wide = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        smcSlAtrOffset: '3',
      });

      expect(wide.evaluate(buildPatternData())).toBe(true);
      expect(wide.getLevels().stopLoss.toString()).toBe('107.5');
    });

    it('degrades to the 0.1% floor when atr15m is unusable', () => {
      // A missing ATR must never collapse the stop onto the wick: the floor is
      // still applied, so the stop stays on the correct side of the entry.
      const noAtr = buildPatternData();
      noAtr.atr15m = undefined;

      expect(scenario.evaluate(noAtr)).toBe(true);
      const levels = scenario.getLevels();
      expect(levels.stopLoss.toString()).toBe('106.104');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });

  describe('take-profit resolution', () => {
    it('snaps to the nearest structural pool when dynamic TP is enabled', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        enableDynamicTp: true,
      });
      const data = buildPatternData({ extraPools: [{ type: 'EQL', price: '100' }] });

      expect(dynamic.evaluate(data)).toBe(true);
      // 4.0 / 2.25 = 1.78R — above the 1.5R floor.
      expect(dynamic.getLevels().takeProfit.toString()).toBe('100');
    });

    it('steps over a minor obstacle that cannot clear the R floor', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        enableDynamicTp: true,
      });
      // SSL 102 = 0.89R is a single swing (minor) → skipped; EQL 99 = 2.22R
      // is a genuine pool and becomes the target.
      const data = buildPatternData({
        extraPools: [
          { type: 'SSL', price: '102' },
          { type: 'EQL', price: '99' },
        ],
      });

      expect(dynamic.evaluate(data)).toBe(true);
      expect(dynamic.getLevels().takeProfit.toString()).toBe('99');
    });

    it('rejects when a MAJOR pool leaves less than minRr of room', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        enableDynamicTp: true,
      });
      // EQL 103 is equal-highs liquidity (major): 1.0 / 2.25 = 0.44R. It is a
      // real wall, so the resolver rejects instead of drilling through it.
      const data = buildPatternData({ extraPools: [{ type: 'EQL', price: '103' }] });

      expect(dynamic.evaluate(data)).toBe(false);
      expect(dynamic.getReason()).toContain('Take-profit rejected');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().tpInvalid).toBe(1);
    });

    it('clamps an over-extended structural target to DYNAMIC_TP_MAX_RR', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        enableDynamicTp: true,
      });
      // 24 / 2.25 = 10.67R → clamped to 6R = 104 − 13.5.
      const data = buildPatternData({ extraPools: [{ type: 'EQL', price: '80' }] });

      expect(dynamic.evaluate(data)).toBe(true);
      expect(dynamic.getLevels().takeProfit.toString()).toBe('90.5');
    });
  });

  describe('fee-inclusive Net R:R floor', () => {
    it('rejects a geometry that is only positive before fees', () => {
      // 1R fixed target: (2.25 − 0.1144) / (2.25 + 0.1144) = 0.90 < 1.0.
      const thin = new Scenario5_HTFLiquiditySweep({
        ...mockConfig,
        fixedTpRr: new Decimal(1),
        dynamicTpMinRr: new Decimal(1),
      });

      expect(thin.evaluate(buildPatternData())).toBe(false);
      expect(thin.getReason()).toContain('Net R:R');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().tpInvalid).toBe(1);
    });

    it('accepts a 3R geometry that clears the floor after fees', () => {
      // 104-entry: (6.75 − 0.1144) / (2.25 + 0.1144) = 2.81 ≥ 1.5.
      expect(scenario.evaluate(buildPatternData())).toBe(true);
    });
  });
});
