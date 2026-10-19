import { Decimal } from 'decimal.js';
import {
  evaluateTradeManagement,
  initializeTradeManagement,
  TradeContext,
} from '../src/risk/tradeManager';
import { InstrumentInfo, TradeManagementState } from '../src/types';

describe('Adaptive Fractioning — evaluateTradeManagement', () => {
  const instrument: InstrumentInfo = {
    symbol: 'SOLUSDT',
    tickSize: '0.01',
    qtyStep: '0.01',
    minOrderQty: '0.01',
    maxOrderQty: '1000000',
  };

  const makeState = (
    entryPrice: string,
    stopLoss: string,
    takeProfit: string,
    initialQty: string,
  ): TradeManagementState =>
    initializeTradeManagement(entryPrice, stopLoss, takeProfit, initialQty);

  const makeContext = (
    overrides: Partial<TradeContext> & { managementState: TradeManagementState },
  ): TradeContext => ({
    entryPrice: '100',
    stopLoss: '99',
    takeProfit: '103',
    currentPrice: '100.5',
    side: 'Buy',
    initialQty: '10',
    instrument,
    ...overrides,
  });

  describe('Profit-direction guard (the "absolute value" bug)', () => {
    it('Long moving AGAINST us toward SL must NOT trigger move_sl_to_entry', () => {
      // Naive |current - entry| / reward = |98 - 100| / 3 = 0.667 >= 0.66,
      // so the old abs-based math would move SL to entry while price is
      // below entry -> Bybit [10001] (StopLoss should be lower than base_price).
      const state = makeState('100', '99', '103', '10');
      const signal = evaluateTradeManagement(
        makeContext({ currentPrice: '98', managementState: state }),
      );

      expect(signal.action).toBe('none');
      expect(signal.reason).toBe('Trade is not in profit');
      expect(signal.newStopLoss).toBeUndefined();
      expect(signal.closeQty).toBeUndefined();
    });

    it('Short moving AGAINST us toward SL must NOT trigger move_sl_to_entry', () => {
      const state = makeState('100', '101', '97', '10');
      const signal = evaluateTradeManagement(
        makeContext({
          side: 'Sell',
          stopLoss: '101',
          takeProfit: '97',
          currentPrice: '101.99', // |101.99 - 100| / 3 = 0.66 -> old bug triggered
          managementState: state,
        }),
      );

      expect(signal.action).toBe('none');
      expect(signal.reason).toBe('Trade is not in profit');
    });

    it('Sniper (TotalR >= 4) in loss must NOT trigger partial close or SL move', () => {
      // R = 2.5 / 0.5 = 5 -> Sniper branch. |98.9 - 100| / 2.5 = 0.44 >= 0.33.
      const state = makeState('100', '99.5', '102.5', '10');
      const signal = evaluateTradeManagement(
        makeContext({
          stopLoss: '99.5',
          takeProfit: '102.5',
          currentPrice: '98.9',
          managementState: state,
        }),
      );

      expect(signal.action).toBe('none');
      expect(signal.reason).toBe('Trade is not in profit');
      expect(signal.closeQty).toBeUndefined();
    });

    it('Price exactly at entry is neither profit nor loss -> no management', () => {
      const state = makeState('100', '99', '103', '10');
      const signal = evaluateTradeManagement(
        makeContext({ currentPrice: '100', managementState: state }),
      );

      expect(signal.action).toBe('none');
      expect(signal.reason).toBe('Trade is not in profit');
    });

    it('Preserves the unmodified management state when guarding', () => {
      const state = makeState('100', '99', '103', '10');
      const signal = evaluateTradeManagement(
        makeContext({ currentPrice: '98', managementState: state }),
      );

      expect(signal.updatedState).toEqual(state);
      expect(signal.updatedState.milestone1Triggered).toBe(false);
    });
  });

  describe('Valid progression still works when in profit', () => {
    it('Long at >= 66% progress moves SL to entry (Classic)', () => {
      const state = makeState('100', '99', '103', '10');
      const signal = evaluateTradeManagement(
        makeContext({ currentPrice: '102.05', managementState: state }),
      );

      expect(signal.action).toBe('move_sl_to_entry');
      expect(signal.newStopLoss).toBe('100');
      expect(signal.updatedState.milestone1Triggered).toBe(true);
    });

    it('Short at >= 66% progress moves SL to entry (Classic)', () => {
      const state = makeState('100', '101', '97', '10');
      const signal = evaluateTradeManagement(
        makeContext({
          side: 'Sell',
          stopLoss: '101',
          takeProfit: '97',
          currentPrice: '98.02',
          managementState: state,
        }),
      );

      expect(signal.action).toBe('move_sl_to_entry');
      expect(signal.newStopLoss).toBe('100');
    });

    it('Sniper in profit at 33% closes 25% and moves SL to entry', () => {
      const state = makeState('100', '99.5', '102.5', '10');
      const signal = evaluateTradeManagement(
        makeContext({
          stopLoss: '99.5',
          takeProfit: '102.5',
          currentPrice: '100.9', // (100.9 - 100) / 2.5 = 0.36 >= 0.33
          managementState: state,
        }),
      );

      expect(signal.action).toBe('close_partial_25');
      expect(signal.newStopLoss).toBe('100');
      expect(new Decimal(signal.closeQty!).gt(0)).toBe(true);
    });
  });
});
