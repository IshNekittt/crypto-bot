import { Scenario11_MitigationBlock } from '../../src/engine/scenarios/Scenario11_MitigationBlock';
import { Decimal } from 'decimal.js';

describe('Scenario11: Mitigation Block', () => {
  let scenario: Scenario11_MitigationBlock;

  /**
   * Creates IDEAL synthetic pattern data for Mitigation Block (Bearish):
   * - SMS (BEARISH): Failed to make higher high, then CHoCH down
   * - CHoCH (BEARISH) after SMS within 8H, with displacement >= 1.5 ATR
   * - Bullish OB before SMS (the one that tried to push higher)
   * - Retest of Mitigation Block (OB zone) within 5 candles after CHoCH
   * - Entry at market on retest candle close
   * - R:R >= 1:3
   */
  const createIdealMitigationBlockPatternData = (overrides: { smsDirection?: 'BULLISH' | 'BEARISH' } = {}) => {
    const smsDirection = overrides.smsDirection || 'BEARISH';
    const FIXED_NOW = 1788675600000; // 2026-09-06 03:00 UTC (London killzone 02:00-05:00 NY)

    // SMS at 3 hours ago
    const sms = {
      type: 'SMS' as const,
      direction: smsDirection,
      price: new Decimal(smsDirection === 'BEARISH' ? 104 : 96),
      timestamp: FIXED_NOW - 3 * 60 * 60 * 1000,
      isValidated: true,
    };

    // CHoCH after SMS (2 hours after SMS = 1 hour ago)
    // Must be opposite direction of SMS
    const expectedChochDirection = smsDirection === 'BEARISH' ? 'BEARISH' : 'BULLISH';
    const chochAfterSms = {
      type: 'CHOCH' as const,
      direction: expectedChochDirection,
      price: new Decimal(smsDirection === 'BEARISH' ? 102 : 98),
      timestamp: FIXED_NOW - 1 * 60 * 60 * 1000, // 1 hour ago (after SMS, within 8H)
      isValidated: true,
      impulseFactor: new Decimal(2.0), // > 1.5
    };

    // Mitigation Block OB: formed BEFORE SMS
    // For BEARISH SMS: last BULLISH OB before SMS
    // For BULLISH SMS: last BEARISH OB before SMS
    const mbDirection = smsDirection === 'BEARISH' ? 'BULLISH' : 'BEARISH';
    const mitigationBlock = {
      type: 'OB' as const,
      direction: mbDirection,
      top: new Decimal(smsDirection === 'BEARISH' ? 103 : 97),
      bottom: new Decimal(smsDirection === 'BEARISH' ? 102 : 96),
      timestamp: FIXED_NOW - 4 * 60 * 60 * 1000, // 4 hours ago (before SMS)
      mitigated: false,
      timeframe: '15',
    };

    // Create candles for retest check (last 5 candles = 75 minutes)
    // Current candle (now) should test the MB zone
    const candles15m: any[] = [];
    for (let i = 0; i < 5; i++) {
      const ts = FIXED_NOW - (4 - i) * 900000;
      candles15m.push({
        timestamp: ts,
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volume: '1000',
      });
    }

    // Current candle (index 4) tests the MB zone
    // For BEARISH: test top=103, bottom=102 -> high >= 102 && close <= 103
    // For BULLISH: test top=97, bottom=96 -> low <= 97 && close >= 96
    if (smsDirection === 'BEARISH') {
      candles15m[4] = {
        timestamp: FIXED_NOW,
        open: '103',
        high: '103.5',
        low: '102',
        close: '102.5',
        volume: '1000',
      };
    } else {
      candles15m[4] = {
        timestamp: FIXED_NOW,
        open: '96.5',
        high: '97.5',
        low: '96',
        close: '97',
        volume: '1000',
      };
    }

    return {
      currentKillzone: 'LONDON' as const,
      currentSession: 'LONDON' as const,
      candles15m,
      structures: [sms, chochAfterSms],
      zones: [mitigationBlock],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario11_MitigationBlock();
  });

  describe('SYNTHETIC TEST - Ideal Bearish Mitigation Block', () => {
    it('should trigger on perfect Bearish MB: SMS + CHoCH + Fresh OB + Retest', () => {
      const result = scenario.evaluate(createIdealMitigationBlockPatternData({ smsDirection: 'BEARISH' }));
      
      if (!result) {
        console.log('REJECTION REASON:', scenario.getReason());
        console.log('LEVELS:', scenario.getLevels());
      }
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Block');
      expect(scenario.getReason()).toContain('BEARISH');
      expect(scenario.getLevels().entry).toBeDefined();
      expect(scenario.getLevels().stopLoss).toBeDefined();
      expect(scenario.getLevels().takeProfit).toBeDefined();
      
      // Entry should be at retest close (~102.5)
      const entry = parseFloat(scenario.getLevels().entry);
      expect(entry).toBeCloseTo(102.5, 0);
      // SL = MB top + 0.5*ATR = 103 + 0.25 = 103.25
      const sl = parseFloat(scenario.getLevels().stopLoss);
      expect(sl).toBeCloseTo(103.25, 1);
      // TP = Entry + (Entry - SL) * 3 = 102.5 + (102.5 - 103.25) * 3 = 102.5 - 2.25 = 100.25
      const tp = parseFloat(scenario.getLevels().takeProfit);
      expect(tp).toBeCloseTo(100.25, 1);
    });
  });

  describe('SYNTHETIC TEST - Ideal Bullish Mitigation Block', () => {
    it('should trigger on perfect Bullish MB: SMS + CHoCH + Fresh OB + Retest', () => {
      const result = scenario.evaluate(createIdealMitigationBlockPatternData({ smsDirection: 'BULLISH' }));
      
      if (!result) {
        console.log('REJECTION REASON:', scenario.getReason());
        console.log('LEVELS:', scenario.getLevels());
      }
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Block');
      expect(scenario.getReason()).toContain('BULLISH');
      expect(scenario.getLevels().entry).toBeDefined();
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const data = createIdealMitigationBlockPatternData();
      (data as any).currentKillzone = 'NONE';
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - SMS', () => {
    it('should reject when no SMS detected', () => {
      const data = createIdealMitigationBlockPatternData();
      data.structures = data.structures.filter(s => s.type !== 'SMS');
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No SMS (Smart Money Shift) detected');
    });
  });

  describe('negative cases - CHoCH after SMS', () => {
    it('should reject when no CHoCH after SMS', () => {
      const data = createIdealMitigationBlockPatternData();
      data.structures = data.structures.filter(s => s.type !== 'CHOCH');
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH after');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const data = createIdealMitigationBlockPatternData();
      data.structures.find(s => s.type === 'CHOCH')!.impulseFactor = new Decimal(1.0);
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH after SMS displacement < 1.5 ATR');
    });

    it('should reject when CHoCH more than 8H after SMS', () => {
      const data = createIdealMitigationBlockPatternData();
      // Move CHoCH to 10 hours after SMS
      const choch = data.structures.find(s => s.type === 'CHOCH')!;
      const sms = data.structures.find(s => s.type === 'SMS')!;
      choch.timestamp = sms.timestamp + 10 * 60 * 60 * 1000;
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH after');
    });
  });

  describe('negative cases - Mitigation Block OB', () => {
    it('should reject when no OB before SMS', () => {
      const data = createIdealMitigationBlockPatternData();
      data.zones = [];
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      // When zones is empty, early return without logging reason
      expect(scenario.getReason()).toBe('');
    });

    it('should reject when OB is after SMS (not before)', () => {
      const data = createIdealMitigationBlockPatternData();
      // Move OB to after SMS
      data.zones[0].timestamp = data.structures.find(s => s.type === 'SMS')!.timestamp + 3600000;
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('Mitigation Block OB found before SMS');
    });
  });

  describe('negative cases - Retest', () => {
    it('should reject when price not testing MB zone in last 5 candles', () => {
      const data = createIdealMitigationBlockPatternData();
      // Make all candles not test the MB zone
      data.candles15m.forEach(c => {
        c.high = '100';
        c.low = '100';
        c.close = '100';
      });
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Price not testing Mitigation Block zone on retest in last 5 candles');
    });

    it('should reject when retest candle is before or at CHoCH candle', () => {
      const data = createIdealMitigationBlockPatternData();
      // Move retest candle to same time as CHoCH
      data.candles15m[4].timestamp = data.structures.find(s => s.type === 'CHOCH')!.timestamp;
      const result = scenario.evaluate(data);
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('Mitigation Block zone on retest');
    });
  });
});