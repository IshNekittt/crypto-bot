import { Decimal } from 'decimal.js';
import { Scenario14_QuantAlpha } from '../../src/engine/scenarios/Scenario14_QuantAlpha';
import { BotConfig } from '../../src/config/env';
import { Candle } from '../../src/types';

const BASE = 1_780_000_000_000;
const MIN15 = 15 * 60 * 1000;
const config: BotConfig = {
  apiKey: '', apiSecret: '', testnet: false, demoTrading: true,
  symbols: [], riskPercent: '2', reducedRiskPercent: '1', leverage: '10',
  dataDir: 'data', historyCandles: 200, ltfTimeframe: '15', htfTimeframe: '240',
  macroCandles: 1000, telegramBotToken: null, telegramChatId: null, databaseUrl: null,
  autoTrading: false, tradeApprovalTimeoutMinutes: 5, enableLiveTestOrders: false,
  activeScenarios: [14], enableFundingMonitor: false, fundingMonitorSymbols: [],
  fundingAlertThresholdPct: '0', fundingRestoreThresholdPct: '0.0001', symbolScenarios: new Map(),
  backtestCsvPath: null, cooldownCandles: 16, smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5', sniperDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6, sniperLimitExpirationCandles: 15,
  smcSweepMinWickRatio: new Decimal('0.25'), smartEntryThresholdPct: '0.0015',
  sweepVolumeMultiplier: new Decimal('1.5'),
  preflightBufferPct: '0.05', enableSniperMode: false, enableDynamicTp: true,
  fixedTpRr: new Decimal(4), dynamicTpMinRr: new Decimal('2'),
  dynamicTpMaxRr: new Decimal(6), dynamicTpRequireTarget: false,
  minNetRr: new Decimal(1), minVolatilityFeeRatio: new Decimal(1),
  minTpDistancePct: new Decimal('0.0035'), backtestDays: 180, useLocalCacheOnly: false,
  maxWorkingCapital: 0, enableHealthcheckServer: false,
  allowedDaysOfWeek: [1, 2, 3, 4, 5, 6, 7], enforceKillzones: false,
  enableTradeNotifications: true,
};

function candle(index: number, close: number, volume = 10): Candle {
  return {
    timestamp: BASE + index * MIN15,
    open: close.toFixed(8), high: (close + 1).toFixed(8),
    low: (close - 1).toFixed(8), close: close.toFixed(8),
    volume: volume.toFixed(8),
  };
}

function candles15m(direction: 'long' | 'short', breakoutVolume = 20): Candle[] {
  const candles = Array.from({ length: 21 }, (_, i) => candle(i, 100, 10));
  candles[20] = candle(20, direction === 'long' ? 105 : 95, breakoutVolume);
  return candles;
}

function candles4h(direction: 'long' | 'short' = 'long'): Candle[] {
  return Array.from({ length: 21 }, (_, i) => {
    const c = candle(i, 100, 10);
    return { ...c, high: direction === 'short' ? '98' : '104', low: '96' };
  });
}

function pattern(c15: Candle[], c4 = candles4h(), atr = new Decimal('2')): any {
  const pools = [
    { type: 'PWH' as const, priceLevel: new Decimal(130), points: [], isTaken: false, timestamp: BASE },
    { type: 'PWL' as const, priceLevel: new Decimal(70), points: [], isTaken: false, timestamp: BASE },
  ];
  return {
    candles15m: c15, candles4h: c4, atr15m: atr, atr4h: atr,
    zones: [], liquidityPools: pools,
    macroContext: {
      ath: new Decimal(200), atl: new Decimal(1), htfFvgs: [], htfObs: [], liquidityPools: pools,
      weeklyLevels: { pwh: new Decimal(130), pwl: new Decimal(70), wo: new Decimal(100) },
      dailyLevels: { pdh: new Decimal(120), pdl: new Decimal(80), do: new Decimal(100) },
    },
    sessionRanges: [], tradingRange: null,
  };
}

function scenario(overrides: Partial<BotConfig> = {}): Scenario14_QuantAlpha {
  return new Scenario14_QuantAlpha({ ...config, ...overrides });
}

