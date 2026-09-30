import { Decimal } from 'decimal.js';
import {
  openTrade,
  checkAndCloseTrade,
  checkPendingLimitOrder,
  getInitialState,
  InstrumentInfo,
} from '../src/backtest/executionSimulator';

const mockInstrument: InstrumentInfo = {
  symbol: 'BTCUSDT',
  tickSize: '0.1',
  qtyStep: '0.001',
  minOrderQty: '0.001',
  maxOrderQty: '1000',
};

describe('ExecutionSimulator - Breakeven Logic', () => {
  let state: ReturnType<typeof getInitialState>;
  const baseCandle = {
    timestamp: 1000000,
    open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
  };

  beforeEach(() => {
    state = getInitialState();
  });

  it('should move SL to entryPrice when price reaches BREAKEVEN_RR_TRIGGER (2R)', () => {
    // Open a long trade with entry=50000, SL=49900, TP=50300 (1:3 R:R)
    // Risk distance = 100, Breakeven at 2R = 50000 + 200 = 50200
    const { state: newState, tradeOpened } = openTrade(
      state,
      { ...baseCandle, timestamp: 1000000 },
      new Decimal('50000'),
      new Decimal('49900'),
      new Decimal('50300'),
      'Buy',
      1,
      'Test Scenario',
      mockInstrument,
      undefined,
      undefined,
      'Market',
      undefined,
      'BTCUSDT'
    );
    expect(tradeOpened).toBe(true);
    state = newState;

    // Verify initial SL is 49900
    expect(state.openTrade?.slPrice.toString()).toBe('49900');

    // Candle hits breakeven trigger (high >= 50200) but low stays above entry (50000)
    // low=50010 > entry=50000 so breakeven SL (now at 50000) is NOT hit
    const breakevenCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50210',  // Hits 2R breakeven
      low: '50010',   // Above entry, won't hit breakeven SL
    };

    const { state: stateAfterCheck, tradeResult } = checkAndCloseTrade(
      state,
      breakevenCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        breakevenRrTrigger: 2,
      },
      'BTCUSDT'
    );

    // Trade should still be open (SL moved to breakeven, TP not hit)
    expect(tradeResult).toBeNull();
    expect(stateAfterCheck.openTrade).not.toBeNull();
    // SL should now be at entry price (breakeven)
    expect(stateAfterCheck.openTrade?.slPrice.toString()).toBe('50000');
  });

  it('should close trade at PnL=0 when price retraces to entryPrice after breakeven', () => {
    // Open trade
    const { state: newState, tradeOpened } = openTrade(
      state,
      { ...baseCandle, timestamp: 1000000 },
      new Decimal('50000'),
      new Decimal('49900'),
      new Decimal('50300'),
      'Buy',
      1,
      'Test Scenario',
      mockInstrument,
      undefined,
      undefined,
      'Market',
      undefined,
      'BTCUSDT'
    );
    expect(tradeOpened).toBe(true);
    state = newState;

    // First candle hits breakeven trigger (2R = 50200) but low stays above entry
    const breakevenCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50210',
      low: '50010',  // Above entry, breakeven SL not hit yet
    };
    const { state: stateAfterBE } = checkAndCloseTrade(
      state,
      breakevenCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        breakevenRrTrigger: 2,
      },
      'BTCUSDT'
    );
    state = stateAfterBE;
    expect(state.openTrade?.slPrice.toString()).toBe('50000');

    // Second candle retraces to entry price (low <= 50000) - should close at SL (now at entry)
    const retraceCandle = {
      ...baseCandle,
      timestamp: 1001800,
      high: '50250',
      low: '49990',  // Below entry price, hits SL which is now at 50000
    };
    const { state: stateAfterClose, tradeResult } = checkAndCloseTrade(
      state,
      retraceCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        breakevenRrTrigger: 2,
      },
      'BTCUSDT'
    );

    // Trade should be closed at SL (which is at entry price)
    expect(tradeResult).not.toBeNull();
    expect(stateAfterClose.openTrade).toBeNull();
    expect(tradeResult!.closedBy).toBe('SL');
    // PnL should be approximately 0 (minus fees)
    const pnlWithFees = tradeResult!.pnl;
    expect(pnlWithFees.lt(new Decimal('1'))).toBe(true); // Should be very small (just fees)
  });
});

