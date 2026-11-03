import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../src/config/env';
import { Candle } from '../../../../src/types';
import { Scenario16_AtrExhaustionReversal } from '../../../../src/engine/scenarios/archive/legacy_smc/Scenario16_AtrExhaustionReversal';

const BASE = Date.UTC(2026, 0, 1);
const TF_MS = 15 * 60 * 1000;

const config: BotConfig = {
  apiKey: '', apiSecret: '', testnet: false, demoTrading: true,
  symbols: [], riskPercent: '2', reducedRiskPercent: '1', leverage: '10',
  dataDir: 'data', historyCandles: 200, ltfTimeframe: '15', htfTimeframe: '240',
  macroCandles: 1000, telegramBotToken: null, telegramChatId: null, databaseUrl: null,
  autoTrading: false, tradeApprovalTimeoutMinutes: 5, enableLiveTestOrders: false,
  activeScenarios: [16], enableFundingMonitor: false, fundingMonitorSymbols: [],
  fundingAlertThresholdPct: '0', fundingRestoreThresholdPct: '0.0001', symbolScenarios: new Map(),
  backtestCsvPath: null, cooldownCandles: 16, smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5', sniperDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6, sniperLimitExpirationCandles: 15,
  smcSweepMinWickRatio: new Decimal('0.25'), smartEntryThresholdPct: '0.0015',
  sweepVolumeMultiplier: new Decimal('1.5'),
  preflightBufferPct: '0.05', enableSniperMode: false, enableDynamicTp: false,
  fixedTpRr: new Decimal(3), dynamicTpMinRr: new Decimal('1.5'),
  dynamicTpMaxRr: new Decimal(6), dynamicTpRequireTarget: false,
  minNetRr: new Decimal(1), minVolatilityFeeRatio: new Decimal(1),
  minTpDistancePct: new Decimal('0.0035'), backtestDays: 180, useLocalCacheOnly: false,
  maxWorkingCapital: 0, enableHealthcheckServer: false,
  allowedDaysOfWeek: [1, 2, 3, 4, 5, 6, 7], enforceKillzones: false,
  enableTradeNotifications: true,
};

function candle(index: number, close: number, range = 0.1, volume = '1'): Candle {
  return {
    timestamp: BASE + index * TF_MS,
    open: String(close),
    high: String(close + range),
    low: String(close - range),
    close: String(close),
    volume,
  };
}

/** 41 compressed candles at 100 followed by one expansion candle. */
function expansion(triggerClose: number, triggerVolume = '5'): Candle[] {
  const candles = Array.from({ length: 41 }, (_, index) => candle(index, 100));
  candles.push(candle(41, triggerClose, 0.1, triggerVolume));
  return candles;
}

function pattern(candles15m: Candle[], atr4h = '1', atr15m = '1'): any {
  return {
    candles15m,
    candles4h: [candle(0, 100)],
    zones: [],
    liquidityPools: [],
    macroContext: {},
    sessionRanges: [],
    tradingRange: null,
    atr15m: new Decimal(atr15m),
    atr4h: new Decimal(atr4h),
  };
}

describe('Scenario16_AtrExhaustionReversal', () => {
  beforeEach(() => Scenario16_AtrExhaustionReversal.resetStats());

  it('fades a downside expansion out of a squeeze (Buy) with a base-anchored stop', () => {
    const candles = expansion(95);
    const sut = new Scenario16_AtrExhaustionReversal(config);

    expect(sut.evaluate(pattern(candles))).toBe(true);
    const levels = sut.getLevels();
    expect(levels.entry.eq(95)).toBe(true);
    // Squeeze base low 99.9 is above entry; the long stop must sit BELOW entry.
    expect(levels.stopLoss.eq(new Decimal('94.5'))).toBe(true);
    expect(levels.takeProfit.eq(new Decimal('96.5'))).toBe(true);
    expect(sut.getStructureDetails()).toMatchObject({
      type: 'CHoCH',
      timestamp: candles[candles.length - 1].timestamp,
      direction: 'BULLISH',
    });
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().triggered).toBe(1);
  });

  it('fades an upside expansion out of a squeeze (Sell) with mirrored geometry', () => {
    const candles = expansion(105);
    const sut = new Scenario16_AtrExhaustionReversal(config);

    expect(sut.evaluate(pattern(candles))).toBe(true);
    const levels = sut.getLevels();
    expect(levels.stopLoss.eq(new Decimal('105.5'))).toBe(true);
    expect(levels.takeProfit.eq(new Decimal('103.5'))).toBe(true);
    expect(sut.getStructureDetails()?.direction).toBe('BEARISH');
  });

  it('uses the 4H ATR exhaustion floor, not the 15m ATR', () => {
    const sut = new Scenario16_AtrExhaustionReversal(config);
    // Swing is 5.2; 1.0 x ATR4H = 100 → exhausted only by the 4H reference.
    expect(sut.evaluate(pattern(expansion(95), '100'))).toBe(false);
    expect(sut.getReason()).toMatch(/20-candle swing/);
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().noExhaustion).toBe(1);
  });

  it('rejects a breakout without a preceding compression', () => {
    const candles = Array.from({ length: 42 }, (_, index) => candle(index, 100 + index));
    const sut = new Scenario16_AtrExhaustionReversal(config);

    expect(sut.evaluate(pattern(candles))).toBe(false);
    expect(sut.getReason()).toMatch(/first expansion/);
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().noSqueeze).toBe(1);
  });

  it('rejects a breakout whose volume does not clear the SMA20 baseline', () => {
    const sut = new Scenario16_AtrExhaustionReversal(config);

    expect(sut.evaluate(pattern(expansion(95, '1')))).toBe(false);
    expect(sut.getReason()).toMatch(/Breakout volume/);
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().lowVolume).toBe(1);
  });

  it('fails closed outside Classic 15m mode', () => {
    const sut = new Scenario16_AtrExhaustionReversal({ ...config, enableSniperMode: true });

    expect(sut.evaluate(pattern(expansion(95)))).toBe(false);
    expect(sut.getReason()).toMatch(/Classic 15m-only/);
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().wrongMode).toBe(1);
  });

  it('rejects a close sitting exactly at the middle of the exhaustion window', () => {
    const candles = Array.from({ length: 42 }, (_, index) => candle(index, 100));
    const sut = new Scenario16_AtrExhaustionReversal(config);

    // ATR4H is deliberately tiny so the 0.2-wide swing clears the exhaustion
    // floor and the direction gate is the first thing the close can fail.
    expect(sut.evaluate(pattern(candles, '0.01'))).toBe(false);
    expect(sut.getReason()).toMatch(/middle of the exhaustion window/);
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().ambiguousDirection).toBe(1);
  });

  it('requires a full 20-candle swing and 20-candle volume baseline', () => {
    const candles = Array.from({ length: 20 }, (_, index) => candle(index, 100));
    const sut = new Scenario16_AtrExhaustionReversal(config);

    expect(sut.evaluate(pattern(candles))).toBe(false);
    expect(sut.getReason()).toMatch(/Requires at least 41/);
    expect(Scenario16_AtrExhaustionReversal.getRejectionStats().insufficientCandles).toBe(1);
  });
});
