import { Decimal } from 'decimal.js';
import { BaseScenario } from '../src/engine/baseScenario';
import { BotConfig } from '../src/config/env';

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

/**
 * Stub scenario exercising the BaseScenario evaluation contract.
 * `mode` drives what the concrete logic does:
 *  - 'full'  → sets levels + zoneDetails + structureDetails, returns true
 *  - 'bare'  → returns true WITHOUT setting anything (ghost-tagging path)
 *  - 'reject'→ returns false without setting anything
 */
class StubScenario extends BaseScenario {
  constructor(private mode: 'full' | 'bare' | 'reject') {
    super(99, 'Stub', mockConfig);
  }

  protected override evaluateInternal(_patternData: any): boolean {
    if (this.mode === 'reject') return false;
    if (this.mode === 'full') {
      this.setLevels({
        entry: new Decimal(100),
        stopLoss: new Decimal(99),
        takeProfit: new Decimal(103),
      });
      this.setZoneDetails({
        type: 'OB',
        top: new Decimal(101),
        bottom: new Decimal(99),
        timeframe: '15',
        direction: 'BULLISH',
        timestamp: 1,
      });
      this.setStructureDetails({
        type: 'CHoCH',
        timestamp: 1,
        price: new Decimal(100),
        direction: 'BULLISH',
      });
    }
    return true;
  }
}

describe('BaseScenario — per-evaluation state reset (no bleed)', () => {
  it('does not leak levels/zoneDetails/structureDetails into a later evaluation', () => {
    // The same scenario instance is reused across symbols for the process lifetime.
    const scenario = new StubScenario('full');

    expect(scenario.evaluate({})).toBe(true);
    expect(scenario.getLevels().entry.toString()).toBe('100');
    expect(scenario.getZoneDetails()).not.toBeNull();
    expect(scenario.getStructureDetails()).not.toBeNull();

    // A subsequent true-path that sets nothing must NOT inherit the old details.
    (scenario as any).mode = 'bare';
    expect(scenario.evaluate({})).toBe(true);
    expect(scenario.getLevels().entry.toString()).toBe('0');
    expect(scenario.getZoneDetails()).toBeNull();
    expect(scenario.getStructureDetails()).toBeNull();

    // A rejection must also clear everything (no stale ghost tagging).
    (scenario as any).mode = 'full';
    expect(scenario.evaluate({})).toBe(true);
    expect(scenario.getZoneDetails()).not.toBeNull();

    (scenario as any).mode = 'reject';
    expect(scenario.evaluate({})).toBe(false);
    expect(scenario.getLevels().entry.toString()).toBe('0');
    expect(scenario.getZoneDetails()).toBeNull();
    expect(scenario.getStructureDetails()).toBeNull();
  });
});
