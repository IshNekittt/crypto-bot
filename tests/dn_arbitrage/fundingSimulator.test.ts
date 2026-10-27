import { Decimal } from 'decimal.js';
import {
  DN_DEFAULT_CONFIG,
  DnConfig,
  DnConfigOverrides,
  computeKMin,
  roundTripFeeFraction,
  validateDnConfig,
} from '../../src/dn_arbitrage/config';
import {
  annualizeApy,
  runFundingSimulation,
} from '../../src/dn_arbitrage/backtest/fundingSimulator';
import { FundingEvent } from '../../src/dn_arbitrage/types';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

function testConfig(overrides: DnConfigOverrides = {}): DnConfig {
  const config: DnConfig = {
    ...DN_DEFAULT_CONFIG,
    symbols: ['TESTUSDT'],
    // Existing simulator cases pin the pre-calibration assumptions; the new
    // production defaults are covered explicitly below.
    entryThreshold: new Decimal('0.0001'),
    spotTakerFee: new Decimal('0.001'),
    perpTakerFee: new Decimal('0.00055'),
    ...overrides,
  };
  validateDnConfig(config);
  return config;
}

function makeEvents(rates: readonly number[], intervalHours = 8): FundingEvent[] {
  return rates.map((rate, index) => ({
    timestamp: START + index * intervalHours * HOUR_MS,
    rate: new Decimal(rate),
  }));
}

function simulate(rates: readonly number[], overrides: DnConfigOverrides = {}) {
  const config = testConfig(overrides);
  return runFundingSimulation({
    symbol: 'TESTUSDT',
    events: makeEvents(rates),
    intervalHours: 8,
    config,
  });
}

/**
 * Decimal.js rounds every operation to 20 significant digits, so
 * `equity − startEquity` and `equityBefore × return` legitimately differ in the
 * last digit. Compare magnitudes instead of exact representations.
 */
function expectDecimalClose(actual: Decimal, expected: Decimal, tolerance = '1e-15'): void {
  expect(actual.minus(expected).abs().lt(new Decimal(tolerance))).toBe(true);
}

describe('maker-optimized defaults', () => {
  it('uses 0.03% funding entry, 0.10% spot taker, 0.02% perp maker, and dynamic k_min', () => {
    expect(DN_DEFAULT_CONFIG.entryThreshold.eq('0.0003')).toBe(true);
    expect(DN_DEFAULT_CONFIG.spotTakerFee.eq('0.001')).toBe(true);
    expect(DN_DEFAULT_CONFIG.perpTakerFee.eq('0.0002')).toBe(true);
    expect(roundTripFeeFraction(DN_DEFAULT_CONFIG).eq('0.0024')).toBe(true);
    expect(computeKMin(new Decimal('0.0003'), DN_DEFAULT_CONFIG)).toBe(13);
  });
});

