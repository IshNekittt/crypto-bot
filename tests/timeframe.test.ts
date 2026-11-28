import { candleCloseTime, timeframeToMinutes } from '../src/utils/timeframe';

describe('timeframeToMinutes', () => {
  it.each([
    ['1', 1], ['3', 3], ['5', 5], ['15', 15], ['30', 30], ['60', 60],
    ['120', 120], ['240', 240], ['360', 360], ['720', 720],
    ['D', 1440], ['W', 10080], ['M', 43200],
  ])('converts %s to %i minutes', (tf, minutes) => {
    expect(timeframeToMinutes(tf)).toBe(minutes);
  });

  it.each(['', '0', '-15', '999', '4H', '1e2', '0xF', '15.5', '15 ', 'constructor'])(
    'rejects noncanonical interval %j',
    tf => expect(() => timeframeToMinutes(tf)).toThrow(/Unknown Bybit timeframe/),
  );
});

it('uses actual calendar boundaries for monthly candle closes', () => {
  expect(candleCloseTime(Date.UTC(2026, 0, 1), 'M')).toBe(Date.UTC(2026, 1, 1));
  expect(candleCloseTime(Date.UTC(2026, 1, 1), 'M')).toBe(Date.UTC(2026, 2, 1));
});
