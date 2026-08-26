import { Decimal } from 'decimal.js';
import { Candle, OrderBlock } from '../src/types';
import {
  averageBodyBefore,
  calculateStopLoss,
  calculateTakeProfit,
  detectStructureBreaks,
  findFVGs,
  findOrderBlocks,
  findSwingPoints,
} from '../src/smc/smc';

let timestampCounter = 0;

function candle(open: string, high: string, low: string, close: string): Candle {
  return {
    timestamp: ++timestampCounter,
    open,
    high,
    low,
    close,
    volume: '1000',
  };
}

function baseCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) {
    candles.push(candle('99.75', '100', '99', '100'));
  }
  return candles;
}

function candlesWithPeak(): Candle[] {
  const candles = baseCandles();
  candles[5] = candle('99.75', '105', '99', '100');
  return candles;
}

function strongBullBreak(): Candle[] {
  const candles = baseCandles();
  candles[5] = candle('99.75', '105', '99', '100');
  candles[8] = candle('100.4', '100.5', '99.6', '100');
  candles.push(candle('104.5', '106', '104', '105.5'));
  return candles;
}

describe('findSwingPoints', () => {
  it('detects swing high surrounded by 3 weaker candles on each side', () => {
    const points = findSwingPoints(candlesWithPeak());
    expect(points).toHaveLength(1);
    expect(points[0].type).toBe('HIGH');
    expect(points[0].index).toBe(5);
    expect(points[0].price.toFixed(2)).toBe('105.00');
  });

  it('detects swing low', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candle('100', '100.5', '100', '100'));
    }
    candles[5] = candle('100', '100.5', '95', '100');
    const points = findSwingPoints(candles);
    expect(points).toHaveLength(1);
    expect(points[0].type).toBe('LOW');
    expect(points[0].price.toFixed(2)).toBe('95.00');
  });

  it('rejects equal highs as non-swings', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candle('100', '101', '99', '100'));
    }
    expect(findSwingPoints(candles)).toHaveLength(0);
  });
});

describe('averageBodyBefore', () => {
  it('computes mean body of previous 10 candles', () => {
    const candles = baseCandles();
    candles[8] = candle('100.4', '100.5', '99.6', '100');
    const avg = averageBodyBefore(candles, 10);
    expect(avg.mul(10000).toNumber()).toBe(2650);
  });

  it('throws when not enough history', () => {
    expect(() => averageBodyBefore(baseCandles(), 5)).toThrow(RangeError);
  });
});

describe('detectStructureBreaks', () => {
  it('accepts body close above swing high with sufficient impulse', () => {
    const breaks = detectStructureBreaks(strongBullBreak());
    expect(breaks).toHaveLength(1);
    expect(breaks[0].direction).toBe('BULLISH');
    expect(breaks[0].kind).toBe('CHOCH');
    expect(breaks[0].brokenSwing.index).toBe(5);
    expect(breaks[0].brokenSwing.price.toNumber()).toBe(105);
    expect(breaks[0].impulseFactor.toFixed(4)).toBe('3.7736');
  });

  it('rejects weak impulse even with valid body close beyond swing', () => {
    const candles = baseCandles();
    candles[5] = candle('99.75', '105', '99', '100');
    candles.push(candle('105.1', '105.9', '104.9', '105.4'));
    expect(detectStructureBreaks(candles)).toHaveLength(0);
  });

  it('does NOT count wick above swing high as structure break', () => {
    const candles = baseCandles();
    candles[5] = candle('99.75', '105', '99', '100');
    candles.push(candle('104.5', '105.5', '104', '104.8'));
    expect(detectStructureBreaks(candles)).toHaveLength(0);
  });

  it('rejects body close below swing low without impulse', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candle('100.25', '101', '100', '100'));
    }
    candles[5] = candle('100.25', '101', '95', '100');
    candles.push(candle('95.3', '95.5', '94.5', '94.9'));
    expect(detectStructureBreaks(candles)).toHaveLength(0);
  });
});

