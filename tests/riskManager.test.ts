import { RiskManager } from '../src/risk/riskManager';
import { Decimal } from 'decimal.js';
import { InstrumentInfo, TradeRecord } from '../src/types';

describe('RiskManager', () => {
  let riskManager: RiskManager;
  let mockBalanceSource: { getUsdtBalance: jest.Mock };
  let mockHistorySource: { getRecentClosedTrades: jest.Mock };
  const mockInstrument: InstrumentInfo = {
    symbol: 'SOLUSDT',
    tickSize: '0.01',
    qtyStep: '1',
    minOrderQty: '1',
    maxOrderQty: '1000000',
  };

  beforeEach(() => {
    mockBalanceSource = { getUsdtBalance: jest.fn().mockResolvedValue(new Decimal('10000')) };
    mockHistorySource = { getRecentClosedTrades: jest.fn().mockResolvedValue([]) };
    
    riskManager = new RiskManager(mockBalanceSource, mockHistorySource, {
      baseRiskPercent: '2',
      reducedRiskPercent: '1',
      leverage: '10',
      maxWorkingCapital: 0,
    preflightBufferPct: "0.05",
    });
  });

  describe('calculatePosition', () => {
    it('should return ok=true for valid position with qty >= minOrderQty', async () => {
      const result = await riskManager.calculatePosition({
        symbol: 'SOLUSDT',
        side: 'Buy',
        entryPrice: new Decimal('100'),
        stopLossRaw: new Decimal('99'),
        takeProfitRaw: new Decimal('103'),
        instrument: mockInstrument,
        zoneDetails: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Number(result.plan.qty)).toBeGreaterThanOrEqual(1);
      }
    });

    it('should return QtyTooSmall error when rounded qty < minOrderQty', async () => {
      // Very small balance, large SL distance = tiny qty
      mockBalanceSource.getUsdtBalance.mockResolvedValue(new Decimal('10'));
      
      const result = await riskManager.calculatePosition({
        symbol: 'SOLUSDT',
        side: 'Buy',
        entryPrice: new Decimal('100'),
        stopLossRaw: new Decimal('50'), // 50% SL distance
        takeProfitRaw: new Decimal('250'),
        instrument: mockInstrument,
        zoneDetails: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('rounded qty');
        expect(result.reason).toContain('minOrderQty');
        expect(result.reason).toContain('trade aborted');
      }
    });

    it('should return error for minOrderQty = 0.001 (BTC-like) when qty rounds down to 0', async () => {
      const btcInstrument: InstrumentInfo = {
        symbol: 'BTCUSDT',
        tickSize: '0.1',
        qtyStep: '0.001',
        minOrderQty: '0.001',
        maxOrderQty: '1000',
      };
      
      // Small balance, large SL distance = qty rounds to 0
      mockBalanceSource.getUsdtBalance.mockResolvedValue(new Decimal('10'));
      
      const result = await riskManager.calculatePosition({
        symbol: 'BTCUSDT',
        side: 'Buy',
        entryPrice: new Decimal('50000'),
        stopLossRaw: new Decimal('25000'), // 50% SL distance
        takeProfitRaw: new Decimal('125000'),
        instrument: btcInstrument,
        zoneDetails: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('minOrderQty');
      }
    });

    it('should apply reduced risk percent after 3 consecutive losing trades', async () => {
      // Mock 3 losing trades
      mockHistorySource.getRecentClosedTrades.mockResolvedValue([
        { pnl: '-100' } as TradeRecord,
        { pnl: '-50' } as TradeRecord,
        { pnl: '-200' } as TradeRecord,
      ]);

      const result = await riskManager.calculatePosition({
        symbol: 'SOLUSDT',
        side: 'Buy',
        entryPrice: new Decimal('100'),
        stopLossRaw: new Decimal('99'),
        takeProfitRaw: new Decimal('103'),
        instrument: mockInstrument,
        zoneDetails: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan.riskPercentApplied).toBe('1'); // Reduced to 1%
      }
    });

    it('should return error for invalid SL (entry <= SL for long)', async () => {
      const result = await riskManager.calculatePosition({
        symbol: 'SOLUSDT',
        side: 'Buy',
        entryPrice: new Decimal('100'),
        stopLossRaw: new Decimal('101'), // SL above entry for long
        takeProfitRaw: new Decimal('97'),
        instrument: mockInstrument,
        zoneDetails: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('invalid SL level');
      }
    });

    it('should return error for invalid SL (entry >= SL for short)', async () => {
      const result = await riskManager.calculatePosition({
        symbol: 'SOLUSDT',
        side: 'Sell',
        entryPrice: new Decimal('100'),
        stopLossRaw: new Decimal('99'), // SL below entry for short
        takeProfitRaw: new Decimal('97'),
        instrument: mockInstrument,
        zoneDetails: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('invalid SL level');
      }
    });
  });
});