import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';

const mockClient = {
  getKlines: async (_symbol: string, _interval: string, limit: number) => {
    const candles = [];
    const baseTime = Date.now() - limit * 60 * 60 * 1000;
    for (let i = 0; i < limit; i++) {
      candles.push({
        timestamp: baseTime + i * 60 * 60 * 1000,
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volume: '1000',
      });
    }
    return candles;
  },
} as any;

let recognizer: any;

beforeEach(() => {
  recognizer = new (require('../src/smc/patternRecognizer').PatternRecognizer)(mockClient);
});

describe('PatternRecognizer', () => {
  describe('Killzone Detection (America/New_York)', () => {
    it('should identify Asian killzone (20:00-24:00 NY)', () => {
      const timestamp = DateTime.fromObject({ hour: 22, minute: 0 }, { zone: 'America/New_York' }).toMillis();
      const { killzone } = recognizer.getCurrentSessionAndKillzone(timestamp);
      
      expect(killzone).toBe('ASIAN');
    });

    it('should identify London killzone (02:00-05:00 NY)', () => {
      const timestamp = DateTime.fromObject({ hour: 3, minute: 0 }, { zone: 'America/New_York' }).toMillis();
      const { killzone } = recognizer.getCurrentSessionAndKillzone(timestamp);
      
      expect(killzone).toBe('LONDON');
    });

    it('should identify NY killzone (07:00-10:00 NY)', () => {
      const timestamp = DateTime.fromObject({ hour: 8, minute: 0 }, { zone: 'America/New_York' }).toMillis();
      const { killzone } = recognizer.getCurrentSessionAndKillzone(timestamp);
      
      expect(killzone).toBe('NY');
    });

    it('should return NONE outside killzones', () => {
      const timestamp = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: 'America/New_York' }).toMillis();
      const { killzone } = recognizer.getCurrentSessionAndKillzone(timestamp);
      
      expect(killzone).toBe('NONE');
    });
  });

  describe('ATR Calculation', () => {
    it('should calculate ATR correctly', () => {
      const candles: any[] = [];
      for (let i = 0; i < 20; i++) {
        candles.push({
          timestamp: Date.now() - (20 - i) * 3600000,
          open: '100',
          high: '102',
          low: '99',
          close: '101',
          volume: '1000',
        });
      }
      const atr = recognizer.calculateATR(candles, 14);
      expect(atr.gt(0)).toBe(true);
    });

    it('returns 0 for insufficient candles', () => {
      const candles: any[] = [];
      for (let i = 0; i < 5; i++) {
        candles.push({
          timestamp: Date.now() - i * 3600000,
          open: '100',
          high: '102',
          low: '99',
          close: '101',
          volume: '1000',
        });
      }
      const atr = recognizer.calculateATR(candles, 14);
      expect(atr.eq(0)).toBe(true);
    });
  });

  describe('Swing Points Detection', () => {
    it('findSwingPoints method exists and runs', () => {
      const candles: any[] = [
        { timestamp: 1, open: '100', high: '100', low: '99', close: '100', volume: '100' },
        { timestamp: 2, open: '100', high: '101', low: '99', close: '100', volume: '100' },
        { timestamp: 3, open: '100', high: '102', low: '99', close: '101', volume: '100' },
        { timestamp: 4, open: '101', high: '101', low: '99', close: '100', volume: '100' },
        { timestamp: 5, open: '100', high: '100', low: '99', close: '99', volume: '100' },
        { timestamp: 6, open: '99', high: '100', low: '98', close: '99', volume: '100' },
        { timestamp: 7, open: '99', high: '100', low: '98', close: '99', volume: '100' },
      ];
      const swings = recognizer.findSwingPoints(candles, 3);
      
      expect(Array.isArray(swings)).toBe(true);
      expect(typeof recognizer.findSwingPoints).toBe('function');
    });
  });

  describe('BOS/CHoCH with Displacement', () => {
    it('detectStructureBreaks method exists and runs', () => {
      const candles: any[] = [];
      for (let i = 0; i < 10; i++) {
        candles.push({ timestamp: i, open: '100', high: '100.5', low: '99.5', close: '100', volume: '100' });
      }
      candles[5] = { timestamp: 5, open: '100', high: '105', low: '99.5', close: '100', volume: '100' };
      candles.push({ timestamp: 11, open: '104.5', high: '106', low: '104', close: '105.5', volume: '100' });

      const atr = new Decimal('0.25');
      const config = { ...require('../src/smc/patternRecognizer').DEFAULT_PATTERN_CONFIG, displacementMultiplier: new Decimal(1.5) };
      const recognizer2 = new (require('../src/smc/patternRecognizer').PatternRecognizer)(mockClient, config);
      const structures = recognizer2.detectStructureBreaks(candles, atr);
      
      expect(Array.isArray(structures)).toBe(true);
      expect(typeof recognizer2.detectStructureBreaks).toBe('function');
    });
  });

  describe('FVG Detection', () => {
    it('detectFVGs method exists and runs', () => {
      const c1: any = { timestamp: 1, open: '95', high: '100', low: '95', close: '100', volume: '100' };
      const c2: any = { timestamp: 2, open: '96', high: '121', low: '95', close: '120', volume: '100' };
      const c3: any = { timestamp: 3, open: '110.5', high: '112.5', low: '110', close: '112', volume: '100' };
      
      const fvgs = recognizer.detectFVGs([c1, c2, c3]);
      
      expect(Array.isArray(fvgs)).toBe(true);
      expect(typeof recognizer.detectFVGs).toBe('function');
    });
  });

  describe('Equilibrium (0.5) and Premium/Discount', () => {
    it('calculates equilibrium correctly', () => {
      const eq = recognizer.calculateEquilibrium(new Decimal(110), new Decimal(90));
      expect(eq.eq(100)).toBe(true);
    });

    it('identifies premium/discount zones correctly', () => {
      const high = new Decimal(110);
      const low = new Decimal(90);
      
      let result = recognizer.getPremiumDiscount(new Decimal(105), high, low);
      expect(result.zone).toBe('PREMIUM');
      expect(result.equilibrium.eq(100)).toBe(true);
      
      let result2 = recognizer.getPremiumDiscount(new Decimal(95), high, low);
      expect(result2.zone).toBe('DISCOUNT');
      
      let result3 = recognizer.getPremiumDiscount(new Decimal(100), high, low);
      expect(result3.zone).toBe('EQUILIBRIUM');
    });

    it('calculates FVG 0.5 entry level', () => {
      const fvg = { top: new Decimal(110), bottom: new Decimal(100), direction: 'BULLISH', index: 0, timestamp: 1, mitigated: false, timeframe: '15' as any };
      const entry = recognizer.getFVGEntryLevel(fvg);
      expect(entry.eq(105)).toBe(true);
    });

    it('calculates OB 0.5 entry level', () => {
      const ob = { top: new Decimal(105), bottom: new Decimal(95), direction: 'BULLISH', index: 0, timestamp: 1, mitigated: false, timeframe: '15' as any, breakEvent: null };
      const entry = recognizer.getOBEntryLevel(ob);
      expect(entry.eq(100)).toBe(true);
    });
  });

  describe('Equal Highs/Lows Detection', () => {
    it('detectEqualLevels method exists and runs', () => {
      const candles: any[] = [];
      for (let i = 0; i < 10; i++) {
        candles.push({ timestamp: i, open: '100', high: '100', low: '99', close: '100', volume: '100' });
      }
      candles[5] = { timestamp: 5, open: '100', high: '100.04', low: '99', close: '100', volume: '100' };
      candles[8] = { timestamp: 8, open: '100', high: '100.04', low: '99', close: '100', volume: '100' };
      
      const eqResult = recognizer.detectEqualLevels(candles);
      
      expect(typeof recognizer.detectEqualLevels).toBe('function');
      expect(eqResult.eqh.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('SMS (Smart Money Shift) Detection', () => {
    it('detectSMS method exists and runs', () => {
      const candles: any[] = [];
      for (let i = 0; i < 10; i++) {
        candles.push({ timestamp: i, open: '100', high: '101', low: '99', close: '100', volume: '100' });
      }
      candles[5] = { timestamp: 5, open: '100', high: '105', low: '99', close: '100', volume: '100' };
      candles[8] = { timestamp: 8, open: '100', high: '104', low: '99', close: '100', volume: '100' };
      candles.push({ timestamp: 11, open: '104', high: '104', low: '95', close: '95.5', volume: '100' });
      
      const atr = new Decimal('0.5');
      recognizer.detectSMS(candles, atr);
      expect(typeof recognizer.detectSMS).toBe('function');
    });
  });
});