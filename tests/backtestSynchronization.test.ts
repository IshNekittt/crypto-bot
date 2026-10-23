import { Decimal } from 'decimal.js';
import {
  openTrade,
  checkAndCloseTrade,
  checkPendingLimitOrder,
  getInitialState,
  INITIAL_BALANCE,
  InstrumentInfo,
  TAKER_FEE_RATE,
} from '../src/backtest/executionSimulator';

const mockInstrument: InstrumentInfo = {
  symbol: 'BTCUSDT',
  tickSize: '0.1',
  qtyStep: '0.001',
  minOrderQty: '0.001',
  maxOrderQty: '1000',
};

const baseCandle = {
  timestamp: 1000000,
  open: '50000',
  high: '50100',
  low: '49900',
  close: '50050',
  volume: '100',
};

function openLongMarket(
  state: ReturnType<typeof getInitialState>,
  overrides: {
    entry?: string;
    sl?: string;
    tp?: string;
    structure?: { type?: 'CHoCH' | 'SMS' | 'BOS'; timestamp: number; price: Decimal };
  } = {},
) {
  return openTrade(
    state,
    { ...baseCandle, timestamp: 1000000 },
    new Decimal(overrides.entry ?? '50000'),
    new Decimal(overrides.sl ?? '49900'),
    new Decimal(overrides.tp ?? '50500'),
    'Buy',
    1,
    'Test Scenario',
    mockInstrument,
    undefined,
    overrides.structure,
    'Market',
    undefined,
    'BTCUSDT',
  );
}

describe('Backtest synchronization - Patch 2: sizing & fees', () => {
  it('does not deduct the entry fee from balance at open (fee settled in closing PnL)', () => {
    const { state, tradeOpened } = openLongMarket(getInitialState());

    expect(tradeOpened).toBe(true);
    // Entry fee is accumulated on the trade...
    expect(state.openTrade?.entryFee.gt(0)).toBe(true);
    // ...but the balance is untouched until the trade closes.
    expect(state.balance.toString()).toBe(INITIAL_BALANCE.toString());
    // No partial closes yet — lifecycle realized gross starts at zero.
    expect(state.openTrade?.realizedGrossPnl).toBe('0');
  });

  it('aborts when the sized qty exceeds maxOrderQty', () => {
    const tinyMaxInstrument: InstrumentInfo = { ...mockInstrument, maxOrderQty: '0.1' };
    const initialState = getInitialState();

    const { state, tradeOpened } = openTrade(
      initialState,
      { ...baseCandle, timestamp: 1000000 },
      new Decimal('50000'),
      new Decimal('49900'),
      new Decimal('50500'),
      'Buy',
      1,
      'Test Scenario',
      tinyMaxInstrument,
      undefined,
      undefined,
      'Market',
      undefined,
      'BTCUSDT',
    );

    expect(tradeOpened).toBe(false);
    expect(state.openTrade).toBeNull();
    expect(state.balance.toString()).toBe(initialState.balance.toString());
  });
});

describe('Backtest synchronization - Patch 3: Adaptive Fractioning & burn-on-entry', () => {
  it('initializes initialTotalR from real entry/SL/TP geometry (TotalR = 5)', () => {
    const { state, tradeOpened } = openLongMarket(getInitialState());

    expect(tradeOpened).toBe(true);
    expect(state.openTrade?.managementState?.initialTotalR).toBe('5.00000000');
    expect(state.openTrade?.managementState?.milestone1Triggered).toBe(false);
    expect(state.openTrade?.managementState?.milestone2Triggered).toBe(false);
  });

  it('burns the trigger structure on Market entry', () => {
    const { state } = openLongMarket(getInitialState(), {
      structure: { type: 'CHoCH', timestamp: 123456, price: new Decimal('50010') },
    });

    expect(state.mitigatedStructures).toHaveLength(1);
    expect(state.mitigatedStructures[0]).toEqual({
      type: 'CHoCH',
      timestamp: 123456,
      price: '50010',
      direction: 'BULLISH',
    });
  });

  it('burns the trigger structure when a Limit order is placed and initializes management on fill', () => {
    const { state: placedState, tradeOpened } = openTrade(
      getInitialState(),
      { ...baseCandle, timestamp: 1000000 },
      new Decimal('49950'),
      new Decimal('49850'),
      new Decimal('50450'),
      'Buy',
      1,
      'Test Limit',
      mockInstrument,
      undefined,
      { type: 'SMS', timestamp: 654321, price: new Decimal('49960') },
      'Limit',
      new Decimal('49950'),
      'BTCUSDT',
    );

    expect(tradeOpened).toBe(false);
    expect(placedState.mitigatedStructures).toHaveLength(1);
    expect(placedState.mitigatedStructures[0].timestamp).toBe(654321);
    expect(placedState.balance.toString()).toBe(INITIAL_BALANCE.toString());

    const fillCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50100',
      low: '49940',
    };

    const { state: filledState, limitOrderFilled } = checkPendingLimitOrder(
      placedState,
      fillCandle,
      { limitExpirationCandles: 6, ltfTimeframe: '15' },
      'BTCUSDT',
    );

    expect(limitOrderFilled).toBe(true);
    expect(filledState.openTrade?.managementState?.initialTotalR).toBe('5.00000000');
    // Fill does not debit the maker fee upfront either — it is settled on close.
    expect(filledState.balance.toString()).toBe(INITIAL_BALANCE.toString());
    // Structure stays burned after the fill.
    expect(filledState.mitigatedStructures).toHaveLength(1);
  });
});

