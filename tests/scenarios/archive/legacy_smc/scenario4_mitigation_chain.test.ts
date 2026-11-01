import { Scenario4_MitigationChain } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario4_MitigationChain';
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
    preflightBufferPct: "0.05",
    enableHealthcheckServer: false,
    allowedDaysOfWeek: [1, 2, 3, 4, 5],
    enforceKillzones: true,
    enableTradeNotifications: true,
};

const LTF_MS = 15 * 60 * 1000;
const CANDLE_COUNT = 60;
const LAST_INDEX = CANDLE_COUNT - 1;
const T0 = 1_788_652_800_000;

const indexTimestamp = (index: number): number => T0 + index * LTF_MS;

/** The mitigated block whose defence starts the chain. */
const BASE_INDEX = 10;
/** The candle that trades into the base block and closes back on the origin side. */
const BOUNCE_INDEX = 15;
/** The block the BOS created — the actual entry POI. */
const CONTINUATION_INDEX = 18;
/** The break of structure that validates the defence. */
const BOS_INDEX = 20;

interface ChainFixtureOptions {
  readonly direction?: 'BULLISH' | 'BEARISH';
  /** Dealing-range equilibrium returned by the mocked recognizer. */
  readonly pdEquilibrium?: string;
  readonly withBounce?: boolean;
  readonly withBos?: boolean;
  readonly bosIndex?: number;
  readonly bosDirection?: 'BULLISH' | 'BEARISH';
  readonly bosTimeframe?: string;
  readonly withContinuationOb?: boolean;
  readonly baseTop?: string;
  readonly baseBottom?: string;
  readonly baseIndex?: number;
  readonly extraBaseOb?: Record<string, unknown>;
  readonly current?: { open?: string; high: string; low: string; close: string };
}

/**
 * Scenario 4 fixture.
 *
 * Chain: demand block 98 → 100 formed at `BASE_INDEX`, defended at
 * `BOUNCE_INDEX` (wick into the block, close back above it), a 15m BOS at
 * `BOS_INDEX`, and a NEW block 104 → 106 created by that break. The current
 * candle returns to the new block's equilibrium (105) — that retest is the entry.
 */
const createChainPattern = (options: ChainFixtureOptions = {}) => {
  const direction = options.direction ?? 'BULLISH';
  const isLong = direction === 'BULLISH';
  const baseTop = options.baseTop ?? '100';
  const baseBottom = options.baseBottom ?? '98';

  // Everything above the base block: high 103 / low 101 never touches 98 → 100.
  const candles15m: any[] = [];
  for (let i = 0; i < CANDLE_COUNT; i++) {
    candles15m.push({
      timestamp: indexTimestamp(i),
      open: '102',
      high: '103',
      low: '101',
      close: '102',
      volume: '1000',
    });
  }

  if (options.withBounce !== false) {
    candles15m[BOUNCE_INDEX] = {
      timestamp: indexTimestamp(BOUNCE_INDEX),
      open: '99',
      high: isLong ? '101' : '100.5',
      low: isLong ? '97.5' : '97',
      close: isLong ? '100.5' : '97.5',
      volume: '1000',
    };
  }

  const current = options.current ?? {
    open: '105',
    high: isLong ? '105.5' : '95.5',
    low: isLong ? '104.5' : '94.5',
    close: isLong ? '105.2' : '94.8',
  };
  candles15m[LAST_INDEX] = {
    timestamp: indexTimestamp(LAST_INDEX),
    open: current.open ?? current.close,
    high: current.high,
    low: current.low,
    close: current.close,
    volume: '1000',
  };

  const baseOb = {
    type: 'OB' as const,
    direction,
    top: new Decimal(baseTop),
    bottom: new Decimal(baseBottom),
    timestamp: indexTimestamp(options.baseIndex ?? BASE_INDEX),
    mitigated: false,
    timeframe: '15',
  };

  const zones: any[] = [baseOb];
  if (options.withContinuationOb !== false) {
    zones.push({
      type: 'OB' as const,
      direction,
      top: new Decimal(isLong ? '106' : '96'),
      bottom: new Decimal(isLong ? '104' : '94'),
      timestamp: indexTimestamp(CONTINUATION_INDEX),
      mitigated: false,
      timeframe: '15',
    });
  }
  if (options.extraBaseOb) {
    zones.push(options.extraBaseOb);
  }

  const structures: any[] = [];
  if (options.withBos !== false) {
    structures.push({
      type: 'BOS' as const,
      direction: options.bosDirection ?? direction,
      price: new Decimal(isLong ? '105' : '95'),
      timestamp: indexTimestamp(options.bosIndex ?? BOS_INDEX),
      timeframe: options.bosTimeframe ?? '15',
      isValidated: true,
      impulseFactor: new Decimal('2.0'),
    });
  }

  return {
    currentKillzone: 'LONDON' as const,
    currentSession: 'LONDON' as const,
    candles15m,
    zones,
    structures,
    liquidityPools: [],
    atr15m: new Decimal('0.5'),
    patternRecognizer: {
      config: { wickRatioThreshold: new Decimal('0.4') },
      calculatePremiumDiscount: () => ({
        // A demand block must sit in Discount, a supply block in Premium.
        equilibrium: new Decimal(options.pdEquilibrium ?? (isLong ? '110' : '90')),
        rangeHigh: new Decimal('120'),
        rangeLow: new Decimal('80'),
        isPremium: !isLong,
        isDiscount: isLong,
      }),
    } as any,
  };
};