describe('ExecutionSimulator - Limit Order Lifecycle', () => {
  let state: ReturnType<typeof getInitialState>;
  const baseCandle = {
    timestamp: 1000000,
    open: '50000', high: '50100', low: '49900', close: '50050', volume: '100',
  };

  beforeEach(() => {
    state = getInitialState();
  });

  it('should fill limit order when candle wick pierces limitPrice', () => {
    // Place a limit order (Buy limit at 49950, current price 50000)
    const { state: newState, tradeOpened } = openTrade(
      state,
      { ...baseCandle, timestamp: 1000000 },
      new Decimal('49950'),  // entry = limit price
      new Decimal('49850'),
      new Decimal('50250'),
      'Buy',
      1,
      'Test Limit',
      mockInstrument,
      undefined,
      undefined,
      'Limit',
      new Decimal('49950'),  // limitPrice
      'BTCUSDT'
    );
    expect(tradeOpened).toBe(false); // Not filled yet
    expect(newState.pendingLimitOrder).not.toBeNull();
    expect(newState.pendingLimitOrder?.limitPrice.toString()).toBe('49950');
    state = newState;

    // Next candle: low pierces limit price (49940 <= 49950)
    const fillCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50100',
      low: '49940',  // Wick touches limit price
    };

    const { state: stateAfterFill, limitOrderFilled, limitOrderExpired } = checkPendingLimitOrder(
      state,
      fillCandle,
      { limitExpirationCandles: 6, ltfTimeframe: '15' },
      'BTCUSDT'
    );

    expect(limitOrderFilled).toBe(true);
    expect(limitOrderExpired).toBe(false);
    expect(stateAfterFill.pendingLimitOrder).toBeNull();
    expect(stateAfterFill.openTrade).not.toBeNull();
    // Entry price should be the limit price (not candle close)
    expect(stateAfterFill.openTrade?.entryPrice.toString()).toBe('49950');
    expect(stateAfterFill.openTrade?.orderType).toBe('Limit');
  });

  it('should expire limit order after LIMIT_EXPIRATION_CANDLES without fill', () => {
    // Place a limit order (Buy limit at 49950)
    const { state: newState, tradeOpened } = openTrade(
      state,
      { ...baseCandle, timestamp: 1000000 },
      new Decimal('49950'),
      new Decimal('49850'),
      new Decimal('50250'),
      'Buy',
      1,
      'Test Limit',
      mockInstrument,
      undefined,
      undefined,
      'Limit',
      new Decimal('49950'),
      'BTCUSDT'
    );
    expect(tradeOpened).toBe(false);
    state = newState;

    // Simulate 7 candles passing without touching limit price (limitExpirationCandles = 6)
    let currentState = state;
    for (let i = 1; i <= 7; i++) {
      const candle = {
        ...baseCandle,
        timestamp: 1000000 + i * 900000,
        high: '50100',
        low: '49980',  // Never touches 49950
      };
      const { state: nextState, limitOrderFilled, limitOrderExpired } = checkPendingLimitOrder(
        currentState,
        candle,
        { limitExpirationCandles: 6, ltfTimeframe: '15' },
        'BTCUSDT'
      );
      currentState = nextState;
      
      if (i < 7) {
        expect(limitOrderFilled).toBe(false);
        expect(limitOrderExpired).toBe(false);
        expect(nextState.pendingLimitOrder?.candlesWaited).toBe(i);
      } else {
        // On 7th candle (exceeds 6), should expire
        expect(limitOrderExpired).toBe(true);
        expect(limitOrderFilled).toBe(false);
        expect(nextState.pendingLimitOrder).toBeNull();
      }
    }
  });
});