describe('Backtest synchronization - Patch 4: PnL-sign loss & partial-close fees', () => {
  it('treats a TP close with negative net PnL as a loss (cooldown + Drawdown Guard)', () => {
    const { state: openedState } = openLongMarket(getInitialState(), {
      entry: '50000',
      sl: '49900',
      tp: '50001', // reward 1 vs risk 100 -> fees make the TP close a net loss
    });

    const closeCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50002',
      low: '49990',
    };

    const { state, tradeResult } = checkAndCloseTrade(
      openedState,
      closeCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        enableSniperMode: true,
      },
      mockInstrument,
      'BTCUSDT',
    );

    expect(tradeResult).not.toBeNull();
    expect(tradeResult!.closedBy).toBe('TP');
    expect(tradeResult!.pnl.lt(0)).toBe(true);
    expect(state.consecutiveLosses).toBe(1);
    expect(state.cooldownUntil).toBe(closeCandle.timestamp + 16 * 60 * 1000);
  });

  it('accumulates partial-close fees into entryFee instead of double-charging the balance', () => {
    const { state: openedState } = openLongMarket(getInitialState());
    const entryFeeBeforePartial = openedState.openTrade!.entryFee;
    const qtyBeforePartial = openedState.openTrade!.qty;

    // 34% progress toward TP (33% milestone) with no SL/TP hit.
    const partialCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50170',
      low: '50010',
    };

    const { state, tradeResult } = checkAndCloseTrade(
      openedState,
      partialCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        enableSniperMode: true,
      },
      mockInstrument,
      'BTCUSDT',
    );

    expect(tradeResult).toBeNull();
    expect(state.openTrade).not.toBeNull();
    expect(state.openTrade!.managementState?.milestone1Triggered).toBe(true);

    const closedQty = new Decimal('0.049'); // 25% of 0.196, rounded to qtyStep
    expect(state.openTrade!.qty.toString()).toBe(qtyBeforePartial.minus(closedQty).toString());
    expect(state.openTrade!.slPrice.toString()).toBe('50000');

    // Partial fee is accumulated in the total fee ledger...
    // The fill price is the EXACT 33% milestone threshold (50000 + 500 * 0.33 =
    // 50165), never the candle high (50170) — magic wicks are not tradable prints.
    const partialFillPrice = new Decimal('50165');
    const partialFee = partialFillPrice.mul(closedQty).mul(TAKER_FEE_RATE);
    expect(state.openTrade!.entryFee.toString()).toBe(
      entryFeeBeforePartial.plus(partialFee).toString(),
    );

    // ...and only the gross partial profit hits the balance (fee settled on final close).
    const grossPartialPnl = partialFillPrice.minus('50000').mul(closedQty);
    expect(state.balance.toString()).toBe(INITIAL_BALANCE.plus(grossPartialPnl).toString());

    // The partial gross is also accumulated on the trade for lifecycle reporting.
    expect(state.openTrade!.realizedGrossPnl).toBe(grossPartialPnl.toString());
  });

  it('aggregates partial and final PnL into the TradeResult lifecycle (report parity)', () => {
    const { state: openedState } = openLongMarket(getInitialState());
    const initialQty = openedState.openTrade!.qty;
    const closedQty = new Decimal('0.049');
    const managementConfig = {
      cooldownCandles: 16,
      ltfTimeframe: '15',
      limitExpirationCandles: 6,
      enableSniperMode: true,
    };

    // Milestone 1: close 25% at the exact 33% threshold (50000 + 500 * 0.33 = 50165).
    const { state: afterPartial } = checkAndCloseTrade(
      openedState,
      { ...baseCandle, timestamp: 1000900, high: '50170', low: '50010' },
      managementConfig,
      mockInstrument,
      'BTCUSDT',
    );

    const partialGrossPnl = new Decimal('165').mul(closedQty);
    expect(afterPartial.openTrade!.realizedGrossPnl).toBe(partialGrossPnl.toString());

    // Final close at TP for the remaining half.
    const { state: finalState, tradeResult } = checkAndCloseTrade(
      afterPartial,
      { ...baseCandle, timestamp: 1001800, high: '50500', low: '50050' },
      managementConfig,
      mockInstrument,
      'BTCUSDT',
    );

    expect(tradeResult).not.toBeNull();
    expect(tradeResult!.closedBy).toBe('TP');

    // Candle 2 reaches TP. Milestone 2 is now reachable (risk distance is measured
    // from the ORIGINAL stop), so another 25% closes at the 66% threshold
    // (50000 + 500 * 0.66 = 50330) before the remainder exits at TP — same candle.
    const remainingAfterMilestone2 = initialQty.minus(closedQty).minus(closedQty);
    const milestone2GrossPnl = new Decimal('330').mul(closedQty);
    const finalGrossPnl = new Decimal('500').mul(remainingAfterMilestone2);
    const totalGrossPnl = partialGrossPnl
      .plus(milestone2GrossPnl)
      .plus(finalGrossPnl);

    // Lifecycle fields cover the whole position, not just the final remainder.
    expect(tradeResult!.grossPnl?.toString()).toBe(totalGrossPnl.toString());
    expect(tradeResult!.qty.toString()).toBe(initialQty.toString());
    expect(tradeResult!.pnl.toString()).toBe(
      totalGrossPnl.minus(tradeResult!.feesPaid).toString(),
    );

    // run.ts reports initialBalance + Σ trade.pnl — must equal the simulator balance.
    expect(finalState.balance.toString()).toBe(
      INITIAL_BALANCE.plus(tradeResult!.pnl).toString(),
    );
  });

  it('fills a gapped partial at the candle open when price already jumped past the milestone', () => {
    const { state: openedState } = openLongMarket(getInitialState());
    const closedQty = new Decimal('0.049');

    // Opens at 50200, already past the 50165 (33%) milestone, and never trades back down to it.
    const gapCandle = {
      ...baseCandle,
      timestamp: 1000900,
      open: '50200',
      high: '50400',
      low: '50150',
    };

    const { state } = checkAndCloseTrade(
      openedState,
      gapCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        enableSniperMode: true,
      },
      mockInstrument,
      'BTCUSDT',
    );

    // The first executable price after the milestone became true was the open.
    expect(state.openTrade!.realizedGrossPnl).toBe(
      new Decimal('200').mul(closedQty).toString(),
    );
  });

  it('does not defer a stop-loss that occurs on the same candle as a partial close', () => {
    const { state: openedState } = openLongMarket(getInitialState());
    const initialQty = openedState.openTrade!.qty;

    // Wide candle: high triggers the 33% milestone, low pierces the original SL.
    const wideCandle = {
      ...baseCandle,
      timestamp: 1000900,
      high: '50400',
      low: '49800',
    };

    const { state, tradeResult } = checkAndCloseTrade(
      openedState,
      wideCandle,
      {
        cooldownCandles: 16,
        ltfTimeframe: '15',
        limitExpirationCandles: 6,
        enableSniperMode: true,
      },
      mockInstrument,
      'BTCUSDT',
    );

    // The partial-close branch used to return early, swallowing the SL for the
    // entire candle and giving the position a free extra candle of life.
    expect(tradeResult).not.toBeNull();
    expect(tradeResult!.closedBy).toBe('SL');
    expect(state.openTrade).toBeNull();
    // The remainder exits at the original stop; qty still reports the full position.
    expect(tradeResult!.qty.toString()).toBe(initialQty.toString());
  });
});