describe('Scenario4: Mitigation Chain', () => {
  let scenario: Scenario4_MitigationChain;

  beforeEach(() => {
    Scenario4_MitigationChain.resetStats();
    scenario = new Scenario4_MitigationChain(mockConfig);
  });

  describe('bidirectional execution', () => {
    it('triggers a LONG: mitigated demand → BOS → retest of the new block', () => {
      const result = scenario.evaluate(createChainPattern());

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('BULLISH OB mitigated');
      expect(scenario.getReason()).toContain('BOS after bounce');
      expect(scenario.getReason()).toContain('new OB 0.5 retest');

      // entry = NEW block equilibrium (105). The stop sits below the block bottom
      // and below the retest wick, minus the 0.5 × ATR offset (0.25).
      const levels = scenario.getLevels();
      expect(levels.entry.toFixed(2)).toBe('105.00');
      expect(levels.stopLoss.toFixed(2)).toBe('103.75');
      expect(levels.takeProfit.toFixed(2)).toBe('108.75');

      // The burned POI is the continuation block, not the already-mitigated one.
      const zone = scenario.getZoneDetails();
      expect(zone?.type).toBe('OB');
      expect(zone?.direction).toBe('BULLISH');
      expect(zone?.timestamp).toBe(indexTimestamp(CONTINUATION_INDEX));
      expect(zone?.top.toFixed(2)).toBe('106.00');
      expect(zone?.bottom.toFixed(2)).toBe('104.00');

      // The burn anchor is the BOS that validated the defence.
      const structure = scenario.getStructureDetails();
      expect(structure?.type).toBe('BOS');
      expect(structure?.timestamp).toBe(indexTimestamp(BOS_INDEX));
      expect(structure?.direction).toBe('BULLISH');
    });

    it('triggers a SHORT: mitigated supply → BOS → retest of the new block', () => {
      const result = scenario.evaluate(createChainPattern({ direction: 'BEARISH' }));

      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('BEARISH OB mitigated');

      const levels = scenario.getLevels();
      expect(levels.entry.toFixed(2)).toBe('95.00');
      expect(levels.stopLoss.toFixed(2)).toBe('96.25');
      expect(levels.takeProfit.toFixed(2)).toBe('91.25');
      expect(levels.stopLoss.gt(levels.entry)).toBe(true);
      expect(levels.takeProfit.lt(levels.entry)).toBe(true);

      expect(scenario.getZoneDetails()?.direction).toBe('BEARISH');
      expect(scenario.getZoneDetails()?.timestamp).toBe(
        indexTimestamp(CONTINUATION_INDEX),
      );
    });

    it('ignores a 4H OB (the mitigation chain is a 15m structure)', () => {
      const data = createChainPattern();
      data.zones[0].timeframe = '240';
      data.zones[1].timeframe = '240';

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m Order Block available');
    });
  });

  describe('killzone', () => {
    it('rejects when the killzone is NONE', () => {
      const data = createChainPattern();
      (data as any).currentKillzone = 'NONE';

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
      expect(Scenario4_MitigationChain.getRejectionStats().killzone).toBe(1);
    });
  });

  describe('preconditions', () => {
    it('rejects when no 15m candles are available', () => {
      const data = createChainPattern();
      data.candles15m = [];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m candle available');
    });

    it('rejects when no 15m OB exists', () => {
      const data = createChainPattern();
      data.zones = [];

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe('No 15m Order Block available');
      expect(Scenario4_MitigationChain.getRejectionStats().noValidOb).toBe(1);
    });
  });

  describe('premium / discount positioning', () => {
    it('rejects a demand block sitting in Premium', () => {
      const data = createChainPattern({ pdEquilibrium: '90' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('BULLISH OB not in Discount zone');
      expect(Scenario4_MitigationChain.getRejectionStats().premiumDiscount).toBe(1);
    });

    it('rejects a supply block sitting in Discount', () => {
      const data = createChainPattern({
        direction: 'BEARISH',
        pdEquilibrium: '110',
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('BEARISH OB not in Premium zone');
    });

    it('skips the check when the recognizer is unavailable', () => {
      const data = createChainPattern();
      delete (data as any).patternRecognizer;

      expect(scenario.evaluate(data)).toBe(true);
    });
  });

  describe('mitigation (bounce) gate', () => {
    it('rejects a block that was never defended', () => {
      const data = createChainPattern({ withBounce: false });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('was never mitigated');
      expect(Scenario4_MitigationChain.getRejectionStats().noBounce).toBe(1);
    });

    it('does not count a candle that closes INSIDE the block as a defence', () => {
      // Closing inside the zone is mitigation OF the zone (it was consumed), not
      // a bounce off it. Without this distinction a broken block validates its
      // own continuation.
      const data = createChainPattern();
      data.candles15m[BOUNCE_INDEX] = {
        timestamp: indexTimestamp(BOUNCE_INDEX),
        open: '99',
        high: '101',
        low: '97.5',
        close: '99',
        volume: '1000',
      };

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('was never mitigated');
    });

    it('cannot use the block\'s own candle as its bounce', () => {
      const data = createChainPattern({ withBounce: false });
      data.candles15m[BASE_INDEX] = {
        timestamp: indexTimestamp(BASE_INDEX),
        open: '99',
        high: '101',
        low: '97.5',
        close: '100.5',
        volume: '1000',
      };

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('was never mitigated');
    });
  });

  describe('break of structure gate', () => {
    it('rejects when no BOS follows the bounce', () => {
      const data = createChainPattern({ withBos: false });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe(
        'No 15m BULLISH BOS after the OB bounce within 24h',
      );
      expect(Scenario4_MitigationChain.getRejectionStats().noBos).toBe(1);
    });

    it('rejects a BOS printed before the bounce', () => {
      // A break that happened before the defence describes a different leg.
      const data = createChainPattern({ bosIndex: BOUNCE_INDEX - 1 });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe(
        'No 15m BULLISH BOS after the OB bounce within 24h',
      );
    });

    it('rejects a BOS in the opposite direction', () => {
      const data = createChainPattern({ bosDirection: 'BEARISH' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No 15m BULLISH BOS after the OB bounce');
    });

    it('rejects a 4H BOS (the chain is confirmed on the entry timeframe)', () => {
      const data = createChainPattern({ bosTimeframe: '240' });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No 15m BULLISH BOS after the OB bounce');
    });

    it('rejects a BOS older than the 24h mitigation window', () => {
      const data = createChainPattern();
      // Move the bounce far back so the BOS falls outside its 24h window.
      data.candles15m[BOUNCE_INDEX] = {
        timestamp: indexTimestamp(BOUNCE_INDEX),
        open: '102',
        high: '103',
        low: '101',
        close: '102',
        volume: '1000',
      };
      const lateBounce = 21; // after the BOS at 20
      data.candles15m[lateBounce] = {
        timestamp: indexTimestamp(lateBounce),
        open: '99',
        high: '101',
        low: '97.5',
        close: '100.5',
        volume: '1000',
      };

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain('No 15m BULLISH BOS after the OB bounce');
    });
  });

  describe('continuation block retest', () => {
    it('rejects when price has not returned to the new block equilibrium', () => {
      const data = createChainPattern({
        current: { open: '108.5', high: '109', low: '108', close: '108.5' },
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toContain(
        'Price has not returned to the new 15m BULLISH OB equilibrium',
      );
      expect(Scenario4_MitigationChain.getRejectionStats().noRetest).toBe(1);
    });

    it('falls back to the mitigated block when the break created no new zone', () => {
      const data = createChainPattern({
        withContinuationOb: false,
        current: { open: '99', high: '100', low: '98', close: '99.5' },
      });

      expect(scenario.evaluate(data)).toBe(true);
      // entry = the BASE block equilibrium (99), and it is the base block that
      // gets burned — there is no continuation POI to record.
      expect(scenario.getLevels().entry.toFixed(2)).toBe('99.00');
      expect(scenario.getLevels().stopLoss.toFixed(2)).toBe('97.75');
      expect(scenario.getLevels().takeProfit.toFixed(2)).toBe('102.75');
      expect(scenario.getZoneDetails()?.timestamp).toBe(indexTimestamp(BASE_INDEX));
    });

    it('prefers the freshest block formed before the BOS', () => {
      // A block printed AFTER the BOS cannot be the block that BOS created.
      const data = createChainPattern({
        extraBaseOb: {
          type: 'OB' as const,
          direction: 'BULLISH' as const,
          top: new Decimal('99'),
          bottom: new Decimal('97'),
          timestamp: indexTimestamp(BOS_INDEX + 5),
          mitigated: false,
          timeframe: '15',
        },
        current: { open: '98', high: '99', low: '97', close: '98.2' },
      });

      expect(scenario.evaluate(data)).toBe(false);
      // The post-BOS block cannot be selected, so the retest target stays 105.
      expect(scenario.getReason()).toContain('OB equilibrium (105.0000)');
    });
  });

  describe('deepest-stage funnel', () => {
    it('reports the furthest link reached, not the freshest block\'s first failure', () => {
      // A fresh demand block at 88 → 90 was never defended (stage 2), while the
      // older 98 → 100 block was defended but produced no BOS (stage 3). A
      // first-wins funnel would report `noBounce` and hide the missing break.
      const data = createChainPattern({
        withBos: false,
        extraBaseOb: {
          type: 'OB' as const,
          direction: 'BULLISH' as const,
          top: new Decimal('90'),
          bottom: new Decimal('88'),
          timestamp: indexTimestamp(30),
          mitigated: false,
          timeframe: '15',
        },
      });

      expect(scenario.evaluate(data)).toBe(false);
      expect(scenario.getReason()).toBe(
        'No 15m BULLISH BOS after the OB bounce within 24h',
      );
      expect(Scenario4_MitigationChain.getRejectionStats().noBos).toBe(1);
      expect(Scenario4_MitigationChain.getRejectionStats().noBounce).toBe(0);
    });
  });

  describe('stat isolation', () => {
    it('counts every evaluation and resets on demand', () => {
      scenario.evaluate(createChainPattern());
      scenario.evaluate(createChainPattern({ withBos: false }));
      expect(Scenario4_MitigationChain.getRejectionStats().totalEvals).toBe(2);

      Scenario4_MitigationChain.resetStats();
      expect(Scenario4_MitigationChain.getRejectionStats().totalEvals).toBe(0);
    });
  });
});