describe('findFVGs', () => {
  it('finds bullish FVG larger than 0.1% of price', () => {
    const first = candle('95', '100', '95', '100');
    const middle = candle('96', '121', '95', '120');
    const third = candle('110.5', '112.5', '110', '112');
    const fvgs = findFVGs([first, middle, third]);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0].direction).toBe('BULLISH');
    expect(fvgs[0].bottom.toNumber()).toBe(100);
    expect(fvgs[0].top.toNumber()).toBe(110);
  });

  it('filters bullish FVG smaller than 0.1% of price as noise', () => {
    const first = candle('95', '100', '95', '100');
    const middle = candle('96', '121', '95', '120');
    const third = candle('100.06', '102', '100.05', '101');
    expect(findFVGs([first, middle, third])).toHaveLength(0);
  });

  it('finds bearish FVG', () => {
    const first = candle('100', '101', '90', '95');
    const middle = candle('94', '95', '69', '70');
    const third = candle('79.5', '80', '79', '78');
    const fvgs = findFVGs([first, middle, third]);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0].direction).toBe('BEARISH');
    expect(fvgs[0].top.toNumber()).toBe(90);
    expect(fvgs[0].bottom.toNumber()).toBe(80);
  });
});

describe('findOrderBlocks', () => {
  function lastOb(blocks: OrderBlock[]): OrderBlock {
    expect(blocks).toHaveLength(1);
    return blocks[0];
  }

  it('uses last opposite candle before impulse as OB zone', () => {
    const breaks = detectStructureBreaks(strongBullBreak());
    const blocks = findOrderBlocks(strongBullBreak(), breaks);
    const ob = lastOb(blocks);
    expect(ob.direction).toBe('BULLISH');
    expect(ob.index).toBe(8);
    expect(ob.top.toNumber()).toBe(100.5);
    expect(ob.bottom.toNumber()).toBe(99.6);
    expect(ob.invalidated).toBe(false);
  });

  it('marks OB invalidated when body closes below its low', () => {
    const candles = strongBullBreak();
    candles.push(candle('99.9', '100', '98.5', '99'));
    const blocks = findOrderBlocks(candles, detectStructureBreaks(candles));
    expect(lastOb(blocks).invalidated).toBe(true);
  });
});

describe('levels calculation', () => {
  const ob: OrderBlock = {
    direction: 'BULLISH',
    index: 8,
    timestamp: 1,
    top: new Decimal('110'),
    bottom: new Decimal('100'),
    breakEvent: {
      kind: 'CHOCH',
      direction: 'BULLISH',
      brokenSwing: { type: 'HIGH', index: 5, timestamp: 1, price: new Decimal('105') },
      candleIndex: 10,
      impulseFactor: new Decimal(4),
    },
    invalidated: false,
  };

  it('sets SL 0.1% below bullish OB low', () => {
    expect(calculateStopLoss(ob, 'BULLISH').toFixed(3)).toBe('99.900');
  });

  it('sets SL 0.1% above bearish OB high', () => {
    expect(calculateStopLoss(ob, 'BEARISH').toFixed(3)).toBe('110.110');
  });

  it('calculates TP strictly as 1:3 RR', () => {
    expect(calculateTakeProfit(new Decimal('100'), new Decimal('90')).toFixed(2)).toBe('130.00');
    expect(calculateTakeProfit(new Decimal('99.9'), new Decimal('99')).toFixed(3)).toBe('102.600');
  });
});

