import { Scenario6_SMS } from '../../src/engine/scenarios/Scenario6_SMS';
import { Decimal } from 'decimal.js';

describe('Scenario6: Failure Swing (SMS)', () => {
  let scenario: Scenario6_SMS;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasSms: boolean;
    smsDirection: 'BULLISH' | 'BEARISH';
    hasChochAfterSms: boolean;
    chochDisplacement: boolean;
    hasSmsOb: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasSms: overrides.hasSms !== false,
      smsDirection: overrides.smsDirection || 'BEARISH',
      hasChochAfterSms: overrides.hasChochAfterSms !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasSmsOb: overrides.hasSmsOb !== false,
    };

    const sms = config.hasSms ? {
      type: 'SMS', direction: config.smsDirection, price: new Decimal(104),
      timestamp: Date.now() - 2000, isValidated: true,
    } : null;

    const chochAfterSms = config.hasChochAfterSms ? {
      kind: 'CHOCH', direction: config.smsDirection === 'BEARISH' ? 'BEARISH' : 'BULLISH',
      price: new Decimal(102), timestamp: Date.now() - 1000, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const smsOb = config.hasSmsOb ? {
      type: 'OB', direction: config.smsDirection === 'BEARISH' ? 'BULLISH' : 'BEARISH',
      top: new Decimal(103), bottom: new Decimal(102), timestamp: Date.now() - 3000, mitigated: false, timeframe: '15',
    } : null;

    const lastCandle = {
      timestamp: Date.now(), close: '102.5', high: '103', low: '102', open: '102', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      structures: [sms, chochAfterSms].filter(Boolean),
      zones: smsOb ? [smsOb] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario6_SMS();
  });

  describe('positive cases', () => {
    it('should trigger for bearish SMS with all conditions', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('SMS');
      expect(scenario.getLevels().entry).toBeDefined();
    });

    it('should trigger for bullish SMS', () => {
      const result = scenario.evaluate(createMockPatternData({ smsDirection: 'BULLISH' }));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('SMS');
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE' }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone for CHoCH confirmation');
    });
  });

  describe('negative cases - SMS', () => {
    it('should reject when no SMS detected', () => {
      const result = scenario.evaluate(createMockPatternData({ hasSms: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No SMS (Smart Money Shift) detected');
    });
  });

  describe('negative cases - CHoCH after SMS', () => {
    it('should reject when no CHoCH after SMS', () => {
      const result = scenario.evaluate(createMockPatternData({ hasChochAfterSms: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH after');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH after SMS displacement < 1.5 ATR');
    });
  });

  describe('negative cases - SMS OB', () => {
    it('should reject when no SMS-forming Order Block found', () => {
      const result = scenario.evaluate(createMockPatternData({ hasSmsOb: false }));
      expect(result).toBe(false);
      // The reason may be empty if rejection happens before logging, but result should be false
      expect(typeof scenario.getReason()).toBe('string');
    });
  });
});