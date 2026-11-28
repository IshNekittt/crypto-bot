import { Decimal } from 'decimal.js';
import { PatternRecognizer, Structure } from '../src/smc/patternRecognizer';
import type { LiquidityPool, MacroContext } from '../src/smc/patternRecognizer';
import type { BybitClient } from '../src/api/bybitClient';
import type { Candle } from '../src/types';

const recognizer = new PatternRecognizer({} as BybitClient);

function bar(timestamp: number, high = '101', low = '99', close = '100', open = '100'): Candle {
  return { timestamp, open, high, low, close, volume: '10' };
}

function mirror(c: Candle): Candle {
  const reflect = (price: string) => new Decimal(200).minus(price).toString();
  return { ...c, high: reflect(c.low), low: reflect(c.high), open: reflect(c.open), close: reflect(c.close) };
}

describe('displacement and swing chronology', () => {
  const candles = Array.from({ length: 9 }, (_, i) => bar(i));
  candles[3] = bar(3, '105');
  candles[8] = bar(8, '109', '99', '108');

  it('requires a positive measured ATR even when a confirmed swing breaks', () => {
    expect(recognizer.detectStructureBreaks(candles, new Decimal(1))).toHaveLength(1);
    const shortBufferAtr = recognizer.calculateATR(candles);
    expect(shortBufferAtr.isZero()).toBe(true);
    expect(recognizer.detectStructureBreaks(candles, shortBufferAtr)).toEqual([]);
    expect(recognizer.detectStructureBreaks(candles, new Decimal(-1))).toEqual([]);
  });

  it.each([false, true])('only sweeps a past swing (mirrored: %s)', reversed => {
    const bars = Array.from({ length: 12 }, (_, i) => bar(i));
    bars[0] = bar(0, '110');
    bars[5] = bar(5, '105');
    bars[11] = bar(11, '110');
    const sweeps = recognizer.detectSweeps(reversed ? bars.map(mirror) : bars);
    expect(sweeps.map(s => s.timestamp)).toEqual([11]);
  });

  it('requires three right-hand bars and nonzero ATR for an SMS', () => {
    const bars = Array.from({ length: 16 }, (_, i) => bar(i));
    bars[3] = bar(3, '105');
    bars[7] = bar(7, '101', '95');
    bars[12] = bar(12, '105');
    bars[14] = bar(14, '101', '90', '92');
    bars[15] = bar(15, '101', '90', '92');
    expect(recognizer.detectSMS(bars.slice(0, 15), new Decimal(1))).toEqual([]);
    expect(recognizer.detectSMS(bars, new Decimal(1)).map(s => s.timestamp)).toEqual([15]);
    expect(recognizer.detectSMS(bars, new Decimal(0))).toEqual([]);
  });
});

