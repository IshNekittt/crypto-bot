import { CalendarMacro } from '../../src/backtest/calendarMacro';
import type { MacroContext } from '../../src/smc/patternRecognizer';
import type { Candle } from '../../src/types';

function bar(time: string, open: string, high: string, low: string): Candle {
  return { timestamp: Date.parse(time), open, high, low, close: open, volume: '1' };
}

function levels(context: MacroContext): string[] {
  const { pdh, pdl, do: dayOpen } = context.dailyLevels;
  const { pwh, pwl, wo } = context.weeklyLevels;
  return [pdh, pdl, dayOpen, pwh, pwl, wo].map(price => price.toString());
}

describe('CalendarMacro', () => {
  it('uses Friday only for Monday PDH/PDL after a weekend gap, and all of last week for PWH/PWL', () => {
    const macro = new CalendarMacro();
    const monday = bar('2026-11-23T00:00Z', '110', '200', '10');
    for (const candle of [
      bar('2026-11-16T12:00Z', '103', '150', '80'), // previous ISO week, outside Friday's range
      bar('2026-11-19T20:00Z', '110', '140', '90'),
      bar('2026-11-20T00:00Z', '106', '121', '101'),
      bar('2026-11-20T20:00Z', '111', '122', '99'),
    ]) macro.addClosed(candle);

    const firstMinute = macro.snapshot(monday);
    expect(levels(firstMinute)).toEqual(['122', '99', '110', '150', '80', '110']);
    expect(firstMinute.ath.toString()).toBe('150'); // Monday's forming high is not visible
    macro.addClosed(monday);
    expect(levels(macro.snapshot(bar('2026-11-23T04:00Z', '112', '115', '105'))))
      .toEqual(['122', '99', '110', '150', '80', '110']);
    expect(levels(macro.snapshot(bar('2026-11-24T00:00Z', '113', '115', '105'))))
      .toEqual(['200', '10', '113', '150', '80', '110']);
  });

  it('rolls ISO weeks at Monday 00:00 UTC across the ISO week-year boundary, not on Thursday', () => {
    const macro = new CalendarMacro();
    for (const candle of [
      bar('2026-12-27T20:00Z', '105', '110', '90'),
      bar('2026-12-28T00:00Z', '112', '115', '95'),
      bar('2026-12-30T20:00Z', '116', '120', '100'),
    ]) macro.addClosed(candle);
    const thursday = bar('2026-12-31T00:00Z', '121', '125', '93');
    expect(levels(macro.snapshot(thursday))).toEqual(['120', '100', '121', '110', '90', '112']);
    macro.addClosed(thursday);
    macro.addClosed(bar('2027-01-03T20:00Z', '120', '130', '94'));
    expect(levels(macro.snapshot(bar('2027-01-03T23:59Z', '125', '130', '115'))).slice(3))
      .toEqual(['110', '90', '112']);
    expect(levels(macro.snapshot(bar('2027-01-04T00:00Z', '131', '140', '122'))))
      .toEqual(['130', '94', '131', '130', '93', '131']);
  });

  it('does not substitute an older trading week for an entirely absent previous ISO week', () => {
    const macro = new CalendarMacro();
    macro.addClosed(bar('2026-11-06T20:00Z', '110', '121', '100'));
    expect(levels(macro.snapshot(bar('2026-11-16T00:00Z', '112', '120', '110'))))
      .toEqual(['121', '100', '112', '0', '0', '112']);
  });
});