describe('fundingSimulator §8 accounting', () => {
  it('does not accrue funding at the entry timestamp and charges both legs twice', () => {
    const result = simulate(new Array(10).fill(0.0002));

    expect(result.tradeCount).toBe(1);
    const trade = result.trades[0];

    // Entry at index 3 (three completed epochs of history); the final event is
    // index 9, so exactly six settlements are accrued (4..9), never index 3.
    expect(trade.entryTime).toBe(START + 3 * 8 * HOUR_MS);
    expect(trade.exitTime).toBe(START + 9 * 8 * HOUR_MS);
    expect(trade.epochsHeld).toBe(6);
    expect(trade.exitReason).toBe('END_OF_DATA');
    expect(trade.kMin).toBe(23);
    expect(trade.fundingReturn.eq(new Decimal('0.0012'))).toBe(true);

    // §8.4: s_in + p_in(1+b0) + s_out + p_out(1+b1)
    expect(trade.feeReturn.eq(new Decimal('0.00310055'))).toBe(true);
    expect(trade.basisReturn.eq(new Decimal('0.001'))).toBe(true);
    expect(trade.slippageReturn.eq(new Decimal('0.0004'))).toBe(true);
    expect(trade.netNotionalReturn.eq(new Decimal('-0.00130055'))).toBe(true);

    // §8.6: r_net_equity = r_net_notional / (1 + (P0/S0)/L + beta)
    const denominator = new Decimal(1)
      .plus(new Decimal('1.001').div(3))
      .plus('0.05');
    const expectedEquityReturn = new Decimal('-0.00130055').div(denominator);
    expect(trade.netEquityReturn.eq(expectedEquityReturn)).toBe(true);
    expect(trade.equityBefore.eq(10000)).toBe(true);
    expect(trade.equityAfter.eq(new Decimal(10000).mul(expectedEquityReturn.plus(1)))).toBe(
      true,
    );
    expectDecimalClose(result.netPnlUsdt, trade.netPnlUsdt);
    expectDecimalClose(result.totalYield, expectedEquityReturn);
  });

  it('never enters when the funding MA is below the entry threshold', () => {
    const result = simulate(new Array(20).fill(0.00005));

    expect(result.tradeCount).toBe(0);
    expect(result.endEquity.eq(10000)).toBe(true);
    expect(result.totalYield.isZero()).toBe(true);
    expect(result.netApy.isZero()).toBe(true);
    expect(result.avgHoldHours).toBeNull();
  });

  it('exits on MA decay once the time-lock has been paid for', () => {
    // f_ma = 0.15%/epoch → k_min = ceil(0.45% / 0.15%) = 3 epochs, and the
    // 3 × 8h wall-clock floor lands exactly on the 24h minimum. The lock is
    // therefore satisfied at the third settlement, which is where the decaying
    // MA becomes actionable.
    const rates = [
      ...new Array(3).fill(0.0015),
      ...new Array(7).fill(0.000001),
    ];
    const result = simulate(rates);

    expect(result.tradeCount).toBe(1);
    const trade = result.trades[0];
    expect(trade.entryTime).toBe(START + 3 * 8 * HOUR_MS);
    expect(trade.kMin).toBe(3);
    // Two sub-threshold confirmations arrive at indices 6 and 7.
    expect(trade.exitTime).toBe(START + 7 * 8 * HOUR_MS);
    expect(trade.epochsHeld).toBe(4);
    expect(trade.exitReason).toBe('MA_BELOW_EXIT');
    expect(trade.fundingReturn.eq(new Decimal('0.000004'))).toBe(true);
  });

  it('does not let positive MA decay churn a position out before the time-lock', () => {
    // f_ma = 0.01%/epoch → k_min = ceil(0.45% / 0.01%) = 45 epochs. The MA
    // collapses immediately, but the lock must keep the position open or the
    // round trip is pure fee churn (§7.1).
    const rates = [
      ...new Array(3).fill(0.0001),
      ...new Array(17).fill(0.000001),
    ];
    const result = simulate(rates);

    expect(result.tradeCount).toBe(1);
    const trade = result.trades[0];
    expect(trade.kMin).toBe(45);
    expect(trade.epochsHeld).toBe(16);
    expect(trade.epochsHeld).toBeLessThan(trade.kMin);
    expect(trade.exitReason).toBe('END_OF_DATA');
  });

  it('does not panic-exit a negative streak while accrued carry still covers exit costs', () => {
    const rates = [
      ...new Array(6).fill(0.0002),
      ...new Array(3).fill(-0.0001),
    ];
    const result = simulate(rates);

    expect(result.tradeCount).toBe(1);
    const trade = result.trades[0];
    expect(trade.epochsHeld).toBe(5);
    expect(trade.epochsHeld).toBeLessThan(trade.kMin);
    expect(trade.exitReason).toBe('END_OF_DATA');
    expect(trade.fundingReturn.eq(new Decimal('0.0001'))).toBe(true);
  });

  it('allows negative-streak exit before k_min only after tolerance is breached', () => {
    const rates = [
      ...new Array(6).fill(0.0002),
      ...new Array(3).fill(-0.002),
    ];
    const result = simulate(rates);

    const trade = result.trades[0];
    expect(trade.exitReason).toBe('NEGATIVE_STREAK');
    expect(trade.epochsHeld).toBeLessThan(trade.kMin);
    expect(trade.fundingReturn.eq(new Decimal('-0.0056'))).toBe(true);
  });

  it('requires losses beyond a negative tolerance before MA decay bypasses k_min', () => {
    const rates = [0.0001, 0.0001, 0.0001, -0.001, 0.000001, 0.000001];
    const result = simulate(rates, { exitLossTolerance: new Decimal('-0.0002') });

    expect(result.tradeCount).toBe(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('END_OF_DATA');
    expect(trade.epochsHeld).toBeLessThan(trade.kMin);
  });

  it('exits after the time-lock when the current rate is negative', () => {
    const rates = [
      ...new Array(26).fill(0.0002),
      -0.0001,
    ];
    const result = simulate(rates);

    expect(result.tradeCount).toBe(1);
    const trade = result.trades[0];
    expect(trade.entryTime).toBe(START + 3 * 8 * HOUR_MS);
    expect(trade.epochsHeld).toBe(23);
    expect(trade.exitReason).toBe('TIME_LOCK_NEGATIVE');
    // 22 positive settlements (4..25) and one negative (26).
    expect(trade.fundingReturn.eq(new Decimal('0.0043'))).toBe(true);
    expect(trade.holdHours.eq(184)).toBe(true);
  });

  it('annualizes the compounded total return over the data window', () => {
    const result = simulate(new Array(10).fill(0.0002));
    const expectedWindowDays = new Decimal(3);
    const expectedApy = annualizeApy(result.totalYield, expectedWindowDays);

    expect(result.windowDays.eq(expectedWindowDays)).toBe(true);
    expect(result.netApy.eq(expectedApy)).toBe(true);
    expect(expectedApy.lt(0)).toBe(true);
  });
});

describe('fundingSimulator entry/exit boundaries', () => {
  it('does not open a position on the final funding event', () => {
    // Only 3 events: the MA becomes available on the final event, but there is
    // no future settlement to accrue, so entering would only pay fees.
    const result = simulate(new Array(3).fill(0.0002));
    expect(result.tradeCount).toBe(0);
  });

  it('treats the entry floor as inclusive (Bybit caps funding at 0.01%/8h)', () => {
    // Every epoch sits exactly on the 0.01% cap — the most common real-world
    // level. A strict `>` comparison would refuse to trade at all.
    const result = simulate(new Array(10).fill(0.0001));
    expect(result.tradeCount).toBe(1);
    expect(result.trades[0].entryTime).toBe(START + 3 * 8 * HOUR_MS);
    expect(result.trades[0].entryMa.eq(new Decimal('0.0001'))).toBe(true);
  });

  it('does not enter one tick below the entry floor', () => {
    const result = simulate(new Array(10).fill(0.00009));
    expect(result.tradeCount).toBe(0);
  });

  it('honors the cooldown between exits and re-entries', () => {
    const rates = [
      ...new Array(6).fill(0.0002),
      ...new Array(3).fill(-0.0001),
      ...new Array(20).fill(0.0002),
    ];
    const result = simulate(rates, { cooldownEpochs: 5 });

    expect(result.tradeCount).toBeGreaterThanOrEqual(1);
    const firstExitIndex = 8;
    const secondTrade = result.trades[1];
    if (secondTrade) {
      const secondEntryIndex = Math.round(
        (secondTrade.entryTime - START) / (8 * HOUR_MS),
      );
      expect(secondEntryIndex).toBeGreaterThanOrEqual(firstExitIndex + 5);
    }
  });
});
