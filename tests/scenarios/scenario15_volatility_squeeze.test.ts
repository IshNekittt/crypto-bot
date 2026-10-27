import { Decimal } from 'decimal.js';
import { BotConfig } from '../../src/config/env';
import { Candle } from '../../src/types';
import { Scenario15_VolatilitySqueeze } from '../../src/engine/scenarios/Scenario15_VolatilitySqueeze';

const BASE = Date.UTC(2026, 0, 1);
const TF_MS = 15 * 60 * 1000;

const config: BotConfig = {
  apiKey: '', apiSecret: '', testnet: false, demoTrading: true,
  symbols: [], riskPercent: '2', reducedRiskPercent: '1', leverage: '10',
  dataDir: 'data', historyCandles: 200, ltfTimeframe: '15', htfTimeframe: '240',
  macroCandles: 1000, telegramBotToken: null, telegramChatId: null, databaseUrl: null,
  autoTrading: false, tradeApprovalTimeoutMinutes: 5, enableLiveTestOrders: false,
  activeScenarios: [15], enableFundingMonitor: false, fundingMonitorSymbols: [],
  fundingAlertThresholdPct: '0', fundingRestoreThresholdPct: '0.0001', symbolScenarios: new Map(),
  backtestCsvPath: null, cooldownCandles: 16, smcSlAtrOffset: '0.5',
  smcDisplacementMultiplier: '1.5', sniperDisplacementMultiplier: '1.5',
  limitExpirationCandles: 6, sniperLimitExpirationCandles: 15,
  smcSweepMinWickRatio: new Decimal('0.25'), smartEntryThresholdPct: '0.0015',
  preflightBufferPct: '0.05', enableSniperMode: false, enableDynamicTp: false,
  fixedTpRr: new Decimal(3), dynamicTpMinRr: new Decimal('1.5'),
  dynamicTpMaxRr: new Decimal(6), dynamicTpRequireTarget: false,
  minNetRr: new Decimal(1), minVolatilityFeeRatio: new Decimal(1),
  minTpDistancePct: new Decimal('0.0035'), backtestDays: 180, useLocalCacheOnly: false,
  maxWorkingCapital: 0, enableHealthcheckServer: false,
  allowedDaysOfWeek: [1, 2, 3, 4, 5, 6, 7], enforceKillzones: false,
  enableTradeNotifications: true,
};

function candle(index: number, close: number, range = 0.1): Candle {
  return {
    timestamp: BASE + index * TF_MS,
    open: String(close),
    high: String(close + range),
    low: String(close - range),
    close: String(close),
    volume: '1',
  };
}

function pattern(candles15m: Candle[]): any {
  return {
    candles15m,
    candles4h: [],
    zones: [],
    liquidityPools: [],
    macroContext: {},
    sessionRanges: [],
    tradingRange: null,
  };
}

describe('Scenario15_VolatilitySqueeze', () => {
  beforeEach(() => Scenario15_VolatilitySqueeze.resetStats());

  it('opens a bullish first expansion with a midline/1.5ATR stop and 3R fallback', () => {
    const candles = Array.from({ length: 25 }, (_, index) => candle(index, 100));
    candles.push(candle(25, 120));
    const sut = new Scenario15_VolatilitySqueeze(config);

    expect(sut.evaluate(pattern(candles))).toBe(true);
    const levels = sut.getLevels();
    expect(levels.entry.eq(120)).toBe(true);
    expect(levels.stopLoss.lt(100)).toBe(true);
    expect(levels.takeProfit.gt(levels.entry)).toBe(true);
    expect(sut.getStructureDetails()?.timestamp).toBe(candles[25].timestamp);
    expect(sut.getStructureDetails()?.direction).toBe('BULLISH');
  });

  it('opens a bearish first expansion with mirrored stop and target', () => {
    const candles = Array.from({ length: 25 }, (_, index) => candle(index, 100));
    candles.push(candle(25, 80));
    const sut = new Scenario15_VolatilitySqueeze(config);

    expect(sut.evaluate(pattern(candles))).toBe(true);
    const levels = sut.getLevels();
    expect(levels.stopLoss.gt(100)).toBe(true);
    expect(levels.takeProfit.lt(levels.entry)).toBe(true);
    expect(sut.getStructureDetails()?.direction).toBe('BEARISH');
  });

  it('fails closed outside Classic 15m mode', () => {
    const candles = [...Array.from({ length: 25 }, (_, index) => candle(index, 100)), candle(25, 120)];
    const sut = new Scenario15_VolatilitySqueeze({ ...config, enableSniperMode: true });

    expect(sut.evaluate(pattern(candles))).toBe(false);
    expect(sut.getReason()).toMatch(/Classic Mode on 15m/);
    expect(Scenario15_VolatilitySqueeze.getRejectionStats().wrongMode).toBe(1);
  });

  it('rejects candles without a qualifying squeeze firing', () => {
    const candles = Array.from({ length: 30 }, (_, index) => candle(index, 100 + index * 0.2, 0.1));
    const sut = new Scenario15_VolatilitySqueeze(config);

    expect(sut.evaluate(pattern(candles))).toBe(false);
    expect(sut.getReason()).toMatch(/No first BB expansion/);
  });

  it('uses tpResolver and rejects structurally insufficient target room', () => {
    const candles = Array.from({ length: 25 }, (_, index) => candle(index, 100));
    candles.push(candle(25, 120));
    const sut = new Scenario15_VolatilitySqueeze({
      ...config,
      enableDynamicTp: true,
      dynamicTpMinRr: new Decimal('20'),
    });

    const data = pattern(candles);
    data.liquidityPools = [
      { type: 'PWH', priceLevel: new Decimal('121'), points: [], isTaken: false, timestamp: BASE },
    ];
    expect(sut.evaluate(data)).toBe(false);
    expect(sut.getReason()).toMatch(/Take-profit rejected/);
  });
});