describe('Scenario14_QuantAlpha — Donchian / volume breakout', () => {
  beforeEach(() => Scenario14_QuantAlpha.resetStats());

  describe('mode guard (audit F-03)', () => {
    it('fails closed when Sniper Mode drives 1m closes', () => {
      const sut = scenario({ enableSniperMode: true });

      expect(sut.evaluate(pattern(candles15m('long')))).toBe(false);
      expect(sut.getReason()).toMatch(/requires Classic mode/);
      expect(Scenario14_QuantAlpha.getRejectionStats().wrongMode).toBe(1);
    });

    it('fails closed below the 5-minute Classic minimum', () => {
      const sut = scenario({ ltfTimeframe: '3' });

      expect(sut.evaluate(pattern(candles15m('long')))).toBe(false);
      expect(Scenario14_QuantAlpha.getRejectionStats().wrongMode).toBe(1);
    });
  });

  it('triggers bullish with a 2ATR stop and 4R target', () => {
    const sut = scenario();
    expect(sut.evaluate(pattern(candles15m('long')))).toBe(true);
    const levels = sut.getLevels();
    expect(levels.entry.minus(levels.stopLoss)).toEqual(new Decimal('4'));
    expect(levels.takeProfit.minus(levels.entry).gte(new Decimal('10'))).toBe(true);
    expect(sut.getStructureDetails()?.type).toBe('BOS');
    expect(sut.getZoneDetails()).toBeNull();
    expect(sut.getStructureDetails()?.timestamp).toBe(BASE + 20 * MIN15);
  });

  it('triggers bearish channel breakout', () => {
    const sut = scenario();
    expect(sut.evaluate(pattern(candles15m('short'), candles4h('short')))).toBe(true);
    const levels = sut.getLevels();
    expect(levels.stopLoss.minus(levels.entry)).toEqual(new Decimal('4'));
    expect(levels.entry.minus(levels.takeProfit).gte(new Decimal('10'))).toBe(true);
  });

  it('rejects a close inside the Donchian range', () => {
    const sut = scenario();
    const candles = candles15m('long');
    candles[20] = candle(20, 104, 20);
    expect(sut.evaluate(pattern(candles))).toBe(false);
    expect(sut.getReason()).toBe('Price inside Donchian range');
    expect(Scenario14_QuantAlpha.getRejectionStats().insideChannel).toBe(1);
  });

  it('rejects volume below 1.3x SMA-20', () => {
    const sut = scenario();
    expect(sut.evaluate(pattern(candles15m('long', 12.9)))).toBe(false);
    expect(Scenario14_QuantAlpha.getRejectionStats().lowVolumeBreakout).toBe(1);
  });

  it('requires 21 confirmed bars in both timeframes', () => {
    const sut = scenario();
    expect(sut.evaluate(pattern(candles15m('long').slice(-5), candles4h().slice(-5)))).toBe(false);
    expect(Scenario14_QuantAlpha.getRejectionStats().insufficientCandles).toBe(1);
  });

  it('rejects targets below 2.5R', () => {
    const sut = scenario({ dynamicTpMinRr: new Decimal('5') });
    expect(sut.evaluate(pattern(candles15m('long')))).toBe(false);
    expect(Scenario14_QuantAlpha.getRejectionStats().tpInvalid).toBe(1);
  });

  it('skips a 1.6R minor pool and targets the next valid barrier at exactly 2.5R', () => {
    const sut = scenario({ dynamicTpMinRr: new Decimal('1.5') });
    const data = pattern(candles15m('long')); // entry 105, risk 4
    data.liquidityPools = [
      { type: 'BSL', priceLevel: new Decimal('111.4'), isTaken: false },
      { type: 'EQH', priceLevel: new Decimal(115), isTaken: false },
    ];
    expect(sut.evaluate(data)).toBe(true);
    expect(sut.getLevels().takeProfit.eq(115)).toBe(true);
    data.mitigatedStructures = [sut.getStructureDetails()];
    expect(sut.evaluate(data)).toBe(false);
    expect(Scenario14_QuantAlpha.getRejectionStats().consumedBreakout).toBe(1);
  });

  it('uses fixed 2ATR stop despite a different SMC offset', () => {
    const sut = scenario({ smcSlAtrOffset: '0.25' });
    expect(sut.evaluate(pattern(candles15m('long'), candles4h(), new Decimal('3')))).toBe(true);
    expect(sut.getLevels().entry.minus(sut.getLevels().stopLoss)).toEqual(new Decimal('6'));
  });

  it('does not mutate source candle arrays', () => {
    const c15 = candles15m('long');
    const c4 = candles4h();
    const before15 = c15.map(c => ({ ...c }));
    const before4 = c4.map(c => ({ ...c }));
    scenario().evaluate(pattern(c15, c4));
    expect(c15).toEqual(before15);
    expect(c4).toEqual(before4);
  });

  it('reports all funnel counters', () => {
    scenario().evaluate(pattern(candles15m('long').slice(0, 5)));
    const insideCandles = candles15m('long');
    insideCandles[20] = candle(20, 104, 20);
    scenario().evaluate(pattern(insideCandles));
    const stats = Scenario14_QuantAlpha.getRejectionStats();
    expect(stats.totalEvals).toBe(2);
    expect(stats.insufficientCandles).toBe(1);
    expect(stats.insideChannel).toBe(1);
  });
});
