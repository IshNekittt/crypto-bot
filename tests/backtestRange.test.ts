import { getTimeRangeForDays } from '../src/backtest/historyLoader';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('Backtest history range (BACKTEST_DAYS wiring)', () => {
  it('builds a window matching the configured number of days', () => {
    const { fromMs, toMs } = getTimeRangeForDays(60);

    expect(toMs - fromMs).toBe(60 * MS_PER_DAY);
  });

  it('honours arbitrary day counts instead of a hardcoded 180', () => {
    const { fromMs, toMs } = getTimeRangeForDays(30);

    expect(toMs - fromMs).toBe(30 * MS_PER_DAY);
    expect(toMs - fromMs).not.toBe(180 * MS_PER_DAY);
  });

  it('ends at approximately "now"', () => {
    const before = Date.now();
    const { toMs } = getTimeRangeForDays(14);
    const after = Date.now();

    expect(toMs).toBeGreaterThanOrEqual(before);
    expect(toMs).toBeLessThanOrEqual(after);
  });

  it('rejects non-positive and non-finite day counts', () => {
    expect(() => getTimeRangeForDays(0)).toThrow(/positive number of days/);
    expect(() => getTimeRangeForDays(-5)).toThrow(/positive number of days/);
    expect(() => getTimeRangeForDays(Number.NaN)).toThrow(/positive number of days/);
    expect(() => getTimeRangeForDays(Number.POSITIVE_INFINITY)).toThrow(/positive number of days/);
  });
});