describe('hard SMC rules: impulse boundary', () => {
  function breakWithBody(open: string, close: string, high: string, low: string): Candle[] {
    const candles = baseCandles();
    candles[5] = candle('99.75', '105', '99', '100');
    candles.push(candle(open, high, low, close));
    return candles;
  }

  it('accepts impulse exactly at 2x average body', () => {
    const breaks = detectStructureBreaks(breakWithBody('104.75', '105.25', '105.75', '104.25'));
    expect(breaks).toHaveLength(1);
    expect(breaks[0].impulseFactor.toNumber()).toBe(2);
  });

  it('rejects impulse just below 2x (0.49 vs threshold 0.5)', () => {
    expect(detectStructureBreaks(breakWithBody('104.76', '105.25', '105.75', '104.26'))).toHaveLength(0);
  });
});

describe('hard SMC rules: wicks never count on the low side either', () => {
  it('does NOT count wick below swing low as bearish structure break', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candle('100', '100.5', '100', '100'));
    }
    candles[5] = candle('100', '100.5', '95', '100');
    candles.push(candle('95.4', '96', '94.5', '95.8'));
    expect(detectStructureBreaks(candles)).toHaveLength(0);
  });
});

describe('hard SMC rules: BOS continuation labeling', () => {
  it('labels second aligned break as BOS after initial CHOCH', () => {
    const candles = baseCandles();
    candles[5] = candle('99.75', '105', '99', '100');
    candles[8] = candle('100.4', '100.5', '99.6', '100');
    candles.push(candle('104.5', '106', '104', '105.5'));
    candles.push(candle('105.6', '106.2', '105.1', '105.4'));
    for (let i = 0; i < 3; i++) {
      candles.push(candle('105.05', '105.5', '104.8', '105.3'));
    }
    candles.push(candle('105.4', '107.6', '105.2', '107.4'));

    const breaks = detectStructureBreaks(candles);
    expect(breaks).toHaveLength(2);
    expect(breaks[0].kind).toBe('CHOCH');
    expect(breaks[1].kind).toBe('BOS');
    expect(breaks[1].direction).toBe('BULLISH');
    expect(breaks[1].brokenSwing.price.toNumber()).toBe(106.2);
  });

  it('labels counter-trend break as CHOCH after an established uptrend', () => {
    const candles = baseCandles();
    candles[5] = candle('99.75', '105', '99', '100');
    candles.push(candle('104.5', '106', '104', '105.5'));

    for (let i = 0; i < 3; i++) {
      candles.push(candle('105', '105.4', '104.6', '105'));
    }
    candles.push(candle('105', '105.2', '103', '103.1'));
    for (let i = 0; i < 3; i++) {
      candles.push(candle('103.2', '103.5', '103.05', '103.3'));
    }
    candles.push(candle('103.2', '103.4', '100.5', '100.7'));

    const breaks = detectStructureBreaks(candles);
    expect(breaks).toHaveLength(2);
    const last = breaks[breaks.length - 1];
    expect(last.kind).toBe('CHOCH');
    expect(last.direction).toBe('BEARISH');
    expect(last.brokenSwing.price.toNumber()).toBe(103);
  });
});

describe('hard SMC rules: OB invalidation ignores wicks', () => {
  it('keeps OB valid when only a wick dips below its low but body closes above', () => {
    const candles = strongBullBreak();
    candles.push(candle('100.3', '100.4', '98.9', '100.1'));
    const blocks = findOrderBlocks(candles, detectStructureBreaks(candles));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].invalidated).toBe(false);
  });
});

describe('FVG noise filter boundary', () => {
  it('includes gap exactly at 0.1% of price', () => {
    const first = candle('95', '100', '95', '100');
    const middle = candle('96', '121', '95', '100');
    const third = candle('100.15', '102', '100.1', '101');
    const fvgs = findFVGs([first, middle, third]);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0].top.toFixed(2)).toBe('100.10');
  });

  it('excludes gap below 0.1% when reference price is higher', () => {
    const first = candle('95', '100', '95', '100');
    const middle = candle('96', '121', '95', '1000');
    const third = candle('100.15', '102', '100.1', '1001');
    expect(findFVGs([first, middle, third])).toHaveLength(0);
  });
});