describe.each([false, true])('pool and zone lifecycle (mirrored: %s)', reversed => {
  const series = (candles: Candle[]) => reversed ? candles.map(mirror) : candles;
  const direction = reversed ? 'BEARISH' : 'BULLISH';
  const breakout: Structure = {
    direction, timestamp: 16, type: 'BOS', isValidated: true, price: new Decimal(100),
  };

  it('builds one equal level from confirmed swings without a squeeze and exempts the trigger', async () => {
    const bars = Array.from({ length: 23 }, (_, i) => bar(i));
    bars[0] = bar(0, '112'); // before formation
    bars[4] = bar(4, '108');
    bars[10] = bar(10, '108.04');
    bars[16] = bar(16, '108');
    bars[22] = bar(22, '112'); // current pierce
    const snapshot = async (bars: Candle[]) => {
      const candles = series(bars);
      const pd = await recognizer.buildPatternData('TEST', candles, candles, bars.length - 1);
      expect(pd.tradingRange).toBeNull();
      const equal = pd.liquidityPools.filter(p => p.type === (reversed ? 'EQL' : 'EQH'));
      expect(equal).toHaveLength(1);
      expect(equal[0].points.map(p => p.index)).toEqual([4, 10, 16]);
      expect(equal[0].timestamp).toBe(16);
      const swing = pd.liquidityPools.find(p => p.type === (reversed ? 'SSL' : 'BSL') && p.timestamp === 16)!;
      return [equal[0].isTaken, swing.isTaken];
    };
    expect(await snapshot(bars)).toEqual([false, false]);
    expect(await snapshot([...bars, bar(23)])).toEqual([true, true]);
  });

  it('uses c3 as FVG formation and distinguishes partial touches, full wicks and invalidating closes', () => {
    const formation = [bar(0), bar(1, '112', '99', '111'), bar(2, '112', '110', '111', '110')];
    const partial = bar(3, '106', '100', '104'); // reaches bottom only
    const otherPartial = bar(4, '111', '105', '109'); // reaches top only
    const full = bar(5, '110', '101', '104');
    const gapThrough = bar(5, '100', '95', '98');
    const mitigated = (...after: Candle[]) =>
      recognizer.detectFVGs(series([...formation, ...after])).find(z => z.timestamp === 0)!.mitigated;
    expect(mitigated(partial, otherPartial, full)).toBe(false);
    expect(mitigated(partial, otherPartial, full, bar(6))).toBe(true);
    expect(mitigated(gapThrough, bar(6))).toBe(true);
  });

  it('limits the OB source to 15 bars and counts mitigation only after the confirming break', () => {
    const bars = Array.from({ length: 17 }, (_, i) => bar(i, '104', '98', '103', '99'));
    bars[0] = bar(0, '102', '99', '100', '101');
    const detect = (...after: Candle[]) => recognizer.detectOrderBlocks(series([...bars, ...after]), [breakout]);
    expect(detect()).toEqual([]); // source 16 bars back
    bars[1] = bar(1, '102', '99', '100', '101');
    expect(detect(bar(17, '102', '99'))).toMatchObject([{ timestamp: 1, mitigated: false }]);
    expect(detect(bar(17, '102', '99'), bar(18))).toMatchObject([{ timestamp: 1, mitigated: true }]);
  });
});

it('uses the pair midpoint, rather than the smaller swing, as the EQ distance denominator', () => {
  const bars = Array.from({ length: 15 }, (_, i) => bar(i, '98', '96', '97', '97'));
  bars[4] = bar(4, '100');
  bars[10] = bar(10, '100.10004');
  expect(recognizer.detectEqualLevels(bars).eqh).toHaveLength(1);
  expect(recognizer.detectEqualLevels(bars.slice(0, 13)).eqh).toEqual([]); // unconfirmed second touch
});

it('marks macro liquidity only in the evaluation snapshot and only within its day or week', async () => {
  const monday = Date.UTC(2026, 10, 23);
  const tuesday = Date.UTC(2026, 10, 24);
  const price = new Decimal(110);
  const pools: LiquidityPool[] = (['PDH', 'PWH'] as const).map(type => ({
    type, timestamp: monday, priceLevel: price, isTaken: false, points: [],
  }));
  const macro: MacroContext = {
    ath: price, atl: new Decimal(90), htfFvgs: [], htfObs: [], liquidityPools: pools,
    dailyLevels: { pdh: price, pdl: new Decimal(90), do: new Decimal(100) },
    weeklyLevels: { pwh: price, pwl: new Decimal(90), wo: new Decimal(100) },
  };
  recognizer.setMacroContext('MACRO', macro);
  const bars = [bar(monday, '112'), bar(tuesday), bar(tuesday + 900_000, '112')];
  const read = async () => {
    const pd = await recognizer.buildPatternData('MACRO', bars, [], bars[bars.length - 1].timestamp);
    return pd.liquidityPools.map(p => p.isTaken);
  };
  expect(await read()).toEqual([false, true]); // first Tuesday sweep is still tradable
  bars.push(bar(tuesday + 1_800_000));
  expect(await read()).toEqual([true, true]);
  expect(macro.liquidityPools.map(p => p.isTaken)).toEqual([false, false]);
});
