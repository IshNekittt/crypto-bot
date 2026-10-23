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

const BASE_TS = 1788675600000; // London killzone
const LTF_MS = 15 * 60 * 1000;
const CANDLE_COUNT = 30;
const SWEEP_INDEX = 16;
const CHOCH_INDEX = 20;
const FVG_INDEX = 24;

function candle(index: number, overrides: Record<string, string> = {}) {
  return {
    timestamp: BASE_TS + index * LTF_MS,
    open: '102.6',
    high: '103.2',
    low: '102.4',
    close: '103',
    volume: '1000',
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
  readonly chochIndex?: number;
  readonly fvgIndex?: number;
  readonly displacement?: string;
  readonly withFvg?: boolean;
  readonly extraPools?: Array<{ type: string; price: string }>;
  readonly killzone?: string;
}

/**
 * Builds a 30-candle 15m series with a sweep, a CHoCH AFTER it and an FVG AFTER
 * the CHoCH — the exact causal chain Scenario 5 requires.
 *
 * Short fixture: PDH 105 swept by a wick to 106 closing back at 104.
 * Long fixture:  PDL 95 swept by a wick to 94 closing back at 95.8.
 */
function buildPatternData(options: FixtureOptions = {}) {
  const direction = options.direction ?? 'BEARISH';
  const sweepIndex = options.sweepIndex ?? SWEEP_INDEX;
  const chochIndex = options.chochIndex ?? CHOCH_INDEX;
  const fvgIndex = options.fvgIndex ?? FVG_INDEX;

  const candles = Array.from({ length: CANDLE_COUNT }, (_, i) => candle(i));

  if (direction === 'BEARISH') {
    candles[sweepIndex] = candle(sweepIndex, {
      open: '103',
      high: '106',
      low: '102.8',
      close: '104',
    });
  } else {
    candles[sweepIndex] = candle(sweepIndex, {
      open: '96',
      high: '96.2',
      low: '94',
      close: '95.8',
    });
  }

  const levelType = direction === 'BEARISH' ? 'PDH' : 'PDL';
  const levelPrice = direction === 'BEARISH' ? '105' : '95';

  const pools = [pool(levelType, levelPrice)];
  for (const extra of options.extraPools ?? []) {
    pools.push(pool(extra.type, extra.price));
  }

  const structures = [
    {
      type: 'CHOCH',
      direction,
      price: new Decimal(direction === 'BEARISH' ? 103 : 97),
      timestamp: candles[chochIndex].timestamp,
      isValidated: true,
      impulseFactor: new Decimal(options.displacement ?? '2.0'),
      timeframe: '15',
    },
  ];

  const zones = options.withFvg === false
    ? []
    : [
        direction === 'BEARISH'
          ? {
              type: 'FVG',
              direction,
              top: new Decimal(103),
              bottom: new Decimal(101),
              timestamp: candles[fvgIndex].timestamp,
              mitigated: false,
              timeframe: '15',
            }
          : {
              type: 'FVG',
              direction,
              top: new Decimal(97),
              bottom: new Decimal(95),
              timestamp: candles[fvgIndex].timestamp,
              mitigated: false,
              timeframe: '15',
            },
      ];

  return {
    currentKillzone: options.killzone ?? 'LONDON',
    currentSession: 'LONDON',
    candles15m: candles,
    structures,
    zones,
    liquidityPools: pools,
    atr15m: new Decimal('0.5'),
  } as any;
}

describe('Scenario5: HTF Liquidity Sweep', () => {
  let scenario: Scenario5_HTFLiquiditySweep;

  beforeEach(() => {
    Scenario5_HTFLiquiditySweep.resetStats();
    scenario = new Scenario5_HTFLiquiditySweep(mockConfig);
  });

  describe('positive cases', () => {
    it('triggers on a PDH sweep + CHoCH after the sweep + FVG (Short)', () => {
      const result = scenario.evaluate(buildPatternData({ direction: 'BEARISH' }));

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('HTF Liquidity Sweep');
      expect(scenario.getReason()).toContain('PDH');

      const levels = scenario.getLevels();
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);

      const zone = scenario.getZoneDetails();
      expect(zone?.type).toBe('FVG');
      expect(zone?.direction).toBe('BEARISH');

      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('CHoCH');
      expect(structure?.timestamp).toBe(BASE_TS + CHOCH_INDEX * LTF_MS);
      expect(structure?.direction).toBe('BEARISH');
    });

    it('triggers on a PDL sweep + BULLISH CHoCH + FVG (Long)', () => {
      const result = scenario.evaluate(buildPatternData({ direction: 'BULLISH' }));

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('PDL');

      const levels = scenario.getLevels();
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
      expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    });

    it('finds a sweep that happened several candles before the latest candle', () => {
      // Sweep 13 candles before the end — the legacy last-candle-only scan missed it.
      const result = scenario.evaluate(
        buildPatternData({ direction: 'BEARISH', sweepIndex: SWEEP_INDEX })
      );

      expect(result).toBe(true);
    });

    it('works in the NY killzone', () => {
      const result = scenario.evaluate(buildPatternData({ killzone: 'NY' }));
      expect(result).toBe(true);
    });

    it('bypasses the killzone gate when enforceKillzones=false', () => {
      const bypass = new Scenario5_HTFLiquiditySweep({ ...mockConfig, enforceKillzones: false });
      const result = bypass.evaluate(buildPatternData({ killzone: 'NONE' }));

      expect(result).toBe(true);
      expect(bypass.getReason()).toContain('HTF Liquidity Sweep');
    });
  });

  describe('negative cases - killzone', () => {
    it('rejects outside London/NY', () => {
      const result = scenario.evaluate(buildPatternData({ killzone: 'ASIAN' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('London or NY killzone');
    });
  });

  describe('negative cases - sweep', () => {
    it('rejects when the only sweep is older than the 16-candle window', () => {
      // Index 5 is 25 candles before the end → outside the 16-candle scan.
      const result = scenario.evaluate(buildPatternData({ sweepIndex: 5 }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No HTF liquidity sweep');
    });

    it('rejects when no HTF pool exists', () => {
      const data = buildPatternData();
      data.liquidityPools = [pool('EQH', '105')];

      const result = scenario.evaluate(data);

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No HTF liquidity pools');
    });
  });

  describe('negative cases - causality', () => {
    it('rejects a CHoCH that formed BEFORE the sweep', () => {
      const result = scenario.evaluate(
        buildPatternData({ chochIndex: SWEEP_INDEX - 4 })
      );

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No aggressive 15m CHoCH');
    });
  });

  describe('deterministic pool ranking', () => {
    it('picks PDH over PDL when one candle sweeps both', () => {
      const data = buildPatternData({ direction: 'BEARISH' });
      // Same candle pierces PDH (105) upward and PDL (95) downward.
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        open: '100',
        high: '106',
        low: '94',
        close: '100',
      });
      data.liquidityPools = [pool('PDL', '95'), pool('PDH', '105')];

      const result = scenario.evaluate(data);

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('PDH');
      expect(scenario.getReason()).not.toContain('PDL');
    });

    it('picks PWH over PWL when one candle sweeps both', () => {
      const data = buildPatternData({ direction: 'BEARISH' });
      data.candles15m[SWEEP_INDEX] = candle(SWEEP_INDEX, {
        open: '100',
        high: '116',
        low: '84',
        close: '100',
      });
      data.liquidityPools = [pool('PWL', '85'), pool('PWH', '115')];

      const result = scenario.evaluate(data);

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('PWH');
    });
  });

  describe('negative cases - CHoCH validation', () => {
    it('rejects when the CHoCH displacement is below 1.5 ATR', () => {
      const result = scenario.evaluate(buildPatternData({ displacement: '1.0' }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('displacement < 1.5 ATR');
    });
  });

  describe('negative cases - FVG', () => {
    it('rejects when no 15m FVG forms after the CHoCH', () => {
      const result = scenario.evaluate(buildPatternData({ withFvg: false }));

      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('No 15m FVG');
    });
  });

  describe('inverted FVG geometry', () => {
    it('keeps SL below entry for a Long even when top < bottom', () => {
      const data = buildPatternData({ direction: 'BULLISH' });
      data.zones = [
        {
          type: 'FVG',
          direction: 'BULLISH',
          top: new Decimal(95),
          bottom: new Decimal(97), // inverted
          timestamp: BASE_TS + FVG_INDEX * LTF_MS,
          mitigated: false,
          timeframe: '15',
        },
      ];

      expect(scenario.evaluate(data)).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.stopLoss.lt(levels.entry)).toBe(true);
    });

    it('keeps SL above entry for a Short even when top < bottom', () => {
      const data = buildPatternData({ direction: 'BEARISH' });
      data.zones = [
        {
          type: 'FVG',
          direction: 'BEARISH',
          top: new Decimal(101),
          bottom: new Decimal(103), // inverted
          timestamp: BASE_TS + FVG_INDEX * LTF_MS,
          mitigated: false,
          timeframe: '15',
        },
      ];

      expect(scenario.evaluate(data)).toBe(true);

      const levels = scenario.getLevels();
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
    });
  });

  describe('take-profit resolution', () => {
    it('keeps the fixed 3R target when dynamic TP is disabled', () => {
      expect(scenario.evaluate(buildPatternData())).toBe(true);

      const levels = scenario.getLevels();
      // entry 102, SL 103.25 → R = 1.25 → 3R = 98.25
      expect(levels.entry.toString()).toBe('102');
      expect(levels.stopLoss.toString()).toBe('103.25');
      expect(levels.takeProfit.toString()).toBe('98.25');
    });

    it('snaps to the nearest structural pool when dynamic TP is enabled', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({ ...mockConfig, enableDynamicTp: true });
      const data = buildPatternData({ extraPools: [{ type: 'EQL', price: '100' }] });

      expect(dynamic.evaluate(data)).toBe(true);
      // 100 is 2.0 / 1.25 = 1.6R away — above the 1.5R floor.
      expect(dynamic.getLevels().takeProfit.toString()).toBe('100');
    });

    it('rejects when the nearest pool leaves less than minRr of room', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({ ...mockConfig, enableDynamicTp: true });
      // 101 is 1.0 / 1.25 = 0.8R away — the wall filter must reject, not clamp.
      const data = buildPatternData({ extraPools: [{ type: 'EQL', price: '101' }] });

      expect(dynamic.evaluate(data)).toBe(false);
      expect(dynamic.getReason()).toContain('Take-profit rejected');
      expect(Scenario5_HTFLiquiditySweep.getRejectionStats().tpInvalid).toBe(1);
    });

    it('clamps an over-extended structural target to DYNAMIC_TP_MAX_RR', () => {
      const dynamic = new Scenario5_HTFLiquiditySweep({ ...mockConfig, enableDynamicTp: true });
      // 80 is 22 / 1.25 = 17.6R away → clamped to 6R = 102 - 7.5 = 94.5
      const data = buildPatternData({ extraPools: [{ type: 'EQL', price: '80' }] });

      expect(dynamic.evaluate(data)).toBe(true);
      expect(dynamic.getLevels().takeProfit.toString()).toBe('94.5');
    });
  });
});
